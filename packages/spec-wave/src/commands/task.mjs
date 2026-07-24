// Gerencia uma Task no board: start (Etapa "🚧 Desenvolvimento" + Status
// "In Progress") | done (Etapa "🎉 Done" + Status "Done").
//
// Comando LOCAL — rodado pelo dev no terminal. owner/repo vêm da env
// GITHUB_REPOSITORY quando existir, senão do .spec-wave.json (gravado pelo init).
//
// Regras do board embutidas (ver config.mjs):
//  • Etapa nunca retrocede (advanceToStage devolve false nesse caso);
//  • uma única Task com Status "In Progress" por vez dentro da mesma Story
//    (regra pura canStartTask, testada em test/board-rules.test.mjs).
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue } from '../api/github-rest.mjs';
import { addProjectItem, getIssueParent, listSubIssues, getItemSingleSelectValue } from '../api/github-graphql.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { loadProjectConfig, resolveField, advanceToStage, setItemStatus } from '../lib/board.mjs';
import {
  CONFIG_FILE, STAGE_DEVELOPMENT, STAGE_DONE,
  PROGRESS_IN_PROGRESS, PROGRESS_DONE,
} from '../config.mjs';

/**
 * Regra PURA: pode iniciar uma Task? Só se NENHUMA task irmã (mesma Story)
 * estiver com Status "In Progress". Irmãs com status desconhecido (null/
 * undefined) NÃO bloqueiam — falha de leitura não pode travar o fluxo.
 *
 * @param {{ siblings: Array<{ number: number, status: string|null }> }} input
 * @returns {{ ok: boolean, blocker: number|null }} blocker = number da irmã
 *          em andamento, quando houver
 */
export function canStartTask({ siblings } = {}) {
  const busy = (siblings || []).find(s => s && s.status === PROGRESS_IN_PROGRESS);
  return busy ? { ok: false, blocker: busy.number } : { ok: true, blocker: null };
}

// Resolve owner/repo: env GITHUB_REPOSITORY (padrão dos comandos de Action) com
// fallback no .spec-wave.json — comandos locais rodam sem essa env.
function resolveRepoContext() {
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  let cfg = {};
  const cfgPath = path.join(process.cwd(), CONFIG_FILE);
  try { if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch {}
  return { owner: envOwner || cfg.owner, repo: envRepo || cfg.repo };
}

export async function task({ action, issue: issueArg }) {
  if (action !== 'start' && action !== 'done') {
    p.log.error(
      `Ação desconhecida: "${action}".\n` +
      'Uso: spec-wave task <start|done> <número> — ex.: spec-wave task start 12'
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

  p.intro(chalk.bold(`spec-wave task ${action} #${issueNumber}`));

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
  if (type !== 'Task') {
    p.log.error(
      `\`spec-wave task\` só aceita issues do tipo Task. ` +
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

  // 3. start: garante que nenhuma task irmã (mesma Story) está In Progress.
  if (action === 'start') {
    const parent = await getIssueParent(token, issue.node_id).catch(() => null);
    const parentIsStory = parent && detectIssueType({ title: parent.title }) === 'Story';
    if (!statusField?.id) {
      p.log.warn('Campo "Status" não encontrado no Project — verificação de task em andamento pulada.');
    } else if (!parentIsStory) {
      p.log.warn(`Task #${issueNumber} sem Story-pai — verificação de tasks irmãs pulada.`);
    } else {
      const subs = await listSubIssues(token, parent.nodeId).catch(() => []);
      const siblingTasks = subs.filter(s =>
        s.number !== issueNumber && detectIssueType({ title: s.title, labels: s.labels }) === 'Task'
      );
      // Status de cada irmã; falha de leitura → status desconhecido (não bloqueia).
      const siblings = await Promise.all(siblingTasks.map(async (s) => {
        try {
          const itemId = await addProjectItem(token, project.id, s.nodeId);
          const status = await getItemSingleSelectValue(token, itemId, statusField.id);
          return { number: s.number, title: s.title, status };
        } catch {
          return { number: s.number, title: s.title, status: null };
        }
      }));
      const { ok, blocker } = canStartTask({ siblings });
      if (!ok) {
        const b = siblings.find(s => s.number === blocker);
        p.log.error(
          `já existe task em andamento: #${blocker} «${b?.title || ''}» — ` +
          `finalize com \`spec-wave task done ${blocker}\` antes de iniciar outra`
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  // 4. Move no board. start → Desenvolvimento/In Progress; done → Done/Done.
  const target = action === 'start'
    ? { stage: STAGE_DEVELOPMENT, status: PROGRESS_IN_PROGRESS }
    : { stage: STAGE_DONE, status: PROGRESS_DONE };

  let moved;
  try {
    moved = await advanceToStage(token, project, etapaField, statusField, issue.node_id, target.stage, target.status);
  } catch (err) {
    p.log.error(`Falha ao atualizar o board: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (moved) {
    p.log.success(`Task #${issueNumber} → Etapa ${chalk.bold(target.stage)} / Status ${chalk.bold(target.status)}.`);
  } else {
    // Etapa já está no destino ou adiante (nunca retrocede) — só garante o Status.
    try {
      await setItemStatus(token, project, statusField, issue.node_id, target.status);
      p.log.info(`Etapa já à frente — apenas Status ajustado para ${chalk.bold(target.status)}.`);
    } catch (err) {
      p.log.warn(`Etapa já à frente, mas falhou ao ajustar o Status: ${err.message}`);
    }
  }

  p.outro(
    action === 'start'
      ? `${chalk.green('✓')} Task #${issueNumber} em andamento. Ao concluir: spec-wave task done ${issueNumber}`
      : `${chalk.green('✓')} Task #${issueNumber} concluída no board.`
  );
}
