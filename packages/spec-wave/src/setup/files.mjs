import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { upsertFile, getFileContent, isRepoInitialized } from '../api/github-rest.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dir, '..', 'templates');

function readTemplate(...parts) {
  return readFileSync(path.join(TEMPLATES_DIR, ...parts), 'utf-8');
}

export async function setupFiles(token, owner, repo, spinner) {
  spinner.message('Verificando repositório...');
  const initialized = await isRepoInitialized(token, owner, repo);
  if (!initialized) {
    throw new Error(
      `O repositório ${owner}/${repo} está vazio (sem commits).\n` +
      `Inicialize-o com um commit antes de continuar:\n` +
      `  gh repo clone ${owner}/${repo} && cd ${repo}\n` +
      `  git commit --allow-empty -m "chore: initial commit" && git push`
    );
  }

  const filesToCreate = [
    {
      path: '.github/ISSUE_TEMPLATE/plan-template.md',
      content: readTemplate('issue', 'plan-template.md'),
      message: 'chore: add plan.md issue template [spec-wave]',
    },
    {
      path: '.github/ISSUE_TEMPLATE/spec-template.md',
      content: readTemplate('issue', 'spec-template.md'),
      message: 'chore: add spec.md issue template [spec-wave]',
    },
    {
      path: '.github/workflows/generate-plan.yml',
      content: readTemplate('workflows', 'generate-plan.yml'),
      message: 'chore: add generate-plan workflow [spec-wave]',
    },
    {
      path: '.github/workflows/generate-spec.yml',
      content: readTemplate('workflows', 'generate-spec.yml'),
      message: 'chore: add generate-spec workflow [spec-wave]',
    },
    {
      path: '.github/workflows/validate.yml',
      content: readTemplate('workflows', 'validate.yml'),
      message: 'chore: add validate workflow [spec-wave]',
    },
    {
      path: '.github/workflows/decompose.yml',
      content: readTemplate('workflows', 'decompose.yml'),
      message: 'chore: add decompose workflow [spec-wave]',
    },
  ];

  for (let i = 0; i < filesToCreate.length; i++) {
    const file = filesToCreate[i];
    spinner.message(`Criando arquivo ${i + 1}/${filesToCreate.length}: ${file.path}`);
    await upsertFile(token, owner, repo, file.path, file.content, file.message);
  }

  // Arquivos de config criados apenas se ainda não existirem, para não
  // sobrescrever ajustes manuais (tech_context.yml é editado pelo time).
  const configFiles = [
    {
      path: '.github/config/tech_context.yml',
      content: readTemplate('config', 'tech_context.yml'),
      message: 'chore: scaffold tech_context.yml [spec-wave]',
    },
  ];

  for (const file of configFiles) {
    const existing = await getFileContent(token, owner, repo, file.path);
    if (existing !== null) {
      spinner.message(`Mantendo ${file.path} existente (não sobrescrito)`);
      continue;
    }
    spinner.message(`Criando arquivo de config: ${file.path}`);
    await upsertFile(token, owner, repo, file.path, file.content, file.message);
  }
}
