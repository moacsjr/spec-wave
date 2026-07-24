import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, getPR, commentOnIssue } from '../api/github-rest.mjs';
import { getIssueParent } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { loadProjectConfig, resolveField, advanceToStage } from '../lib/board.mjs';
import { CONFIG_FILE, STATUS_OPTIONS, PROGRESS_TODO } from '../config.mjs';

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

  const { project, error: projectError } = loadProjectConfig();
  if (projectError) {
    console.warn(`${projectError} — board não atualizado.`);
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
      // Avança para "🧪 QA" e reinicia o Status em "Todo" (nunca retrocede).
      const moved = await advanceToStage(projectToken, project, etapaField, statusField, feature.node_id, QA_STAGE, TODO_STATUS);
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
