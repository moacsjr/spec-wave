import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, commentOnIssue } from '../api/github-rest.mjs';
import { generateDocument } from '../lib/claude.mjs';
import { slugify } from '../lib/slugify.mjs';

const SYSTEM_PROMPT = `Você é um Tech Lead experiente. Gere um plano técnico (plan.md) completo e detalhado para a Feature descrita pelo usuário.

O plano deve conter exatamente estas seções em português:
# Frontend
# Backend
# Banco de dados
# Infraestrutura
# Segurança
# Testes
# Estimativa (Story Points)

Para cada seção, forneça detalhes técnicos concretos e acionáveis baseados na descrição da Feature.
A estimativa de Story Points deve usar a sequência de Fibonacci: 1, 2, 3, 5, 8, 13, 21.
Responda APENAS com o conteúdo do plan.md, sem texto adicional.`;

export async function generatePlan({ issueNumber }) {
  const token = await resolveToken();
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');

  if (!owner || !repo) {
    throw new Error(
      'GITHUB_REPOSITORY env var não definida.\n' +
      'Este comando roda no GitHub Actions. Para testar localmente:\n' +
      '  GITHUB_REPOSITORY=owner/repo spec-wave generate-plan --issue-number 1'
    );
  }

  console.log(`Buscando issue #${issueNumber}...`);
  const issue = await getIssue(token, owner, repo, parseInt(issueNumber, 10));
  const slug = slugify(issue.title);
  const featureDir = `docs/features/${slug}`;
  const filePath = `${featureDir}/plan.md`;

  console.log(`Gerando plan.md para: ${issue.title}`);
  const content = await generateDocument(
    SYSTEM_PROMPT,
    `Feature: ${issue.title}\n\nDescrição:\n${issue.body || '(sem descrição)'}`
  );

  mkdirSync(featureDir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');

  // Commit and push
  const git = (cmd) => execSync(cmd, { stdio: 'inherit' });
  git(`git config user.email "spec-wave[bot]@github.com"`);
  git(`git config user.name "spec-wave[bot]"`);
  git(`git add "${filePath}"`);
  git(`git commit -m "docs: generate plan.md for ${slug} [spec-wave]"`);
  git('git push');

  // Remove trigger label
  await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:plan');

  // Comment on issue
  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `📋 **plan.md gerado automaticamente!**\n\n` +
    `📄 Arquivo: [\`${filePath}\`](${filePath})\n\n` +
    `Revise o plano e, quando estiver pronto, mova o card para a coluna **📋 Spec** ou use:\n` +
    `\`\`\`\ngh issue edit ${issueNumber} --add-label "spec-wave:spec"\n\`\`\``
  );

  console.log(`plan.md criado em: ${filePath}`);
}
