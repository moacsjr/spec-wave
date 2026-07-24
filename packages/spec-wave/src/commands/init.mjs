import * as p from '@clack/prompts';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveToken, verifyTokenScopes } from '../api/auth.mjs';
import { runWizard } from '../ui/wizard.mjs';
import { setupProject } from '../setup/project.mjs';
import { setupLabels } from '../setup/labels.mjs';
import { setupFiles } from '../setup/files.mjs';
import { getFileContent } from '../api/github-rest.mjs';
import { CONFIG_FILE, AI_PROVIDERS, getProvider, DEFAULT_PROVIDER, PORTAL_URL, WORKFLOW_FILES, ISSUE_TEMPLATE_FILES } from '../config.mjs';

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
    // Preserva o bloco project do .spec-wave.json existente (se houver).
    // Prefere o arquivo local; recorre ao remoto para repos configurados por
    // versões antigas (que commitavam o config direto no repo).
    try {
      const localConfigPath = path.join(process.cwd(), CONFIG_FILE);
      const raw = existsSync(localConfigPath)
        ? readFileSync(localConfigPath, 'utf-8')
        : await getFileContent(token, owner, repo, CONFIG_FILE);
      if (raw) {
        const existing = JSON.parse(raw);
        if (existing.project) {
          projectUrl = existing.project.url ?? undefined;
          projectId = existing.project.id ?? undefined;
          projectNumber = existing.project.number ?? undefined;
          projectFields = existing.project.fields ?? undefined;
          p.log.info('Dados do Project preservados do config existente.');
        }
      }
    } catch {
      // Sem config existente — mantém undefined (será gravado como null).
    }
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
      filesSpinner.stop(`Arquivos criados (${WORKFLOW_FILES.length} workflows + ${ISSUE_TEMPLATE_FILES.length} issue templates)`);
    } catch (err) {
      filesSpinner.stop('');
      p.log.error(`Erro ao criar arquivos: ${err.message}`);
      p.log.info('Use --skip-files para pular esta fase e tentar de novo.');
      process.exit(1);
    }
  }

  // --- Marcador de configuração (.spec-wave.json) ---
  // Gravado LOCALMENTE no diretório atual (não commitado direto no repo): é a
  // fonte de estado persistente lida por info/refresh/uninstall/skill a partir
  // do cwd. O usuário revisa e commita quando quiser.
  const localConfigPath = path.join(process.cwd(), CONFIG_FILE);
  let configWritten = false;
  const configSpinner = p.spinner();
  configSpinner.start(`Gravando ${CONFIG_FILE} local...`);
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
    writeFileSync(localConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    configWritten = true;
    configSpinner.stop(`${CONFIG_FILE} gravado local (spec-wave v${pkg.version})`);
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
    (configWritten
      ? `  1. Commite o ${CONFIG_FILE} quando quiser (git add ${CONFIG_FILE} && git commit)\n`
      : '') +
    `  ${configWritten ? '2' : '1'}. Adicione ${providerMeta.secret} como secret no repositório (provider: ${providerMeta.label})\n` +
    `  ${configWritten ? '3' : '2'}. Configure o board view para agrupar por "Etapa"\n` +
    `  ${configWritten ? '4' : '3'}. Crie uma Feature com o prefixo [FEATURE] no título\n` +
    `  ${configWritten ? '5' : '4'}. Use a skill spec-wave para guiar o fluxo\n\n` +
    `  ${chalk.dim('Para instalar a skill no seu agente: npx @spec-wave/cli install-skill')}\n\n` +
    `  🌐 Acesse o Portal Web da ferramenta em ${chalk.cyan(PORTAL_URL)}`
  );
}
