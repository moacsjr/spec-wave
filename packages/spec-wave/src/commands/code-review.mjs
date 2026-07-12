import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, getPR, commentOnIssue } from '../api/github-rest.mjs';
import { addProjectItem, setItemSingleSelect, getSingleSelectField, getIssueParent, listSubIssues, getItemSingleSelectValue } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { CONFIG_FILE, STATUS_OPTIONS, STAGE_ORDER, PROGRESS_TODO } from '../config.mjs';

// Campo "Etapa" (custom) → "👀 Code Review". Campo "Status" (nativo) → "Todo".
const CODE_REVIEW_STAGE = STATUS_OPTIONS.find(s => s.name.includes('Code Review'))?.name;
const TODO_STATUS = PROGRESS_TODO;

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

// Coleta a "unidade de review" de uma issue referenciada no PR. Separa a
// Feature dos demais itens, porque a Feature tem regra própria (só avança
// quando TODAS as suas Stories estiverem em Code Review). Retorna
// { feature: {number,nodeId,title}|null, items: Map(number -> {nodeId,title}) }
// onde `items` são as Stories + Tasks que andam juntas neste PR.
async function collectReviewUnit(token, owner, repo, issueNumber) {
  const items = new Map();
  const add = (n, nodeId, title) => { if (n && nodeId && !items.has(n)) items.set(n, { nodeId, title }); };

  let issue;
  try { issue = await getIssue(token, owner, repo, issueNumber); } catch { return { feature: null, items }; }
  const type = detectIssueType(issue);
  if (type !== 'Feature' && type !== 'Story' && type !== 'Task') return { feature: null, items };

  const featureIssue = await resolveFeatureIssue(token, owner, repo, issueNumber);
  const feature = featureIssue
    ? { number: featureIssue.number, nodeId: featureIssue.node_id, title: featureIssue.title }
    : null;

  if (type === 'Feature') {
    // Referência direta à Feature: toda a subárvore (Stories + Tasks).
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
  return { feature, items };
}

// A Feature só avança quando TODAS as suas Stories já estiverem em Code Review
// (ou etapa posterior). readToken lê as issues; projToken opera no Project.
async function allStoriesReadyForReview(readToken, projToken, project, etapaField, featureNodeId) {
  if (!etapaField?.id) return true; // sem campo Etapa não há como checar — assume ok
  const subs = await listSubIssues(readToken, featureNodeId).catch(() => []);
  const stories = subs.filter(s => detectIssueType({ title: s.title }) === 'Story');
  if (stories.length === 0) return true;
  const tgtIdx = STAGE_ORDER.indexOf(CODE_REVIEW_STAGE);
  for (const st of stories) {
    const itemId = await addProjectItem(projToken, project.id, st.nodeId);
    const current = await getItemSingleSelectValue(projToken, itemId, etapaField.id).catch(() => null);
    const idx = current ? STAGE_ORDER.indexOf(current) : -1;
    if (idx === -1 || idx < tgtIdx) return false; // há Story pendente
  }
  return true;
}

// Avança um item do board para a Etapa "👀 Code Review" e reinicia o Status
// (nativo) para "Todo". Uma issue só AVANÇA: se já estiver em Code Review ou em
// uma etapa posterior, não é tocada (retorna false). Retorna true se avançou.
async function setCodeReview(token, project, etapaField, statusField, nodeId) {
  const itemId = await addProjectItem(token, project.id, nodeId);

  if (etapaField?.id && CODE_REVIEW_STAGE) {
    // Nunca retroceder: compara a etapa atual com a de destino na ordem canônica.
    const current = await getItemSingleSelectValue(token, itemId, etapaField.id).catch(() => null);
    const curIdx = current ? STAGE_ORDER.indexOf(current) : -1;
    const tgtIdx = STAGE_ORDER.indexOf(CODE_REVIEW_STAGE);
    if (curIdx !== -1 && tgtIdx !== -1 && curIdx >= tgtIdx) {
      return false; // já está em Code Review ou adiante — não retrocede
    }
    const optionId = etapaField.options?.[CODE_REVIEW_STAGE];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, etapaField.id, optionId);
  }
  // Ao avançar de etapa, o Status reinicia em "Todo".
  if (statusField?.id) {
    const optionId = statusField.options?.[TODO_STATUS];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, statusField.id, optionId);
  }
  return true;
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
  const featuresChecked = new Set();

  // Para cada issue referenciada: move a Story + Tasks para Code Review. A
  // Feature só avança quando TODAS as suas Stories já estiverem em Code Review.
  for (const num of issueNums) {
    const { feature, items } = await collectReviewUnit(token, owner, repo, num);

    for (const [n, info] of items) {
      if (seen.has(n)) continue;
      seen.add(n);
      try {
        const moved = await setCodeReview(projectToken, project, etapaField, statusField, info.nodeId);
        if (moved) {
          updated.push(`#${n} ${info.title}`);
          console.log(`#${n} → "${CODE_REVIEW_STAGE}" / Status "${TODO_STATUS}".`);
        } else {
          console.log(`#${n} já está em "${CODE_REVIEW_STAGE}" ou etapa posterior — mantido (não retrocede).`);
        }
      } catch (err) {
        console.warn(`Falha ao atualizar #${n}: ${err.message}`);
      }
    }

    // Feature: só avança se todas as suas Stories já estão em Code Review+.
    if (feature && !featuresChecked.has(feature.number)) {
      featuresChecked.add(feature.number);
      try {
        const ready = await allStoriesReadyForReview(token, projectToken, project, etapaField, feature.nodeId);
        if (!ready) {
          console.log(`Feature #${feature.number} mantida em desenvolvimento — ainda há Stories pendentes (fora de "${CODE_REVIEW_STAGE}").`);
        } else if (!seen.has(feature.number)) {
          seen.add(feature.number);
          const moved = await setCodeReview(projectToken, project, etapaField, statusField, feature.nodeId);
          if (moved) {
            updated.push(`#${feature.number} ${feature.title} (Feature)`);
            console.log(`Feature #${feature.number} → "${CODE_REVIEW_STAGE}" (todas as Stories concluídas).`);
          } else {
            console.log(`Feature #${feature.number} já está em "${CODE_REVIEW_STAGE}" ou etapa posterior.`);
          }
        }
      } catch (err) {
        console.warn(`Falha ao avaliar a Feature #${feature.number}: ${err.message}`);
      }
    }
  }

  if (updated.length > 0) {
    await commentOnIssue(
      token, owner, repo, parseInt(prNumber, 10),
      `🔍 **Code Review iniciado**\n\n` +
      `Movidos para **${CODE_REVIEW_STAGE}** (a Feature só avança quando todas as suas Stories concluírem):\n\n` +
      updated.map(f => `- ${f}`).join('\n')
    ).catch(() => {});
  }

  console.log(`code-review: ${updated.length} item(ns) movido(s) para "${CODE_REVIEW_STAGE}".`);
}
