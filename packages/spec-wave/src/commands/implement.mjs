import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { CONFIG_FILE, STAGE_IN_PROGRESS, STAGE_DONE, STAGE_CODE_REVIEW } from '../config.mjs';
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
      return { number: parent.number, title: parent.title };
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
function buildContext({ type, issue, tasks, feature, spec, plan, specPath, planPath }) {
  const lines = [];
  lines.push(`# Contexto de implementação — ${type} #${issue.number}`);
  lines.push('');
  lines.push(`**${type}:** ${issue.title}`);
  if (issue.body && issue.body.trim()) {
    lines.push('');
    lines.push(issue.body.trim());
  }

  // Fluxo SEQUENCIAL, uma task por vez: cada task só vai para "In Progress"
  // quando seu desenvolvimento começa e vai para "Done" ao concluir — nunca
  // todas as tasks em "In Progress" ao mesmo tempo.
  lines.push('');
  lines.push('## Instruções de execução (uma task por vez, sequencial)');
  lines.push('');
  if (type === 'Story') {
    lines.push(
      `Implemente as ${tasks.length} task(s) desta Story **uma de cada vez, na ordem listada ` +
      'abaixo**. É PROIBIDO mover mais de uma task para "In Progress" ao mesmo tempo: uma task ' +
      'só entra em desenvolvimento depois que a anterior estiver concluída.'
    );
    lines.push('');
    lines.push(`1. Ao **iniciar a primeira** task, mova a Story #${issue.number} para **${STAGE_IN_PROGRESS}**.`);
    lines.push('2. Para **cada task**, na ordem, execute este ciclo completo antes de passar para a próxima:');
    lines.push(`   1. **Ao começar a task:** mova o status (campo "Etapa") *apenas dessa task* para **${STAGE_IN_PROGRESS}** (In Progress). Nenhuma outra task.`);
    lines.push('   2. **Implemente** essa task por completo.');
    lines.push(`   3. **Ao concluir a task:** mova o status *dessa task* para **${STAGE_DONE}** (Done).`);
    lines.push('   4. Só então avance para a próxima task e repita o ciclo.');
    lines.push('');
    lines.push(`3. **Ao concluir a implementação de TODA a Story** (todas as tasks em **${STAGE_DONE}**):`);
    lines.push('   1. Faça o **commit** de todas as mudanças da implementação.');
    lines.push(`   2. Abra o **Pull Request** da Story #${issue.number}.`);
    lines.push(
      `   3. Mova ${feature ? `a Feature #${feature.number}` : 'a Feature (issue pai da Story)'} e a ` +
      `Story #${issue.number} para **${STAGE_CODE_REVIEW}**. ` +
      `As **Tasks permanecem em ${STAGE_DONE}** (não as mova para trás).`
    );
  } else {
    lines.push(`Implemente a Task #${issue.number} bracketando o status no GitHub Project:`);
    lines.push('');
    lines.push(`1. **Ao começar:** mova o status (campo "Etapa") da Task #${issue.number} para **${STAGE_IN_PROGRESS}** (In Progress).`);
    lines.push('2. **Implemente** a task por completo.');
    lines.push(`3. **Ao concluir:** mova o status da Task #${issue.number} para **${STAGE_DONE}** (Done).`);
  }
  lines.push('');
  lines.push(
    `> Mantenha o status coerente com o progresso real: nenhuma task pode ficar em "${STAGE_IN_PROGRESS}" ` +
    `antes de você começá-la, nem em "${STAGE_DONE}" antes de concluí-la. Atualize o campo "Etapa"/Status ` +
    'do item no GitHub Project.'
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
  // instruções de fim de Story (mover Feature + Story para Code Review).
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

  // 5. Monta e grava o arquivo de contexto.
  const context = buildContext({ type, issue, tasks, feature, ...specPlan });
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
