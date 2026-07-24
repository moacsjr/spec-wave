// Checklist de preflight do spec-wave: diagnostica token, escopos, conta ativa
// do gh, .spec-wave.json, acesso ao repo, configuração de IA e workflows.
// Best-effort: NUNCA lança — falha de rede/API vira "!" (não verificável);
// só problemas confirmados viram "✗". Sai com exit 1 se houver algum "✗".
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Octokit } from '@octokit/rest';
import { resolveToken, verifyTokenScopes } from '../api/auth.mjs';
import { getProjectSnapshot } from '../api/github-graphql.mjs';
import { CONFIG_FILE, WORKFLOW_FILES, getProvider, DEFAULT_PROVIDER } from '../config.mjs';

// Mesmo padrão de instanciação de github-rest.mjs, mas com o logger mudo:
// aqui 404/403 são resultados esperados dos checks, não erros a logar.
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
function makeOctokit(token) {
  return new Octokit({ auth: token, log: silentLog });
}

/**
 * Formata o relatório do doctor (função PURA — testável sem rede).
 *
 * @param {Array<{name: string, status: 'ok'|'fail'|'warn', detail?: string}>} results
 * @returns {string} relatório com ✓ (ok, verde), ✗ (problema, vermelho) e
 *          ! (não verificável, amarelo); detail é indentado sob o nome.
 */
export function renderDoctorReport(results) {
  const SYMBOLS = {
    ok: chalk.green('✓'),
    fail: chalk.red('✗'),
    warn: chalk.yellow('!'),
  };
  const lines = [];
  for (const r of results || []) {
    lines.push(`${SYMBOLS[r.status] || SYMBOLS.warn} ${chalk.bold(r.name)}`);
    if (r.detail) {
      for (const dl of String(r.detail).split('\n')) {
        lines.push(`  ${chalk.dim(dl)}`);
      }
    }
  }
  return lines.join('\n');
}

// ── Checks ──────────────────────────────────────────────────────────────────
// Cada check recebe o contexto compartilhado (ctx) e retorna
// { name, status, detail }. Resultados de checks anteriores (token, config,
// acesso ao repo) ficam no ctx para os seguintes reaproveitarem.

async function checkToken(ctx) {
  const name = 'Token GitHub';
  let source = 'gh CLI (`gh auth token`)';
  if (process.env.GITHUB_TOKEN) source = 'variável de ambiente GITHUB_TOKEN';
  else if (process.env.GH_TOKEN) source = 'variável de ambiente GH_TOKEN';
  try {
    ctx.token = await resolveToken();
    return { name, status: 'ok', detail: `Token resolvido via ${source}.` };
  } catch {
    return {
      name,
      status: 'fail',
      detail:
        'Nenhum token encontrado. Rode `gh auth login` ou exporte GITHUB_TOKEN.',
    };
  }
}

async function checkScopes(ctx) {
  const name = 'Escopos do token';
  if (!ctx.token) {
    return { name, status: 'warn', detail: 'Sem token — verificação de escopos pulada.' };
  }
  let info;
  try {
    info = await verifyTokenScopes(ctx.token);
  } catch (err) {
    return { name, status: 'warn', detail: `Não foi possível consultar a API (GET /user): ${err.message}` };
  }
  ctx.tokenLogin = info.login;

  const realScopes = (info.scopes || []).filter(Boolean);
  if (realScopes.length > 0) {
    // PAT clássico: o header x-oauth-scopes lista os escopos.
    const missing = [];
    if (!info.hasRepo) missing.push('repo');
    if (!info.hasProject) missing.push('project');
    if (!info.hasWorkflow) missing.push('workflow');
    if (missing.length > 0) {
      return {
        name,
        status: 'fail',
        detail:
          `Login: ${info.login}. Escopos: ${realScopes.join(', ')}.\n` +
          `Faltando: ${missing.join(', ')}. Rode \`gh auth refresh --scopes ${missing.join(',')}\`.`,
      };
    }
    return { name, status: 'ok', detail: `Login: ${info.login}. Escopos: ${realScopes.join(', ')}.` };
  }

  // Header vazio/ausente: fine-grained PAT ou GITHUB_TOKEN de Actions — os
  // escopos não são legíveis. Degrada para checks funcionais (repo + project).
  const { cfg } = ctx;
  const functional = [];
  if (cfg?.owner && cfg?.repo) {
    try {
      await makeOctokit(ctx.token).rest.repos.get({ owner: cfg.owner, repo: cfg.repo });
      ctx.repoAccess = 'ok';
      functional.push(`repo ${cfg.owner}/${cfg.repo}`);
    } catch (err) {
      ctx.repoAccess = err.status === 404 ? '404' : 'error';
    }
  }
  if (cfg?.project?.id) {
    try {
      const snapshot = await getProjectSnapshot(ctx.token, cfg.project.id);
      if (snapshot) {
        ctx.projectSnapshot = snapshot;
        functional.push(`project "${snapshot.title}"`);
      }
    } catch {
      // acesso ao project não confirmado — segue sem ele
    }
  }
  if (functional.length > 0) {
    return {
      name,
      status: 'ok',
      detail: `Escopos não legíveis (fine-grained PAT?), mas acesso confirmado: ${functional.join(' e ')}.`,
    };
  }
  return {
    name,
    status: 'warn',
    detail:
      'Escopos não legíveis (fine-grained PAT?) e sem acesso confirmável a repo/project ' +
      `(${CONFIG_FILE} ausente ou acesso negado). Confirme as permissões do token manualmente.`,
  };
}

async function checkGhAccount(ctx) {
  const name = 'Conta ativa do gh';
  let out;
  try {
    out = execSync('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  } catch {
    return { name, status: 'warn', detail: 'gh não instalado ou não logado — verificação de conta pulada.' };
  }

  // Formato: "✓ Logged in to github.com account <login> (...)" seguido de
  // "- Active account: true". Em versões antigas (uma conta só) não há a
  // linha "Active account" — usa a primeira conta encontrada.
  let active = null;
  let last = null;
  for (const line of out.split('\n')) {
    const m = line.match(/account\s+(\S+)/);
    if (m) {
      last = m[1];
      if (!active) active = last;
    }
    if (/Active account:\s*true/i.test(line) && last) active = last;
  }
  if (!active) {
    return { name, status: 'warn', detail: 'Não foi possível identificar a conta ativa na saída de `gh auth status`.' };
  }
  ctx.ghLogin = active;

  const owner = ctx.cfg?.owner;
  if (!owner) {
    return { name, status: 'ok', detail: `Conta ativa: ${active} (sem owner no ${CONFIG_FILE} para comparar).` };
  }
  if (active.toLowerCase() === owner.toLowerCase()) {
    return { name, status: 'ok', detail: `Conta ativa: ${active} — coincide com o owner ${owner}.` };
  }
  // Conta ativa ≠ owner (caso real: moacsjr ativo com repo da org de moacir-k9).
  // Se o owner for uma org, tenta confirmar membership com o token resolvido.
  if (ctx.token) {
    try {
      const res = await makeOctokit(ctx.token).request('GET /user/memberships/orgs/{org}', { org: owner });
      if (res.data?.state === 'active') {
        return {
          name,
          status: 'ok',
          detail: `Conta ativa ${active} ≠ owner ${owner}, mas o usuário do token é membro ativo da org ${owner}.`,
        };
      }
    } catch {
      // owner não é org, ou membership não consultável — cai no warn abaixo
    }
  }
  return {
    name,
    status: 'warn',
    detail: `Conta ativa ${active} ≠ owner ${owner} — confirme que ${active} tem acesso a ${owner}.`,
  };
}

async function checkConfig(ctx) {
  const name = `Configuração (${CONFIG_FILE})`;
  if (!existsSync(ctx.configPath)) {
    return {
      name,
      status: 'fail',
      detail: `${CONFIG_FILE} não encontrado em ${ctx.cwd}. Rode \`npx @spec-wave/cli init\`.`,
    };
  }
  if (ctx.cfgError) {
    return { name, status: 'fail', detail: `${CONFIG_FILE} existe mas está corrompido: ${ctx.cfgError}` };
  }
  const { cfg } = ctx;
  const notes = [`Repositório: ${cfg.owner ?? '?'}/${cfg.repo ?? '?'}.`];

  const fields = cfg.project?.fields || {};
  const missingFields = ['Etapa', 'Status'].filter((f) => !fields[f]);
  if (missingFields.length > 0) {
    return {
      name,
      status: 'warn',
      detail:
        notes.join('\n') +
        `\nproject.fields sem ${missingFields.map((f) => `"${f}"`).join(' e ')} — rode \`npx @spec-wave/cli refresh\`.`,
    };
  }

  // Com token e project.id, confere se as opções de Etapa do config ainda
  // existem no project real (alguém pode ter renomeado/apagado colunas).
  if (ctx.token && cfg.project?.id) {
    try {
      const snapshot = ctx.projectSnapshot || await getProjectSnapshot(ctx.token, cfg.project.id);
      if (!snapshot) {
        return { name, status: 'warn', detail: notes.join('\n') + '\nProject do config não encontrado no GitHub (id inválido ou sem acesso).' };
      }
      ctx.projectSnapshot = snapshot;
      const realEtapa = snapshot.fields?.['Etapa']?.options || {};
      const diverged = Object.keys(fields['Etapa'].options || {}).filter((opt) => !(opt in realEtapa));
      if (diverged.length > 0) {
        return {
          name,
          status: 'warn',
          detail:
            notes.join('\n') +
            `\nOpções de Etapa do config ausentes no project real: ${diverged.join(', ')} — rode \`npx @spec-wave/cli refresh\`.`,
        };
      }
      notes.push(`Project "${snapshot.title}" verificado — campos Etapa/Status em sincronia.`);
    } catch (err) {
      return { name, status: 'warn', detail: notes.join('\n') + `\nProject não verificável agora: ${err.message}` };
    }
  } else {
    notes.push('Campos Etapa/Status presentes no config (project real não verificado — sem token ou sem project.id).');
  }
  return { name, status: 'ok', detail: notes.join('\n') };
}

async function checkRepoAccess(ctx) {
  const name = 'Acesso ao repositório';
  const { cfg } = ctx;
  if (!ctx.token) {
    return { name, status: 'warn', detail: 'Sem token — acesso ao repositório não verificável.' };
  }
  if (!cfg?.owner || !cfg?.repo) {
    return { name, status: 'warn', detail: `Sem owner/repo no ${CONFIG_FILE} — acesso não verificável.` };
  }
  // Reaproveita o resultado do check funcional de escopos, se já rodou.
  if (ctx.repoAccess === 'ok') {
    return { name, status: 'ok', detail: `Token enxerga ${cfg.owner}/${cfg.repo} (já confirmado no check de escopos).` };
  }
  try {
    const res = await makeOctokit(ctx.token).rest.repos.get({ owner: cfg.owner, repo: cfg.repo });
    return {
      name,
      status: 'ok',
      detail: `Token enxerga ${res.data.full_name} (${res.data.private ? 'privado' : 'público'}).`,
    };
  } catch (err) {
    if (err.status === 404 || ctx.repoAccess === '404') {
      return {
        name,
        status: 'fail',
        detail:
          `Token não enxerga ${cfg.owner}/${cfg.repo} (404) — causa típica do erro silencioso na criação de issues.\n` +
          'Verifique se o token tem acesso à org/repo (SSO autorizado, fine-grained com o repo selecionado).',
      };
    }
    return { name, status: 'warn', detail: `Acesso não verificável agora: ${err.message}` };
  }
}

async function checkAi(ctx) {
  const name = 'IA (provider, modelo e chaves)';
  const { cfg } = ctx;
  const fileAi = cfg?.ai || {};
  const provider = getProvider(fileAi.provider) || getProvider(DEFAULT_PROVIDER);
  const model = fileAi.model || provider.defaultModel;
  const notes = [`Provider: ${provider.value} · modelo: ${model}${fileAi.provider ? '' : ' (default — sem bloco `ai` no config)'}.`];
  if (fileAi.models && Object.keys(fileAi.models).length > 0) {
    notes.push(`Modelos por ação (ai.models): ${Object.entries(fileAi.models).map(([a, m]) => `${a}=${m}`).join(', ')}.`);
  }

  let status = 'ok';
  if (process.env[provider.secret]) {
    notes.push(`${provider.secret} presente no ambiente local.`);
  } else {
    status = 'warn';
    notes.push(`${provider.secret} ausente no ambiente local — necessária apenas para rodar geração localmente; nos Actions vem dos secrets.`);
  }

  // Se o token permitir, confere os secrets do Actions no repo.
  if (ctx.token && cfg?.owner && cfg?.repo) {
    try {
      const res = await makeOctokit(ctx.token).request('GET /repos/{owner}/{repo}/actions/secrets', {
        owner: cfg.owner,
        repo: cfg.repo,
      });
      const secretNames = (res.data.secrets || []).map((s) => s.name);
      const required = [provider.secret, 'GH_PROJECT_TOKEN'];
      const missing = required.filter((s) => !secretNames.includes(s));
      if (missing.length > 0) {
        status = 'warn';
        notes.push(`Secrets do Actions faltando em ${cfg.owner}/${cfg.repo}: ${missing.join(', ')} — configure em Settings → Secrets.`);
      } else {
        notes.push(`Secrets do Actions presentes: ${required.join(', ')}.`);
      }
    } catch (err) {
      if (err.status === 403) {
        notes.push('Secrets do Actions não verificáveis com este token (403 — requer admin no repo).');
      } else {
        notes.push(`Secrets do Actions não verificáveis agora: ${err.message}`);
      }
    }
  }
  return { name, status, detail: notes.join('\n') };
}

async function checkWorkflows(ctx) {
  const name = 'Workflows do Actions';
  const dir = path.join(ctx.cwd, '.github', 'workflows');
  if (!existsSync(dir)) {
    return {
      name,
      status: 'warn',
      detail: '.github/workflows/ não encontrado — rode `npx @spec-wave/cli init` (ou `update`) para instalar os workflows.',
    };
  }
  const present = readdirSync(dir);
  const missing = WORKFLOW_FILES.filter((f) => !present.includes(f));
  if (missing.length > 0) {
    return {
      name,
      status: 'warn',
      detail: `Workflows faltando em .github/workflows/: ${missing.join(', ')} — rode \`npx @spec-wave/cli update\`.`,
    };
  }
  return { name, status: 'ok', detail: `Os ${WORKFLOW_FILES.length} workflows do spec-wave estão presentes.` };
}

// ── Comando ─────────────────────────────────────────────────────────────────

export async function doctor() {
  p.intro(chalk.bold('spec-wave doctor'));

  // Contexto compartilhado entre os checks (token, config, resultados parciais).
  const ctx = { cwd: process.cwd() };
  ctx.configPath = path.join(ctx.cwd, CONFIG_FILE);
  ctx.cfg = null;
  ctx.cfgError = null;
  try {
    if (existsSync(ctx.configPath)) {
      ctx.cfg = JSON.parse(readFileSync(ctx.configPath, 'utf-8'));
    }
  } catch (err) {
    ctx.cfgError = err.message;
  }

  const checks = [
    checkToken,
    checkScopes,
    checkGhAccount,
    checkConfig,
    checkRepoAccess,
    checkAi,
    checkWorkflows,
  ];
  const results = [];
  const spinner = p.spinner();
  spinner.start('Rodando checks de preflight...');
  for (const check of checks) {
    try {
      results.push(await check(ctx));
    } catch (err) {
      // Best-effort: nenhum check derruba o doctor — vira "não verificável".
      results.push({
        name: check.name.replace(/^check/, ''),
        status: 'warn',
        detail: `Check falhou inesperadamente: ${err.message}`,
      });
    }
  }
  spinner.stop('Checks concluídos.');

  console.log('\n' + renderDoctorReport(results) + '\n');

  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  if (fails > 0) {
    p.outro(chalk.red(`${fails} problema(s) encontrado(s)`) + (warns > 0 ? chalk.yellow(` e ${warns} aviso(s)`) : '') + '. Corrija os itens ✗ acima.');
    process.exit(1);
  }
  if (warns > 0) {
    p.outro(chalk.yellow(`Nenhum problema bloqueante; ${warns} aviso(s) não verificável(is).`));
    return;
  }
  p.outro(chalk.green('Tudo certo! Ambiente pronto para o spec-wave.'));
}
