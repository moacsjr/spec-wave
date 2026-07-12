import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, getPR, commentOnIssue } from '../api/github-rest.mjs';
import { addProjectItem, setItemSingleSelect, getSingleSelectField, getIssueParent, listSubIssues } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { CONFIG_FILE, STATUS_OPTIONS } from '../config.mjs';

// Campo "Etapa" (custom) → "👀 Code Review". Campo "Status" (nativo) → "Todo".
const CODE_REVIEW_STAGE = STATUS_OPTIONS.find(s => s.name.includes('Code Review'))?.name;
const TODO_STATUS = 'Todo';

// Extrai números de issues referenciadas no corpo do PR (Closes #N, Fixes #N, #N solto).
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

// Resolve o campo SINGLE_SELECT pelo nome: usa .spec-wave.json, legado ou API.
async function resolveField(token, project, name) {
  if (project.fields?.[name]) return project.fields[name];
  if (name === 'Etapa' && project.etapaFieldId) {
    return { id: project.etapaFieldId, options: project.stageOptions || {} };
  }
  return await getSingleSelectField(token, project.id, name);
}

// A partir de qualquer issue (Feature/Story/Task), sobe a hierarquia e retorna a Feature.
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

// Coleta a "unidade de review" de uma issue referenciada no PR: a Feature
// ancestral + a Story + as Tasks dessa Story — tudo anda junto com a Feature.
// Retorna Map number -> { nodeId, title }.
async function collectReviewUnit(token, owner, repo, issueNumber) {
  const unit = new Map();
  const add = (n, nodeId, title) => { if (n && nodeId && !unit.has(n)) unit.set(n, { nodeId, title }); };

  let issue;
  try { issue = await getIssue(token, owner, repo, issueNumber); } catch { return unit; }
  const type = detectIssueType(issue);
  if (type !== 'Feature' && type !== 'Story' && type !== 'Task') return unit;

  // Feature ancestral (ou a própria).
  const feature = await resolveFeatureIssue(token, owner, repo, issueNumber);
  if (feature) add(feature.number, feature.node_id, feature.title);

  if (type === 'Feature') {
    // Toda a subárvore da Feature: Stories + Tasks.
    const stories = await listSubIssues(token, issue.node_id).catch(() => []);
    for (const st of stories) {
      add(st.number, st.nodeId, st.title);
      const tasks = await listSubIssues(token, st.nodeId).catch(() => []);
      for (const t of tasks) add(t.number, t.nodeId, t.title);
    }
  } else if (type === 'Story') {
    add(issue.number, issue.node_id, issue.title);
    const tasks = await listSubIssues(token, issue.node_id).catch(() => []);
    for (const t of tasks) add(t.number, t.nodeId, t.title);
  } else { // Task → inclui a Story pai e as Tasks irmãs.
    add(issue.number, issue.node_id, issue.title);
    const parent = await getIssueParent(token, issue.node_id).catch(() => null);
    if (parent && detectIssueType({ title: parent.title }) === 'Story') {
      add(parent.number, parent.nodeId, parent.title);
      const tasks = await listSubIssues(token, parent.nodeId).catch(() => []);
      for (const t of tasks) add(t.number, t.nodeId, t.title);
    }
  }
  return unit;
}

// Move um item do board para Etapa "👀 Code Review" e Status "Todo".
async function setCodeReview(token, project, etapaField, statusField, nodeId) {
  const itemId = await addProjectItem(token, project.id, nodeId);
  if (etapaField?.id && CODE_REVIEW_STAGE) {
    const optionId = etapaField.options?.[CODE_REVIEW_STAGE];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, etapaField.id, optionId);
  }
  if (statusField?.id) {
    const optionId = statusField.options?.[TODO_STATUS];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, statusField.id, optionId);
  }
}

export async function codeReview({ prNumber }) {
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

  // Carrega projeto do .spec-wave.json
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

  // Resolve campos uma vez, reutiliza em todas as Features.
  const etapaField = await resolveField(projectToken, project, 'Etapa').catch(() => null);
  const statusField = await resolveField(projectToken, project, 'Status').catch(() => null);

  const seen = new Set();
  const updated = [];

  // Para cada issue referenciada, move a unidade inteira (Feature + Story +
  // Tasks) para Code Review — tudo anda junto com a Feature.
  for (const num of issueNums) {
    const unit = await collectReviewUnit(token, owner, repo, num);
    for (const [n, info] of unit) {
      if (seen.has(n)) continue;
      seen.add(n);
      try {
        await setCodeReview(projectToken, project, etapaField, statusField, info.nodeId);
        updated.push(`#${n} ${info.title}`);
        console.log(`#${n} → "${CODE_REVIEW_STAGE}" / Status "${TODO_STATUS}".`);
      } catch (err) {
        console.warn(`Falha ao atualizar #${n}: ${err.message}`);
      }
    }
  }

  if (updated.length > 0) {
    await commentOnIssue(
      token, owner, repo, parseInt(prNumber, 10),
      `🔍 **Code Review iniciado**\n\n` +
      `Movidos para **${CODE_REVIEW_STAGE}** (Feature + Story + Tasks):\n\n` +
      updated.map(f => `- ${f}`).join('\n')
    ).catch(() => {});
  }

  console.log(`code-review: ${updated.length} item(ns) movido(s) para "${CODE_REVIEW_STAGE}".`);
}
