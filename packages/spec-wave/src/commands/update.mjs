import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { CONFIG_FILE, WORKFLOW_FILES, ISSUE_TEMPLATE_FILES, ALL_LABELS } from '../config.mjs';
import { getProjectSnapshot } from '../api/github-graphql.mjs';
import {
  getFileContent, upsertFile, listLabels, createLabel, updateLabel,
} from '../api/github-rest.mjs';
import {
  TARGETS, SKILL_SOURCE, CLI_VERSION, parseSkill, renderContent,
  mergeAgentsFile, resolveDest, isDetected, extractAgentsBlock,
} from './install-skill.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dir, '..', 'templates');
function readTemplate(...parts) {
  return readFileSync(path.join(TEMPLATES_DIR, ...parts), 'utf-8');
}

// Arquivos do repo gerenciados pela CLI (comparados com o template empacotado).
const REPO_FILES = [
  ...WORKFLOW_FILES.map(f => ({ repoPath: `.github/workflows/${f}`, template: ['workflows', f] })),
  ...ISSUE_TEMPLATE_FILES.map(f => ({ repoPath: `.github/ISSUE_TEMPLATE/${f}`, template: ['issue', f] })),
];

// Detecta se a skill instalada em cada agente diverge da versão atual da CLI.
// Retorna os alvos desatualizados (conteúdo diferente ou ausente).
function detectSkill(parsed, baseDir, isGlobal) {
  const jobs = [];
  for (const target of TARGETS) {
    if (!isDetected(target, baseDir)) continue;
    const dest = resolveDest(target, baseDir, isGlobal);
    if (!dest) continue;
    const desired = renderContent(dest.format, parsed, CLI_VERSION);
    const existing = existsSync(dest.path) ? readFileSync(dest.path, 'utf-8') : null;
    let reason = null;
    if (existing === null) {
      reason = 'ausente';
    } else if (dest.format === 'agents') {
      const block = extractAgentsBlock(existing);
      if (block === null) reason = 'bloco ausente';
      else if (block.trim() !== desired.trim()) reason = 'desatualizada';
    } else if (existing !== desired) {
      reason = 'desatualizada';
    }
    if (reason) jobs.push({ target, dest, desired, reason });
  }
  return jobs;
}

// Aplica a atualização de uma skill (grava o arquivo / faz merge no AGENTS.md).
function applySkill(job) {
  const content = job.dest.format === 'agents'
    ? mergeAgentsFile(job.dest.path, job.desired)
    : job.desired;
  mkdirSync(path.dirname(job.dest.path), { recursive: true });
  writeFileSync(job.dest.path, content, 'utf-8');
}

// Compara ALL_LABELS com as labels do repo. color no config é hex maiúsculo; a
// API retorna minúsculo — daí o toLowerCase() na comparação.
function diffLabels(existing) {
  const byName = new Map(existing.map(l => [l.name, l]));
  const missing = [];
  const changed = [];
  for (const label of ALL_LABELS) {
    const cur = byName.get(label.name);
    if (!cur) {
      missing.push(label);
    } else if (
      cur.color.toLowerCase() !== label.color.toLowerCase() ||
      (cur.description || '') !== (label.description || '')
    ) {
      changed.push(label);
    }
  }
  return { missing, changed };
}

export async function update(options = {}) {
  p.intro(chalk.bold(`spec-wave update (CLI v${CLI_VERSION})`));

  const isGlobal = !!options.global;
  const baseDir = isGlobal ? homedir() : process.cwd();

  // ---------- Detecção ----------
  // 1) Skill (por agente detectado).
  const parsed = parseSkill(readFileSync(SKILL_SOURCE, 'utf-8'));
  const skillJobs = options.skipSkill ? [] : detectSkill(parsed, baseDir, isGlobal);

  // 2) Config + repo dependem do .spec-wave.json local do repo atual.
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  let config = null;
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
      p.log.warn(`${CONFIG_FILE} corrompido (${err.message}); pulando config/repo.`);
    }
  }

  const doConfig = !options.skipConfig && !!config;
  const doRepo = !options.skipRepo && !!config?.owner && !!config?.repo;

  // Token resolvido sob demanda (necessário só para repo/config remoto).
  let token;
  let tokenError;
  async function getToken() {
    if (token || tokenError) return token;
    try {
      token = await resolveToken();
    } catch (err) {
      tokenError = err;
    }
    return token;
  }

  // 2a) Config desatualizado? (versão divergente ou formato legado).
  let configStale = null;
  if (doConfig) {
    const legacy = !config.project?.fields;
    if (config.version !== CLI_VERSION || legacy) {
      configStale = {
        reason: legacy ? 'formato legado (sem project.fields)' : `versão ${config.version ?? '?'} ≠ ${CLI_VERSION}`,
        canApply: !!config.project?.id,
      };
    }
  }

  // 2b) Arquivos do repo e labels divergentes (exige token + rede).
  let repoFiles = [];
  let labelDiff = { missing: [], changed: [] };
  let repoChecked = false;
  if (doRepo) {
    const s = p.spinner();
    s.start('Comparando arquivos e labels do repositório...');
    const tk = await getToken();
    if (!tk) {
      s.stop('');
      p.log.warn(`Sem token do GitHub (${tokenError?.message ?? 'indisponível'}); pulando verificação do repo.`);
    } else {
      const { owner, repo } = config;
      try {
        for (const f of REPO_FILES) {
          const remote = await getFileContent(tk, owner, repo, f.repoPath);
          const local = readTemplate(...f.template);
          if (remote === null) repoFiles.push({ ...f, reason: 'ausente', local });
          else if (remote !== local) repoFiles.push({ ...f, reason: 'desatualizado', local });
        }
        labelDiff = diffLabels(await listLabels(tk, owner, repo));
        repoChecked = true;
        s.stop('Repositório comparado.');
      } catch (err) {
        s.stop('');
        p.log.warn(`Falha ao comparar o repo: ${err.message}`);
      }
    }
  }

  // ---------- Resumo ----------
  const labelTotal = labelDiff.missing.length + labelDiff.changed.length;
  const total = skillJobs.length + (configStale ? 1 : 0) + repoFiles.length + labelTotal;

  if (total === 0) {
    p.log.success('Tudo já está atualizado para a versão atual da CLI.');
    p.outro('Nada a fazer.');
    return;
  }

  const lines = [];
  if (skillJobs.length) {
    lines.push(chalk.bold('Skill:'));
    for (const j of skillJobs) lines.push(`  ${chalk.yellow('↻')} ${j.target.name} (${j.reason})\n     ${chalk.dim(j.dest.path)}`);
  }
  if (configStale) {
    lines.push(chalk.bold('Config local:'));
    lines.push(`  ${chalk.yellow('↻')} ${CONFIG_FILE} — ${configStale.reason}` +
      (configStale.canApply ? '' : chalk.dim(' (sem project.id — rode `init` sem --skip-project)')));
  }
  if (repoFiles.length) {
    lines.push(chalk.bold('Arquivos do repo:'));
    for (const f of repoFiles) lines.push(`  ${chalk.yellow('↻')} ${f.repoPath} (${f.reason})`);
  }
  if (labelTotal) {
    lines.push(chalk.bold('Labels:'));
    if (labelDiff.missing.length) lines.push(`  ${chalk.yellow('+')} criar: ${labelDiff.missing.map(l => l.name).join(', ')}`);
    if (labelDiff.changed.length) lines.push(`  ${chalk.yellow('↻')} atualizar: ${labelDiff.changed.map(l => l.name).join(', ')}`);
  }
  p.note(lines.join('\n'), `${total} item(ns) desatualizado(s)`);

  if (options.dryRun) {
    p.outro('Dry-run: nada foi alterado.');
    return;
  }

  if (!options.yes) {
    const ok = await p.confirm({ message: `Aplicar as ${total} atualização(ões)?`, initialValue: true });
    if (p.isCancel(ok) || !ok) {
      p.cancel('Update cancelado.');
      return;
    }
  }

  // ---------- Aplicação ----------
  // Skill
  for (const job of skillJobs) {
    try {
      applySkill(job);
      p.log.success(`Skill atualizada: ${job.target.name}`);
    } catch (err) {
      p.log.error(`Falha ao atualizar skill (${job.target.name}): ${err.message}`);
    }
  }

  // Config (.spec-wave.json) — reconsulta o Project e reescreve local.
  if (configStale) {
    if (!configStale.canApply) {
      p.log.warn(`${CONFIG_FILE}: sem project.id — pulei. Rode \`npx @spec-wave/cli init\` (sem --skip-project).`);
    } else {
      const tk = await getToken();
      if (!tk) {
        p.log.warn(`${CONFIG_FILE}: sem token — pulei. (${tokenError?.message ?? ''})`);
      } else {
        const s = p.spinner();
        s.start('Atualizando .spec-wave.json...');
        try {
          const snapshot = await getProjectSnapshot(tk, config.project.id);
          if (!snapshot) throw new Error('Project não encontrado');
          const { etapaFieldId: _e, stageOptions: _s, ...projectRest } = config.project;
          const updated = {
            ...config,
            version: CLI_VERSION,
            project: {
              ...projectRest,
              title: snapshot.title,
              url: snapshot.url,
              id: snapshot.id,
              number: snapshot.number,
              fields: snapshot.fields,
            },
            refreshedAt: new Date().toISOString(),
          };
          writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n');
          s.stop(`${CONFIG_FILE} atualizado (v${CLI_VERSION}).`);
        } catch (err) {
          s.stop('');
          p.log.error(`Falha ao atualizar ${CONFIG_FILE}: ${err.message}`);
        }
      }
    }
  }

  // Arquivos do repo
  if (repoFiles.length) {
    const tk = await getToken();
    const { owner, repo } = config;
    for (const f of repoFiles) {
      try {
        await upsertFile(tk, owner, repo, f.repoPath, f.local, `chore: update ${path.basename(f.repoPath)} [spec-wave]`);
        p.log.success(`Arquivo atualizado no repo: ${f.repoPath}`);
      } catch (err) {
        p.log.error(`Falha ao atualizar ${f.repoPath}: ${err.message}`);
      }
    }
  }

  // Labels
  if (labelTotal) {
    const tk = await getToken();
    const { owner, repo } = config;
    for (const label of labelDiff.missing) {
      try {
        await createLabel(tk, owner, repo, label);
        p.log.success(`Label criada: ${label.name}`);
      } catch (err) {
        p.log.error(`Falha ao criar label ${label.name}: ${err.message}`);
      }
    }
    for (const label of labelDiff.changed) {
      try {
        await updateLabel(tk, owner, repo, label);
        p.log.success(`Label atualizada: ${label.name}`);
      } catch (err) {
        p.log.error(`Falha ao atualizar label ${label.name}: ${err.message}`);
      }
    }
  }

  const committedRepo = repoFiles.length > 0;
  p.outro(
    'Update concluído.' +
    (skillJobs.length ? ' Recarregue o agente para pegar a skill nova.' : '') +
    (configStale?.canApply ? ` Faça commit do ${CONFIG_FILE}.` : '') +
    (committedRepo ? ' Arquivos do repo foram commitados no remoto.' : '')
  );
}
