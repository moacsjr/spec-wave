import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import {
  CONFIG_FILE, STAGE_DEVELOPMENT, STAGE_CODE_REVIEW, STAGE_DONE,
  PROGRESS_TODO, PROGRESS_IN_PROGRESS, PROGRESS_DONE,
} from '../config.mjs';
import { getIssue } from '../api/github-rest.mjs';
import { listSubIssues, getIssueParent } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { slugify } from '../lib/slugify.mjs';

// Diretório onde montamos o arquivo de contexto entregue ao spec-kit.
const WORK_DIR = '.spec-wave';

// Sobe a cadeia de pais (Task → Story → Feature) até achar uma issue do tipo
// "Feature" e devolve { number, title } — usado para resolver docs/features/<slug>
// e para as instruções de fim de Story (mover a Feature para Code Review). Limita
// a profundidade para evitar loops em dados inconsistentes.
async function resolveFeature(token, startNodeId) {
  let current = startNodeId;
  for (let depth = 0; depth < 5 && current; depth++) {
    const parent = await getIssueParent(token, current);
    if (!parent) return null;
    if (detectIssueType({ title: parent.title }) === 'Feature') {
      return { number: parent.number, title: parent.title, nodeId: parent.nodeId };
    }
    current = parent.nodeId;
  }
  return null;
}

// Lê spec.md/plan.md de um docs/features/<slug> se existirem.
function readSpecPlan(featureDir) {
  const specPath = path.join(featureDir, 'spec.md');
  const planPath = path.join(featureDir, 'plan.md');
  return {
    specPath,
    planPath,
    spec: existsSync(specPath) ? readFileSync(specPath, 'utf-8') : null,
    plan: existsSync(planPath) ? readFileSync(planPath, 'utf-8') : null,
  };
}

// Monta o markdown de contexto que será entregue ao spec-kit implement.
function buildContext({ type, issue, tasks, feature, siblingStories = [], spec, plan, specPath, planPath }) {
  const lines = [];
  lines.push(`# Contexto de implementação — ${type} #${issue.number}`);
  lines.push('');
  lines.push(`**${type}:** ${issue.title}`);
  if (issue.body && issue.body.trim()) {
    lines.push('');
    lines.push(issue.body.trim());
  }

  // Modelo do board: "Etapa" (coluna do kanban) = DIREÇÃO, só avança; "Status"
  // (Todo/In Progress/Done) = PROGRESSO dentro da etapa. O desenvolvimento de
  // cada Task acontece na Etapa Desenvolvimento (Status In Progress); ao concluir,
  // a Task avança para a Etapa Done (Status Done). A Story avança para Code Review.
  lines.push('');
  lines.push('## Instruções de execução (uma task por vez, sequencial)');
  lines.push('');
  lines.push(
    'Há **dois campos** no board com papéis diferentes — não os confunda:\n' +
    `- **Etapa** (Backlog → … → ${STAGE_DEVELOPMENT} → ${STAGE_CODE_REVIEW} → … → ${STAGE_DONE}): a DIREÇÃO no kanban. Uma issue só **avança**, **nunca** volta para uma etapa anterior.\n` +
    `- **Status** (${PROGRESS_TODO} → ${PROGRESS_IN_PROGRESS} → ${PROGRESS_DONE}): o **progresso dentro da etapa atual**. Ao avançar de etapa, o Status reinicia em ${PROGRESS_TODO} — exceto ao chegar na Etapa ${STAGE_DONE}, onde o Status fica **${PROGRESS_DONE}**.`
  );
  lines.push('');
  if (type === 'Story') {
    lines.push(
      `Nesta fase, a Story #${issue.number} e suas Tasks estão na Etapa **${STAGE_DEVELOPMENT}**. ` +
      `Durante o desenvolvimento de cada Task, mexa no **Status**; ao **concluir** a Task, ela ` +
      `**avança para a Etapa ${STAGE_DONE}** (com Status ${PROGRESS_DONE}).`
    );
    lines.push('');
    lines.push(`1. Garanta que a Story #${issue.number} está na Etapa **${STAGE_DEVELOPMENT}** com Status **${PROGRESS_IN_PROGRESS}**, e que as Tasks estão nessa Etapa com Status **${PROGRESS_TODO}**.`);
    lines.push(`2. Implemente as ${tasks.length} task(s) **uma de cada vez, na ordem abaixo**. É PROIBIDO ter mais de uma Task com Status **${PROGRESS_IN_PROGRESS}** ao mesmo tempo. Para **cada Task**, na ordem:`);
    lines.push(`   1. **Ao começar:** Status da Task → **${PROGRESS_IN_PROGRESS}** (a Etapa continua ${STAGE_DEVELOPMENT}).`);
    lines.push('   2. **Implemente** a Task por completo.');
    lines.push(`   3. **Ao concluir:** **avance a Task para a Etapa ${STAGE_DONE}** com Status **${PROGRESS_DONE}**.`);
    lines.push('   4. Só então avance para a próxima Task.');
    lines.push('');
    lines.push(`3. **Ao concluir TODA a Story** (todas as Tasks na Etapa ${STAGE_DONE}):`);
    lines.push('   1. Faça o **commit** de todas as mudanças da implementação.');
    lines.push(`   2. Abra o **Pull Request** da Story #${issue.number}.`);
    lines.push(
      `   3. **Avance a Etapa da Story #${issue.number} para ${STAGE_CODE_REVIEW}** ` +
      `(reinicie o Status para ${PROGRESS_TODO}). As Tasks já estão em ${STAGE_DONE}.`
    );
    // A Feature só avança quando TODAS as suas Stories estiverem implementadas.
    lines.push(`   4. **A Feature${feature ? ` #${feature.number}` : ' (issue pai da Story)'} só avança para ${STAGE_CODE_REVIEW} quando TODAS as suas Stories estiverem implementadas:**`);
    if (siblingStories.length === 0) {
      lines.push(`      - Esta é a **única Story** da Feature → avance também a Feature${feature ? ` #${feature.number}` : ''} para ${STAGE_CODE_REVIEW} (Status → ${PROGRESS_TODO}).`);
    } else {
      lines.push(`      - Outras Stories desta Feature: ${siblingStories.map(s => `#${s.number}`).join(', ')}.`);
      lines.push(`      - Verifique a Etapa de cada uma. Avance a Feature para ${STAGE_CODE_REVIEW} **somente se TODAS** já estiverem em ${STAGE_CODE_REVIEW} (ou etapa posterior).`);
      lines.push(`      - Se **qualquer** Story ainda estiver pendente (antes de ${STAGE_CODE_REVIEW}), **NÃO mova a Feature** — deixe-a em ${STAGE_DEVELOPMENT} até a última Story ser concluída.`);
    }
  } else {
    lines.push(`Esta Task #${issue.number} está na Etapa **${STAGE_DEVELOPMENT}**:`);
    lines.push('');
    lines.push(`1. **Ao começar:** Status da Task #${issue.number} → **${PROGRESS_IN_PROGRESS}** (Etapa continua ${STAGE_DEVELOPMENT}).`);
    lines.push('2. **Implemente** a Task por completo.');
    lines.push(`3. **Ao concluir:** **avance a Task #${issue.number} para a Etapa ${STAGE_DONE}** com Status **${PROGRESS_DONE}**.`);
  }
  lines.push('');
  lines.push(
    `> **Regra do board:** a **Etapa** só avança (nunca retrocede); o **Status** (${PROGRESS_TODO}/${PROGRESS_IN_PROGRESS}/${PROGRESS_DONE}) ` +
    `mede o progresso dentro da etapa atual e reinicia a cada avanço (na Etapa ${STAGE_DONE}, o Status fica ${PROGRESS_DONE}).`
  );

  lines.push('');
  lines.push(`## Tasks a implementar — NESTA ORDEM (${tasks.length})`);
  tasks.forEach((t, i) => {
    lines.push('');
    lines.push(`### ${i + 1}. #${t.number} ${t.title}`);
    if (t.body && t.body.trim()) lines.push(t.body.trim());
  });

  if (spec) {
    lines.push('');
    lines.push(`## spec.md (${specPath})`);
    lines.push(spec.trim());
  }
  if (plan) {
    lines.push('');
    lines.push(`## plan.md (${planPath})`);
    lines.push(plan.trim());
  }

  lines.push('');
  return lines.join('\n');
}

// Substitui os placeholders do template de comando do spec-kit.
function renderCommand(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}

export async function implement({ issue: issueArg, featureDir: featureDirOpt, dryRun }) {
  const issueNumber = parseInt(String(issueArg).replace('#', ''), 10);
  if (!Number.isInteger(issueNumber)) {
    p.log.error(`Issue inválida: "${issueArg}". Use o número da issue, ex.: 12 ou #12.`);
    process.exitCode = 1;
    return;
  }

  // 1. Config local (.spec-wave.json) — owner/repo e bloco opcional specKit.
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) {
    p.log.error(`Repositório não inicializado (sem ${CONFIG_FILE}). Rode \`spec-wave init\` primeiro.`);
    process.exitCode = 1;
    return;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    p.log.error(`${CONFIG_FILE} corrompido: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const { owner, repo } = config;
  if (!owner || !repo) {
    p.log.error(`${CONFIG_FILE} não contém owner/repo. Rode \`spec-wave init\` novamente.`);
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

  p.intro(chalk.bold(`spec-wave implement #${issueNumber}`));

  // 2. Lê a issue alvo.
  let issue;
  try {
    issue = await getIssue(token, owner, repo, issueNumber);
  } catch (err) {
    p.log.error(`Não foi possível ler a issue #${issueNumber}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // 3. Detecta o tipo e monta a lista de tasks.
  const type = detectIssueType(issue);
  let tasks;
  if (type === 'Story') {
    const subs = await listSubIssues(token, issue.node_id);
    tasks = subs.filter(s => detectIssueType({ title: s.title, labels: s.labels }) === 'Task');
    if (tasks.length === 0) {
      p.log.error(`Story #${issueNumber} não tem Tasks (sub-issues) para implementar.`);
      process.exitCode = 1;
      return;
    }
    p.log.info(`Story com ${tasks.length} task(s): ${tasks.map(t => `#${t.number}`).join(', ')}`);
  } else if (type === 'Task') {
    tasks = [{ number: issue.number, title: issue.title, body: issue.body || '' }];
    p.log.info(`Task única #${issueNumber}.`);
  } else {
    p.log.error(
      `implement só aceita Story ou Task. Issue #${issueNumber} é do tipo ${type || 'desconhecido'}.`
    );
    process.exitCode = 1;
    return;
  }

  // 4. Resolve a Feature (pai na cadeia) — para spec.md/plan.md e para as
  // instruções de fim de Story (avançar a Etapa para Code Review).
  const feature = await resolveFeature(token, issue.node_id);
  let featureDir = featureDirOpt;
  if (!featureDir && feature?.title) {
    featureDir = path.join('docs', 'features', slugify(feature.title));
  }
  let specPlan = { spec: null, plan: null, specPath: null, planPath: null };
  if (featureDir && existsSync(featureDir)) {
    specPlan = readSpecPlan(featureDir);
  } else if (featureDir) {
    p.log.warn(`Diretório da feature não encontrado (${featureDir}); seguindo só com as tasks.`);
  } else {
    p.log.warn('Não foi possível resolver a Feature; seguindo só com as tasks (use --feature-dir).');
  }

  // 4b. Stories irmãs da Feature — a Feature só avança para Code Review quando
  // TODAS as suas Stories estiverem implementadas. Lista as outras para o agente
  // verificar antes de mover a Feature.
  let siblingStories = [];
  if (type === 'Story' && feature?.nodeId) {
    const featureSubs = await listSubIssues(token, feature.nodeId).catch(() => []);
    siblingStories = featureSubs
      .filter(s => detectIssueType({ title: s.title }) === 'Story' && s.number !== issue.number)
      .map(s => ({ number: s.number, title: s.title }));
  }

  // 5. Monta e grava o arquivo de contexto.
  const context = buildContext({ type, issue, tasks, feature, siblingStories, ...specPlan });
  mkdirSync(WORK_DIR, { recursive: true });
  const tasksFile = path.join(WORK_DIR, `implement-${issueNumber}.md`);
  writeFileSync(tasksFile, context);
  p.log.success(`Contexto montado em ${chalk.cyan(tasksFile)}.`);

  // 6. Aciona o spec-kit (comando configurável).
  const template = process.env.SPEC_WAVE_IMPLEMENT_CMD || config.specKit?.command;
  const vars = {
    tasksFile,
    specFile: specPlan.specPath || '',
    planFile: specPlan.planPath || '',
    issue: String(issueNumber),
    type,
    title: issue.title,
  };

  if (!template) {
    p.log.warn('Comando do spec-kit não configurado.');
    p.note(
      `Configure em ${CONFIG_FILE}:\n` +
      `  "specKit": { "command": "<comando do spec-kit com placeholders>" }\n` +
      'ou defina a env SPEC_WAVE_IMPLEMENT_CMD.\n\n' +
      'Placeholders: {tasksFile} {specFile} {planFile} {issue} {type} {title}',
      'Como acionar o spec-kit'
    );
    p.outro(`Contexto pronto em ${tasksFile}. Acione o spec-kit manualmente com esse arquivo.`);
    return;
  }

  const command = renderCommand(template, vars);

  if (dryRun) {
    p.note(command, 'Comando que seria executado (--dry-run)');
    p.outro(`Dry-run: nada executado. Contexto em ${tasksFile}.`);
    return;
  }

  p.log.step(`Executando: ${chalk.dim(command)}`);
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (err) {
    p.log.error(`spec-kit implement falhou: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  p.outro(
    `${chalk.green('✓')} Implementação acionada para ${type} #${issueNumber}.\n` +
    '  Próximo: revise as mudanças, abra o PR e mova o card para 👀 Code Review.'
  );
}
