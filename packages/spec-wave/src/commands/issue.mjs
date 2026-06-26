import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { CONFIG_FILE, STATUS_OPTIONS, PRIORITY_LABELS, WORK_ITEM_TYPES } from '../config.mjs';
import { createIssue, getIssue } from '../api/github-rest.mjs';
import { addProjectItem, setItemSingleSelect, getSingleSelectField, addSubIssue } from '../api/github-graphql.mjs';

// Etapa inicial de todo work item recém-criado (📥 Backlog).
const INITIAL_STAGE = STATUS_OPTIONS[0].name;
const VALID_PRIORITIES = PRIORITY_LABELS.map(l => l.name);

// Resolve o tipo informado (case-insensitive) para o nome canônico (ex.: "Feature").
function normalizeType(input) {
  if (!input) return null;
  return WORK_ITEM_TYPES.find(t => t.toLowerCase() === input.toLowerCase()) || null;
}

function buildBody(options, parent) {
  const parts = [];
  if (parent) parts.push(`**Parent:** #${parent.number} — ${parent.title}`);
  const desc = (options.body || '').trim();
  if (desc) parts.push(desc);
  const meta = [];
  if (options.area) meta.push(`- **Área:** ${options.area}`);
  if (options.priority) meta.push(`- **Prioridade:** ${options.priority}`);
  if (meta.length) parts.push(`## Metadados\n${meta.join('\n')}`);
  return parts.join('\n\n') || '_(sem descrição)_';
}

// Resolve um campo SINGLE_SELECT pelo nome: usa o .spec-wave.json, cai para o
// formato legado (etapaFieldId/stageOptions) e, por fim, consulta o Project.
async function resolveField(token, project, name) {
  if (project.fields && project.fields[name]) return project.fields[name];
  if (name === 'Etapa' && project.etapaFieldId) {
    return { id: project.etapaFieldId, options: project.stageOptions || {} };
  }
  return await getSingleSelectField(token, project.id, name);
}

// Seta o valor de um campo do item no board. Retorna true se aplicou.
async function setField(token, project, itemId, fieldName, optionName) {
  const field = await resolveField(token, project, fieldName);
  const optionId = field?.options?.[optionName];
  if (field?.id && optionId) {
    await setItemSingleSelect(token, project.id, itemId, field.id, optionId);
    return true;
  }
  return false;
}

// Cria um work item (issue tipada), opcionalmente como sub-issue de um parent,
// adiciona ao Project e define Etapa, Work Item Type, Prioridade e Área no board.
export async function issue(options) {
  if (!options.title) {
    p.log.error('Informe o título: --title "<título>"');
    process.exitCode = 1;
    return;
  }
  const type = normalizeType(options.type || 'feature');
  if (!type) {
    p.log.error(`Tipo inválido: "${options.type}". Use um de: ${WORK_ITEM_TYPES.join(', ')}`);
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

  p.intro(chalk.bold(`spec-wave issue (${type})`));

  // Resolve o parent (se informado) — precisamos do node id para a sub-issue.
  let parent = null;
  if (options.parent) {
    const parentNumber = parseInt(String(options.parent).replace('#', ''), 10);
    if (!Number.isInteger(parentNumber)) {
      p.log.error(`--parent inválido: ${options.parent}. Use o número da issue pai.`);
      process.exitCode = 1;
      return;
    }
    try {
      const data = await getIssue(token, owner, repo, parentNumber);
      parent = { number: data.number, nodeId: data.node_id, title: data.title };
    } catch (err) {
      p.log.error(`Não foi possível ler a issue pai #${parentNumber}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // 1. Cria a issue (título e label prefixados pelo tipo, ex.: [FEATURE]).
  const tag = `[${type.toUpperCase()}]`;
  const labels = [tag];
  if (options.priority) labels.push(options.priority);

  const issueSpinner = p.spinner();
  issueSpinner.start('Criando issue...');
  let created;
  try {
    created = await createIssue(token, owner, repo, `${tag} ${options.title}`, buildBody(options, parent), labels);
    issueSpinner.stop(`Issue #${created.number} criada: ${chalk.cyan(created.url)}`);
  } catch (err) {
    issueSpinner.stop('');
    p.log.error(`Erro ao criar issue: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // 2. Vincula como sub-issue do parent (relação nativa do GitHub).
  if (parent) {
    try {
      await addSubIssue(token, parent.nodeId, created.nodeId);
      p.log.success(`Vinculada como sub-issue de #${parent.number}.`);
    } catch (err) {
      p.log.warn(`Issue criada, mas falhou ao vincular ao parent #${parent.number}: ${err.message}`);
    }
  }

  // 3. Adiciona ao Project e define os campos do board.
  if (!project.id) {
    p.log.warn(
      `Project não configurado no ${CONFIG_FILE} — a issue não foi adicionada ao board.\n` +
      'Re-rode `spec-wave init` (sem --skip-project) ou `spec-wave refresh --config`.'
    );
    p.outro(`${type} #${created.number} criado (fora do board).`);
    return;
  }

  const boardSpinner = p.spinner();
  boardSpinner.start('Adicionando ao Project...');
  try {
    const itemId = await addProjectItem(token, project.id, created.nodeId);

    const stageOk = await setField(token, project, itemId, 'Etapa', INITIAL_STAGE);
    const typeOk = await setField(token, project, itemId, 'Work Item Type', type);
    if (options.priority) await setField(token, project, itemId, 'Priority', options.priority);
    if (options.area) await setField(token, project, itemId, 'Area', options.area);

    boardSpinner.stop(`Adicionada ao Project${stageOk ? ` em "${INITIAL_STAGE}"` : ''}.`);
    if (!stageOk) p.log.warn(`Não foi possível definir a Etapa "${INITIAL_STAGE}" (campo não encontrado).`);
    if (!typeOk) p.log.warn(`Não foi possível definir o Work Item Type "${type}" (campo não encontrado).`);
  } catch (err) {
    boardSpinner.stop('');
    p.log.warn(`Issue criada, mas falhou ao adicionar ao Project: ${err.message}`);
  }

  const parentLine = parent ? ` (sub-issue de #${parent.number})` : '';
  const hints = {
    Feature: `Próximo: \`/spec-wave plan ${created.number}\` para o planejamento técnico.`,
    Initiative: `Próximo: crie Epics sob esta Initiative com \`spec-wave issue --type epic --parent ${created.number} --title "..."\`.`,
    Epic: `Próximo: crie Features sob este Epic com \`spec-wave feature --parent ${created.number} --title "..."\`.`,
  };
  p.outro(
    `${chalk.green('✓')} ${type} #${created.number} criado em "${INITIAL_STAGE}"${parentLine}.\n` +
    `  ${hints[type] || ''}`
  );
}
