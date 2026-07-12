import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, getPR, commentOnIssue } from '../api/github-rest.mjs';
import { addProjectItem, setItemSingleSelect, getSingleSelectField, getIssueParent, getItemSingleSelectValue } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { CONFIG_FILE, STATUS_OPTIONS, STAGE_ORDER, PROGRESS_TODO } from '../config.mjs';

const QA_STAGE = STATUS_OPTIONS.find(s => s.name.includes('QA'))?.name;
const TODO_STATUS = PROGRESS_TODO;

function extractIssueNumbers(body) {
  if (!body) return [];
  const nums = new Set();
  const re = /(?:closes?|fixes?|resolves?)\s+#(\d+)|(?<![/\w#])#(\d+)/gi;
  for (const m of body.matchAll(re)) {
    const n = parseInt(m[1] || m[2], 10);
    if (n) nums.add(n);
  }
  return [...nums];
}

async function resolveField(token, project, name) {
  if (project.fields?.[name]) return project.fields[name];
  if (name === 'Etapa' && project.etapaFieldId) {
    return { id: project.etapaFieldId, options: project.stageOptions || {} };
  }
  return await getSingleSelectField(token, project.id, name);
}

async function resolveFeatureIssue(token, owner, repo, issueNumber) {
  let issue;
  try {
    issue = await getIssue(token, owner, repo, issueNumber);
  } catch {
    return null;
  }
  const type = detectIssueType(issue);
  if (type === 'Feature') return issue;
  if (type !== 'Story' && type !== 'Task') return null;
  let currentNodeId = issue.node_id;
  for (let depth = 0; depth < 5; depth++) {
    const parent = await getIssueParent(token, currentNodeId);
    if (!parent) return null;
    if (detectIssueType({ title: parent.title }) === 'Feature') {
      return await getIssue(token, owner, repo, parent.number).catch(() => null);
    }
    currentNodeId = parent.nodeId;
  }
  return null;
}

// Avança para a Etapa "🧪 QA" e reinicia o Status para "Todo". Uma issue só
// AVANÇA: se já estiver em QA ou etapa posterior, não é tocada (retorna false).
async function setQA(token, project, etapaField, statusField, nodeId) {
  const itemId = await addProjectItem(token, project.id, nodeId);
  if (etapaField?.id && QA_STAGE) {
    const current = await getItemSingleSelectValue(token, itemId, etapaField.id).catch(() => null);
    const curIdx = current ? STAGE_ORDER.indexOf(current) : -1;
    const tgtIdx = STAGE_ORDER.indexOf(QA_STAGE);
    if (curIdx !== -1 && tgtIdx !== -1 && curIdx >= tgtIdx) {
      return false; // já está em QA ou adiante — não retrocede
    }
    const optionId = etapaField.options?.[QA_STAGE];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, etapaField.id, optionId);
  }
  if (statusField?.id) {
    const optionId = statusField.options?.[TODO_STATUS];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, statusField.id, optionId);
  }
  return true;
}

export async function qa({ prNumber }) {
  const token = await resolveToken();
  const projectToken = process.env.PROJECT_TOKEN || token;
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const cfgPath = path.join(process.cwd(), CONFIG_FILE);
  let cfg = {};
  try { if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch {}
  const owner = envOwner || cfg.owner;
  const repo = envRepo || cfg.repo;

  if (!owner || !repo) {
    throw new Error(
      'Não foi possível determinar owner/repo.\n' +
      'Defina GITHUB_REPOSITORY=owner/repo ou rode dentro de um repositório com .spec-wave.json.'
    );
  }

  const pr = await getPR(token, owner, repo, parseInt(prNumber, 10));
  const issueNums = extractIssueNumbers(pr.body || '');

  if (issueNums.length === 0) {
    console.log('PR sem referências a issues — nenhuma Feature atualizada.');
    return;
  }

  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.warn(`${CONFIG_FILE} não encontrado — board não atualizado.`);
    return;
  }
  let project;
  try {
    project = JSON.parse(readFileSync(configPath, 'utf-8')).project || {};
  } catch (err) {
    console.warn(`${CONFIG_FILE} corrompido (${err.message}) — board não atualizado.`);
    return;
  }
  if (!project.id) {
    console.warn(`Project não configurado em ${CONFIG_FILE} — board não atualizado.`);
    return;
  }

  const etapaField = await resolveField(projectToken, project, 'Etapa').catch(() => null);
  const statusField = await resolveField(projectToken, project, 'Status').catch(() => null);

  const seen = new Set();
  const updated = [];

  for (const num of issueNums) {
    const feature = await resolveFeatureIssue(token, owner, repo, num);
    if (!feature || seen.has(feature.number)) continue;
    seen.add(feature.number);
    try {
      const moved = await setQA(projectToken, project, etapaField, statusField, feature.node_id);
      if (moved) {
        updated.push(`#${feature.number} ${feature.title}`);
        console.log(`Feature #${feature.number} → "${QA_STAGE}" / Status "${TODO_STATUS}".`);
      } else {
        console.log(`Feature #${feature.number} já está em "${QA_STAGE}" ou etapa posterior — mantida (não retrocede).`);
      }
    } catch (err) {
      console.warn(`Falha ao atualizar Feature #${feature.number}: ${err.message}`);
    }
  }

  if (updated.length > 0) {
    await commentOnIssue(
      token, owner, repo, parseInt(prNumber, 10),
      `🧪 **PR aprovado — QA iniciado**\n\n` +
      `Feature(s) movida(s) para **${QA_STAGE}**:\n\n` +
      updated.map(f => `- ${f}`).join('\n')
    ).catch(() => {});
  }

  console.log(`qa: ${updated.length} feature(s) atualizada(s).`);
}
