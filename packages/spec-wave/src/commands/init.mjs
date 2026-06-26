import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveToken, verifyTokenScopes } from '../api/auth.mjs';
import { runWizard } from '../ui/wizard.mjs';
import { setupProject } from '../setup/project.mjs';
import { setupLabels } from '../setup/labels.mjs';
import { setupFiles } from '../setup/files.mjs';
import { upsertFile } from '../api/github-rest.mjs';
import { CONFIG_FILE, AI_PROVIDERS, getProvider, DEFAULT_PROVIDER } from '../config.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dir, '..', '..', 'package.json'), 'utf-8'));

export async function init(options) {
  // --- Token ---
  let token;
  try {
    token = await resolveToken();
  } catch (err) {
    p.log.error(err.message);
    process.exit(1);
  }

  const tokenSpinner = p.spinner();
  tokenSpinner.start('Verificando token GitHub...');
  let tokenInfo;
  try {
    tokenInfo = await verifyTokenScopes(token);
    tokenSpinner.stop(`Autenticado como ${chalk.bold(tokenInfo.login)}`);
  } catch (err) {
    tokenSpinner.stop('');
    p.log.error(`Falha ao verificar token: ${err.message}`);
    process.exit(1);
  }

  const missingScopes = [];
  if (!tokenInfo.hasProject) missingScopes.push('project');
  if (!tokenInfo.hasRepo) missingScopes.push('repo');
  if (!tokenInfo.hasWorkflow) missingScopes.push('workflow');

  if (missingScopes.length > 0) {
    p.log.error(
      `Token sem os escopos necessários: ${missingScopes.join(', ')}\n` +
      `Execute: gh auth refresh --scopes project,repo,workflow\n` +
      `Ou crie um Personal Access Token com os escopos "project", "repo" e "workflow".`
    );
    process.exit(1);
  }

  // --- Wizard ou flags ---
  let owner, repo, projectTitle, provider, model;
  if (options.repo) {
    if (!options.repo.includes('/')) {
      p.log.error('Formato inválido para --repo. Use: owner/repo');
      process.exit(1);
    }
    [owner, repo] = options.repo.split('/');
    projectTitle = options.projectTitle ?? `${repo} — Spec Wave`;
    provider = (options.provider ?? DEFAULT_PROVIDER).toLowerCase();
    if (!getProvider(provider)) {
      p.log.error(
        `Provider inválido: ${provider}. Use um de: ${AI_PROVIDERS.map(pr => pr.value).join(', ')}`
      );
      process.exit(1);
    }
    model = options.model ?? getProvider(provider).defaultModel;
    p.log.info(`Repositório: ${owner}/${repo}`);
    p.log.info(`Projeto: ${projectTitle}`);
    p.log.info(`IA: ${getProvider(provider).label} · modelo ${model}`);
  } else {
    ({ owner, repo, projectTitle, provider, model } = await runWizard());
  }

  const providerMeta = getProvider(provider);

  if (options.dryRun) {
    p.log.info(chalk.yellow('Modo dry-run: nenhuma alteração será feita.'));
    p.log.info(`  Repositório: ${owner}/${repo}`);
    p.log.info(`  Projeto: ${projectTitle}`);
    p.log.info(`  IA: ${providerMeta.label} · modelo ${model}`);
    p.log.info('  Fases: project board → labels → workflow files');
    p.outro('Dry-run concluído.');
    return;
  }

  // --- Phase 1: Project Board ---
  let projectUrl, projectId, projectNumber, projectFields;
  if (options.skipProject) {
    p.log.info('Pulando criação do GitHub Project (--skip-project).');
  } else {
    const projectSpinner = p.spinner();
    projectSpinner.start('Criando GitHub Project...');
    try {
      const result = await setupProject(token, owner, repo, projectTitle, projectSpinner);
      projectUrl = result.projectUrl;
      projectId = result.projectId;
      projectNumber = result.projectNumber;
      projectFields = result.fields;
      projectSpinner.stop(`Projeto criado: ${chalk.cyan(projectUrl)}`);
      if (result.linkWarning) {
        p.log.warn(
          'Não foi possível vincular o projeto ao repositório (requer escopo "repo").\n' +
          'Faça manualmente: abra o projeto → Settings → Linked repositories → Add repository.'
        );
      }
    } catch (err) {
      projectSpinner.stop('');
      p.log.error(`Erro ao criar projeto: ${err.message}`);
      p.log.info('Use --skip-project para pular esta fase e tentar de novo.');
      process.exit(1);
    }
  }

  // --- Phase 2: Labels ---
  if (options.skipLabels) {
    p.log.info('Pulando criação das labels (--skip-labels).');
  } else {
    const labelSpinner = p.spinner();
    labelSpinner.start('Criando labels...');
    try {
      await setupLabels(token, owner, repo, labelSpinner);
      labelSpinner.stop('Labels criadas (16 labels)');
    } catch (err) {
      labelSpinner.stop('');
      p.log.error(`Erro ao criar labels: ${err.message}`);
      p.log.info('Use --skip-labels para pular esta fase e tentar de novo.');
      process.exit(1);
    }
  }

  // --- Phase 3: Files ---
  if (options.skipFiles) {
    p.log.info('Pulando criação dos arquivos (--skip-files).');
  } else {
    const filesSpinner = p.spinner();
    filesSpinner.start('Criando arquivos no repositório...');
    try {
      await setupFiles(token, owner, repo, filesSpinner);
      filesSpinner.stop('Arquivos criados (4 workflows + 2 issue templates)');
    } catch (err) {
      filesSpinner.stop('');
      p.log.error(`Erro ao criar arquivos: ${err.message}`);
      p.log.info('Use --skip-files para pular esta fase e tentar de novo.');
      process.exit(1);
    }
  }

  // --- Marcador de configuração (.spec-wave.json) ---
  // Commitado no repo-alvo para que a skill detecte, em sessões futuras, que o
  // init já rodou e qual project/versão foi usado. É a fonte de estado persistente.
  const configSpinner = p.spinner();
  configSpinner.start(`Gravando ${CONFIG_FILE}...`);
  try {
    const config = {
      version: pkg.version,
      owner,
      repo,
      project: {
        title: projectTitle,
        url: projectUrl ?? null,
        id: projectId ?? null,
        number: projectNumber ?? null,
        fields: projectFields ?? null,
      },
      ai: {
        provider: providerMeta.value,
        model,
      },
      initializedAt: new Date().toISOString(),
    };
    await upsertFile(
      token,
      owner,
      repo,
      CONFIG_FILE,
      JSON.stringify(config, null, 2) + '\n',
      'chore: record spec-wave config [spec-wave]'
    );
    configSpinner.stop(`${CONFIG_FILE} gravado (spec-wave v${pkg.version})`);
  } catch (err) {
    configSpinner.stop('');
    p.log.warn(`Não foi possível gravar ${CONFIG_FILE}: ${err.message}`);
  }

  p.note(
    'As 12 colunas do RFC-001 foram criadas no campo "Etapa".\n' +
    'Para usá-las como colunas do board:\n' +
    '  1. Abra o projeto no GitHub\n' +
    '  2. Clique em "..." → "Settings" da view de Board\n' +
    '  3. Em "Group by", selecione o campo "Etapa"',
    'Configurar Board View'
  );

  p.outro(
    `\n${chalk.green('✓')} spec-wave configurado com sucesso!\n\n` +
    (projectUrl ? `  Projeto: ${chalk.cyan(projectUrl)}\n\n` : '') +
    `  Próximos passos:\n` +
    `  1. Adicione ${providerMeta.secret} como secret no repositório (provider: ${providerMeta.label})\n` +
    `  2. Configure o board view para agrupar por "Etapa"\n` +
    `  3. Crie uma Feature com o prefixo [FEATURE] no título\n` +
    `  4. Use a skill spec-wave para guiar o fluxo\n\n` +
    `  ${chalk.dim('Para usar a skill: adicione skill/SKILL.md ao seu projeto Claude Code')}`
  );
}
