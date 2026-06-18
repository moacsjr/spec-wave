import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../config.mjs';

// Lê o marcador .spec-flow.json do repositório atual (cwd) e reporta se o
// spec-flow já foi inicializado. Usado pela skill para decidir entre mostrar
// as informações ou oferecer rodar o `init`.
export async function info(options = {}) {
  const configPath = path.join(process.cwd(), CONFIG_FILE);

  if (!existsSync(configPath)) {
    if (options.json) {
      console.log(JSON.stringify({ initialized: false }));
      return;
    }
    p.intro(chalk.bold('spec-flow info'));
    p.log.warn(`Este repositório ${chalk.bold('não foi inicializado')} (sem ${CONFIG_FILE}).`);
    p.outro('Execute `npx spec-flow init` para configurar.');
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ initialized: false, error: err.message }));
      return;
    }
    p.log.error(`${CONFIG_FILE} existe mas está corrompido: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify({ initialized: true, ...config }));
    return;
  }

  p.intro(chalk.bold('spec-flow info'));
  p.log.success(`Repositório ${chalk.bold('inicializado')}.`);
  p.note(
    `${chalk.dim('Repositório:')} ${config.owner ?? '?'}/${config.repo ?? '?'}\n` +
    `${chalk.dim('Project:')}     ${config.project?.title ?? '—'}\n` +
    `${chalk.dim('URL:')}         ${config.project?.url ? chalk.cyan(config.project.url) : '—'}\n` +
    `${chalk.dim('Versão CLI:')}  ${config.version ?? '?'}\n` +
    `${chalk.dim('Criado em:')}   ${config.initializedAt ?? '?'}`,
    'Configuração'
  );
  p.outro('Use `/spec-flow feature <descrição>` para criar uma Feature.');
}
