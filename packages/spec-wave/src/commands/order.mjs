// Ordena as Stories de uma Feature pelas dependências (topológica, Kahn —
// ver orderStories em src/lib/dependencies.mjs). As dependências vêm de duas
// fontes, mescladas: a linha "Depende de: #N" no corpo da Story e a relação
// nativa blocked_by do GitHub.
//
// Comando LOCAL — rodado pelo dev no terminal. owner/repo vêm da env
// GITHUB_REPOSITORY quando existir, senão do .spec-wave.json (gravado pelo init).
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, listBlockedBy } from '../api/github-rest.mjs';
import { addProjectItem, listSubIssues, getItemSingleSelectValue } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { parseDependencies, orderStories } from '../lib/dependencies.mjs';
import { loadProjectConfig, resolveField } from '../lib/board.mjs';
import { CONFIG_FILE, STAGE_ORDER, STAGE_DEVELOPMENT, STAGE_DONE } from '../config.mjs';

// Resolve owner/repo: env GITHUB_REPOSITORY (padrão dos comandos de Action) com
// fallback no .spec-wave.json — comandos locais rodam sem essa env.
function resolveRepoContext() {
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  let cfg = {};
  const cfgPath = path.join(process.cwd(), CONFIG_FILE);
  try { if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch {}
  return { owner: envOwner || cfg.owner, repo: envRepo || cfg.repo };
}

export async function order({ feature: featureArg }) {
  const featureNumber = parseInt(String(featureArg).replace('#', ''), 10);
  if (!Number.isInteger(featureNumber) || featureNumber <= 0) {
    p.log.error(`Feature inválida: "${featureArg}". Use o número da issue, ex.: 12 ou #12.`);
    process.exitCode = 1;
    return;
  }

  const { owner, repo } = resolveRepoContext();
  if (!owner || !repo) {
    p.log.error(
      'Não foi possível determinar owner/repo.\n' +
      `Rode dentro de um repositório com ${CONFIG_FILE} (\`spec-wave init\`) ou defina GITHUB_REPOSITORY=owner/repo.`
    );
    process.exitCode = 1;
    return;
  }

  let token;
  try {
    token = await resolveToken();
  } catch (err) {
    p.log.error(err.message);
    process.exitCode = 1;
    return;
  }

  p.intro(chalk.bold(`spec-wave order #${featureNumber}`));

  // 1. Lê a Feature e valida o tipo.
  let featureIssue;
  try {
    featureIssue = await getIssue(token, owner, repo, featureNumber);
  } catch (err) {
    p.log.error(`Não foi possível ler a issue #${featureNumber}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const type = detectIssueType(featureIssue);
  if (type !== 'Feature') {
    p.log.error(
      `\`spec-wave order\` só aceita issues do tipo Feature. ` +
      `Issue #${featureNumber} é do tipo ${type || 'desconhecido'} (${featureIssue.title}).`
    );
    process.exitCode = 1;
    return;
  }

  // 2. Sub-issues da Feature → só as Stories entram na ordenação.
  let subs;
  try {
    subs = await listSubIssues(token, featureIssue.node_id);
  } catch (err) {
    p.log.error(`Não foi possível listar as sub-issues da Feature #${featureNumber}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const stories = subs.filter(s => detectIssueType({ title: s.title, labels: s.labels }) === 'Story');
  if (stories.length === 0) {
    p.log.info(`Feature #${featureNumber} não tem Stories (sub-issues) — nada a ordenar. Rode \`spec-wave decompose\` antes.`);
    p.outro('Nada a fazer.');
    return;
  }

  // 3. Dependências de cada Story: linha "Depende de: #N" do corpo (buscando o
  // corpo via getIssue quando listSubIssues não o trouxer) mesclada com a
  // relação nativa blocked_by (falha na API → sem bloqueios, não interrompe).
  const enriched = await Promise.all(stories.map(async (s) => {
    let body = s.body;
    if (!body) {
      body = (await getIssue(token, owner, repo, s.number).catch(() => null))?.body || '';
    }
    const fromBody = parseDependencies(body);
    const fromBlockedBy = (await listBlockedBy(token, owner, repo, s.number).catch(() => []))
      .map(b => b.number);
    const dependsOn = [...new Set([...fromBody, ...fromBlockedBy])];
    return { number: s.number, title: s.title, nodeId: s.nodeId, dependsOn };
  }));

  // 4. Etapa atual de cada Story no board (falha em qualquer leitura → '—').
  const stageOf = new Map();
  const { project, error: projectError } = loadProjectConfig();
  if (projectError) {
    p.log.warn(`${projectError} — Etapas do board não consultadas.`);
  } else {
    const etapaField = await resolveField(token, project, 'Etapa').catch(() => null);
    if (etapaField?.id) {
      await Promise.all(enriched.map(async (s) => {
        try {
          const itemId = await addProjectItem(token, project.id, s.nodeId);
          stageOf.set(s.number, await getItemSingleSelectValue(token, itemId, etapaField.id));
        } catch {
          stageOf.set(s.number, null);
        }
      }));
    }
  }

  // 5. Ordenação topológica (nunca lança; ciclo vem em `cycle`).
  const byNumber = new Map(enriched.map(s => [s.number, s]));
  const { order: sorted, cycle } = orderStories(enriched.map(({ number, dependsOn }) => ({ number, dependsOn })));

  if (cycle.length > 0) {
    p.log.warn(
      chalk.yellow.bold('⚠ CICLO DE DEPENDÊNCIAS detectado!') + '\n' +
      `Stories envolvidas (ou bloqueadas pelo ciclo): ${cycle.map(n => `#${n}`).join(', ')}.\n` +
      'Elas ficaram fora da ordem abaixo — corrija as linhas "Depende de" (ou as relações blocked_by) dessas issues.'
    );
  }

  const line = (n, i) => {
    const s = byNumber.get(n);
    const stage = stageOf.get(n) || '—';
    const deps = s.dependsOn.length > 0
      ? `  ${chalk.dim(`← depende de ${s.dependsOn.map(d => `#${d}`).join(', ')}`)}`
      : '';
    return `${String(i + 1).padStart(2)}. #${n} ${s.title}\n    Etapa: ${stage}${deps}`;
  };
  p.note(sorted.map(line).join('\n'), `Ordem de execução das Stories da Feature #${featureNumber}`);

  // 6. Aviso final: dependente já em Desenvolvimento+ com dependência não-Done.
  const devIdx = STAGE_ORDER.indexOf(STAGE_DEVELOPMENT);
  const outOfOrder = [];
  for (const s of enriched) {
    const stage = stageOf.get(s.number);
    const idx = stage ? STAGE_ORDER.indexOf(stage) : -1;
    if (idx === -1 || idx < devIdx) continue; // ainda não chegou em Desenvolvimento
    for (const d of s.dependsOn) {
      if (!byNumber.has(d)) continue; // dependência externa ao conjunto — sem Etapa conhecida
      const depStage = stageOf.get(d);
      if (depStage !== STAGE_DONE) {
        outOfOrder.push(
          `#${s.number} já está em "${stage}", mas depende de #${d} (Etapa: ${depStage || '—'}), que ainda não chegou em "${STAGE_DONE}".`
        );
      }
    }
  }
  if (outOfOrder.length > 0) {
    p.log.warn('Dependências fora de ordem:\n' + outOfOrder.map(w => `  • ${w}`).join('\n'));
  }

  p.outro(`${chalk.green('✓')} ${sorted.length} de ${enriched.length} story(ies) ordenada(s).`);
}
