// Gerencia uma Story no board: review (Etapa "👀 Code Review" + Status "Todo").
//
// Comando LOCAL — rodado pelo dev no terminal. owner/repo vêm da env
// GITHUB_REPOSITORY quando existir, senão do .spec-wave.json (gravado pelo init).
//
// Regra do board (ver config.mjs): a Etapa nunca retrocede — se a Story já
// estiver em Code Review ou adiante, o comando apenas informa a Etapa atual.
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue } from '../api/github-rest.mjs';
import { addProjectItem, getItemSingleSelectValue } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { loadProjectConfig, resolveField, advanceToStage } from '../lib/board.mjs';
import { CONFIG_FILE, STAGE_CODE_REVIEW, PROGRESS_TODO } from '../config.mjs';

// Resolve owner/repo: env GITHUB_REPOSITORY (padrão dos comandos de Action) com
// fallback no .spec-wave.json — comandos locais rodam sem essa env.
function resolveRepoContext() {
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  let cfg = {};
  const cfgPath = path.join(process.cwd(), CONFIG_FILE);
  try { if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch {}
  return { owner: envOwner || cfg.owner, repo: envRepo || cfg.repo };
}

export async function story({ action, issue: issueArg }) {
  if (action !== 'review') {
    p.log.error(
      `Ação desconhecida: "${action}".\n` +
      'Uso: spec-wave story review <número> — ex.: spec-wave story review 12'
    );
    process.exitCode = 1;
    return;
  }

  const issueNumber = parseInt(String(issueArg).replace('#', ''), 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    p.log.error(`Issue inválida: "${issueArg}". Use o número da issue, ex.: 12 ou #12.`);
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

  p.intro(chalk.bold(`spec-wave story review #${issueNumber}`));

  // 1. Lê a issue e valida o tipo.
  let issue;
  try {
    issue = await getIssue(token, owner, repo, issueNumber);
  } catch (err) {
    p.log.error(`Não foi possível ler a issue #${issueNumber}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const type = detectIssueType(issue);
  if (type !== 'Story') {
    p.log.error(
      `\`spec-wave story\` só aceita issues do tipo Story. ` +
      `Issue #${issueNumber} é do tipo ${type || 'desconhecido'} (${issue.title}).`
    );
    process.exitCode = 1;
    return;
  }

  // 2. Project do .spec-wave.json — sem ele não há board para atualizar.
  const { project, error: projectError } = loadProjectConfig();
  if (projectError) {
    p.log.error(`${projectError} — board não atualizado. Rode \`spec-wave init\` (ou \`spec-wave refresh --config\`).`);
    process.exitCode = 1;
    return;
  }
  const etapaField = await resolveField(token, project, 'Etapa').catch(() => null);
  const statusField = await resolveField(token, project, 'Status').catch(() => null);

  // 3. Avança para Code Review (Status reinicia em Todo ao trocar de etapa).
  let moved;
  try {
    moved = await advanceToStage(token, project, etapaField, statusField, issue.node_id, STAGE_CODE_REVIEW, PROGRESS_TODO);
  } catch (err) {
    p.log.error(`Falha ao atualizar o board: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (moved) {
    p.log.success(`Story #${issueNumber} → Etapa ${chalk.bold(STAGE_CODE_REVIEW)} / Status ${chalk.bold(PROGRESS_TODO)}.`);
    p.outro(`${chalk.green('✓')} Story #${issueNumber} pronta para revisão.`);
    return;
  }

  // false = a Story já está em Code Review ou em etapa posterior — e a Etapa
  // NUNCA retrocede. Lê a Etapa atual só para informar o usuário.
  let current = null;
  if (etapaField?.id) {
    try {
      const itemId = await addProjectItem(token, project.id, issue.node_id);
      current = await getItemSingleSelectValue(token, itemId, etapaField.id);
    } catch {
      // sem leitura da Etapa — segue com o aviso genérico
    }
  }
  p.log.info(
    `Story #${issueNumber} não foi movida: a Etapa nunca retrocede, e ela já está em ` +
    `${chalk.bold(current || `"${STAGE_CODE_REVIEW}" ou etapa posterior`)}.`
  );
  p.outro('Nada a fazer.');
}
