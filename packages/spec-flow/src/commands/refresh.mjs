import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { CONFIG_FILE } from '../config.mjs';
import { getProjectSnapshot } from '../api/github-graphql.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dir, '..', '..', 'package.json'), 'utf-8'));

// Re-consulta o GitHub Project e reescreve o .spec-flow.json local com os dados
// atuais (id/number/url/title do Project, IDs do campo Etapa e das opções, e a
// versão da CLI). Útil para repositórios inicializados antes do enriquecimento,
// ou quando o Project foi renomeado/teve campos alterados.
export async function refresh(options = {}) {
  if (!options.config) {
    p.log.error('Nada a fazer. Use `spec-flow refresh --config` para atualizar o .spec-flow.json.');
    process.exitCode = 1;
    return;
  }

  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) {
    p.log.error(`Repositório não inicializado (sem ${CONFIG_FILE}). Rode \`spec-flow init\` primeiro.`);
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

  const projectId = config.project?.id;
  if (!projectId) {
    p.log.error(
      `${CONFIG_FILE} não tem o id do Project (project.id). ` +
      'Re-rode `spec-flow init` (sem --skip-project) para registrá-lo.'
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

  p.intro(chalk.bold('spec-flow refresh --config'));

  const spinner = p.spinner();
  spinner.start('Consultando o GitHub Project...');
  let snapshot;
  try {
    snapshot = await getProjectSnapshot(token, projectId);
  } catch (err) {
    spinner.stop('');
    p.log.error(`Erro ao consultar o Project: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!snapshot) {
    spinner.stop('');
    p.log.error(`Project ${projectId} não encontrado. Ele pode ter sido excluído.`);
    process.exitCode = 1;
    return;
  }
  spinner.stop('Project consultado.');

  const updated = {
    ...config,
    version: pkg.version,
    project: {
      ...config.project,
      title: snapshot.title,
      url: snapshot.url,
      id: snapshot.id,
      number: snapshot.number,
      etapaFieldId: snapshot.etapaFieldId,
      stageOptions: snapshot.stageOptions,
    },
    refreshedAt: new Date().toISOString(),
  };

  try {
    writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n');
  } catch (err) {
    p.log.error(`Falha ao gravar ${CONFIG_FILE}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!snapshot.etapaFieldId) {
    p.log.warn('Campo "Etapa" não encontrado no Project — `stageOptions` ficou vazio.');
  }

  p.note(
    `${chalk.dim('Project:')}     ${snapshot.title} (#${snapshot.number})\n` +
    `${chalk.dim('Etapa field:')} ${snapshot.etapaFieldId ?? '—'}\n` +
    `${chalk.dim('Etapas:')}      ${snapshot.stageOptions ? Object.keys(snapshot.stageOptions).length : 0} opções\n` +
    `${chalk.dim('Versão CLI:')}  ${pkg.version}`,
    'Configuração atualizada'
  );
  p.outro(`${CONFIG_FILE} atualizado. Faça commit do arquivo para versioná-lo.`);
}
