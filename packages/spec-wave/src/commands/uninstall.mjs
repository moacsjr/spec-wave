import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { CONFIG_FILE, ALL_LABELS, WORKFLOW_FILES, ISSUE_TEMPLATE_FILES } from '../config.mjs';
import { deleteLabel, deleteFile } from '../api/github-rest.mjs';

const REPO_FILES = [
  ...WORKFLOW_FILES.map(f => `.github/workflows/${f}`),
  ...ISSUE_TEMPLATE_FILES.map(f => `.github/ISSUE_TEMPLATE/${f}`),
];

// Reverte o que o `init` criou — EXCETO o GitHub Project, que nunca é apagado
// (perderia todo o histórico do board). Remove labels, arquivos .github e o
// marcador .spec-wave.json local.
export async function uninstall(options = {}) {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  const hasConfig = existsSync(configPath);

  let owner, repo;
  if (options.repo) {
    if (!options.repo.includes('/')) {
      p.log.error('Formato inválido para --repo. Use: owner/repo');
      process.exitCode = 1;
      return;
    }
    [owner, repo] = options.repo.split('/');
  } else if (hasConfig) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      owner = config.owner;
      repo = config.repo;
    } catch (err) {
      p.log.error(`${CONFIG_FILE} corrompido: ${err.message}. Use --repo owner/repo.`);
      process.exitCode = 1;
      return;
    }
  }

  if (!owner || !repo) {
    p.log.error(`Não encontrei o repositório. Rode dentro de um repo com ${CONFIG_FILE} ou use --repo owner/repo.`);
    process.exitCode = 1;
    return;
  }

  const doLabels = !options.skipLabels;
  const doFiles = !options.skipFiles;
  const doConfig = hasConfig && !options.keepConfig;

  p.intro(chalk.bold('spec-wave uninstall'));
  p.note(
    `${chalk.dim('Repositório:')} ${owner}/${repo}\n\n` +
    `${doLabels ? '✓' : '○'} Labels do repo (${ALL_LABELS.length})\n` +
    `${doFiles ? '✓' : '○'} Arquivos .github (${REPO_FILES.length})\n` +
    `${doConfig ? '✓' : '○'} ${CONFIG_FILE} (local)\n\n` +
    `${chalk.yellow('O GitHub Project NÃO será apagado')} — remova-o manualmente se desejar.`,
    options.dryRun ? 'Dry-run — nada será alterado' : 'Será removido'
  );

  if (options.dryRun) {
    p.outro('Dry-run concluído.');
    return;
  }

  if (!options.yes) {
    const ok = await p.confirm({ message: `Remover a configuração do spec-wave de ${owner}/${repo}?`, initialValue: false });
    if (p.isCancel(ok) || !ok) {
      p.cancel('Cancelado. Nada foi alterado.');
      return;
    }
  }

  let token;
  try {
    token = await resolveToken();
  } catch (err) {
    p.log.error(err.message);
    process.exitCode = 1;
    return;
  }

  // --- Labels ---
  if (doLabels) {
    const spinner = p.spinner();
    spinner.start('Removendo labels...');
    let removed = 0;
    try {
      for (let i = 0; i < ALL_LABELS.length; i++) {
        spinner.message(`Removendo label ${i + 1}/${ALL_LABELS.length}: ${ALL_LABELS[i].name}`);
        if (await deleteLabel(token, owner, repo, ALL_LABELS[i].name)) removed++;
      }
      spinner.stop(`Labels removidas (${removed}/${ALL_LABELS.length}).`);
    } catch (err) {
      spinner.stop('');
      p.log.warn(`Erro ao remover labels: ${err.message}`);
    }
  }

  // --- Arquivos .github (cada remoção é um commit) ---
  if (doFiles) {
    const spinner = p.spinner();
    spinner.start('Removendo arquivos...');
    let removed = 0;
    try {
      for (let i = 0; i < REPO_FILES.length; i++) {
        const filePath = REPO_FILES[i];
        spinner.message(`Removendo ${i + 1}/${REPO_FILES.length}: ${filePath}`);
        if (await deleteFile(token, owner, repo, filePath, `chore: remove ${filePath} [spec-wave]`)) removed++;
      }
      spinner.stop(`Arquivos removidos (${removed}/${REPO_FILES.length}).`);
    } catch (err) {
      spinner.stop('');
      p.log.warn(`Erro ao remover arquivos: ${err.message}`);
    }
  }

  // --- Marcador local ---
  if (doConfig) {
    try {
      unlinkSync(configPath);
      p.log.success(`${CONFIG_FILE} removido.`);
    } catch (err) {
      p.log.warn(`Não foi possível remover ${CONFIG_FILE}: ${err.message}`);
    }
  }

  p.outro(
    `${chalk.green('✓')} spec-wave removido de ${owner}/${repo}.\n` +
    '  Lembre-se de excluir o GitHub Project manualmente, se quiser.'
  );
}
