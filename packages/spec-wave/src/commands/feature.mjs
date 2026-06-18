import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { CONFIG_FILE, STATUS_OPTIONS, PRIORITY_LABELS } from '../config.mjs';
import { createIssue } from '../api/github-rest.mjs';
import { addProjectItem, setItemSingleSelect, getSingleSelectField } from '../api/github-graphql.mjs';

// Etapa inicial de toda Feature recém-criada (📥 Backlog).
const INITIAL_STAGE = STATUS_OPTIONS[0].name;
const VALID_PRIORITIES = PRIORITY_LABELS.map(l => l.name);

function buildBody(options) {
  let body = (options.body || '').trim() || '_(sem descrição)_';
  const meta = [];
  if (options.area) meta.push(`- **Área:** ${options.area}`);
  if (options.priority) meta.push(`- **Prioridade:** ${options.priority}`);
  if (meta.length) body += `\n\n## Metadados\n${meta.join('\n')}`;
  return body;
}

export async function feature(options) {
  if (!options.title) {
    p.log.error('Informe o título: --title "<título>"');
    process.exitCode = 1;
    return;
  }
  if (options.priority && !VALID_PRIORITIES.includes(options.priority)) {
    p.log.error(`Prioridade inválida: ${options.priority}. Use uma de: ${VALID_PRIORITIES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

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
  const project = config.project || {};
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

  p.intro(chalk.bold('spec-wave feature'));

  // 1. Cria a issue com labels [FEATURE] + prioridade
  const labels = ['[FEATURE]'];
  if (options.priority) labels.push(options.priority);

  const issueSpinner = p.spinner();
  issueSpinner.start('Criando issue...');
  let issue;
  try {
    issue = await createIssue(token, owner, repo, `[FEATURE] ${options.title}`, buildBody(options), labels);
    issueSpinner.stop(`Issue #${issue.number} criada: ${chalk.cyan(issue.url)}`);
  } catch (err) {
    issueSpinner.stop('');
    p.log.error(`Erro ao criar issue: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // 2. Adiciona ao Project e move para 📥 Backlog
  if (!project.id) {
    p.log.warn(
      `Project não configurado no ${CONFIG_FILE} — a issue foi criada mas não foi adicionada ao board.\n` +
      'Re-rode `spec-wave init` (sem --skip-project) para registrar o Project.'
    );
    p.outro(`Feature #${issue.number} criada (fora do board).`);
    return;
  }

  const boardSpinner = p.spinner();
  boardSpinner.start('Adicionando ao Project...');
  try {
    const itemId = await addProjectItem(token, project.id, issue.nodeId);

    // Resolve o campo Etapa: usa os IDs do .spec-wave.json; se ausentes
    // (repos inicializados antes desta versão), consulta o Project.
    let fieldId = project.etapaFieldId;
    let optionId = project.stageOptions?.[INITIAL_STAGE];
    if (!fieldId || !optionId) {
      boardSpinner.message('Consultando campo "Etapa"...');
      const etapa = await getSingleSelectField(token, project.id, 'Etapa');
      fieldId = etapa?.id;
      optionId = etapa?.options?.[INITIAL_STAGE];
    }

    if (fieldId && optionId) {
      await setItemSingleSelect(token, project.id, itemId, fieldId, optionId);
      boardSpinner.stop(`Adicionada ao Project em "${INITIAL_STAGE}".`);
    } else {
      boardSpinner.stop('');
      p.log.warn(
        `Issue adicionada ao Project, mas não foi possível definir a Etapa "${INITIAL_STAGE}" ` +
        '(campo não encontrado). Defina manualmente no board.'
      );
    }
  } catch (err) {
    boardSpinner.stop('');
    p.log.warn(`Issue criada, mas falhou ao adicionar ao Project: ${err.message}`);
  }

  p.outro(
    `${chalk.green('✓')} Feature #${issue.number} criada em "${INITIAL_STAGE}".\n` +
    `  Próximo: \`/spec-wave plan ${issue.number}\` para iniciar o planejamento técnico.`
  );
}
