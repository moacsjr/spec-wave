import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, commentOnIssue } from '../api/github-rest.mjs';
import { generateDocument } from '../lib/claude.mjs';
import { slugify } from '../lib/slugify.mjs';
import { buildTechContext } from '../lib/tech-context.mjs';

const SYSTEM_PROMPT = `Você é um Tech Lead experiente. Gere um plano técnico (plan.md) completo e detalhado, baseado ESTRITAMENTE no spec.md fornecido.

O plano deve conter EXATAMENTE estas seções em português, nesta ordem:
# Estratégia Técnica
  - Abordagem Arquitetural, Decisões-Chave e uma Matriz de Rastreabilidade (tabela) ligando cada Critério de Aceite do spec a um componente técnico.
# Detalhamento da Implementação
  - Subseções: ## Backend, ## Banco de Dados, ## Frontend, ## Infraestrutura.
# Segurança e Conformidade
# Estratégia de Testes
  - Unitários, Integração e E2E.
# Rollback e Monitoramento
  - Plano de Rollback, Métricas Observadas e Alertas.

Regras OBRIGATÓRIAS:
- TODA mudança de banco, endpoint de API ou componente de UI DEVE referenciar um Critério de Aceite específico do spec.md (rastreabilidade).
- Use APENAS as tecnologias e serviços listados no tech_context fornecido. Não invente APIs ou serviços inexistentes.
- Forneça detalhes acionáveis: caminhos exatos de endpoints, nomes de DTOs, constraints de banco.
- Responda APENAS com o conteúdo do plan.md, sem texto adicional.`;

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

  // Read existing spec.md if available (spec é gerada antes do plano)
  const specPath = `${featureDir}/spec.md`;
  const specContent = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : null;

  // Tech context (RFC-002 §4): estático + dinâmico + override do corpo da issue.
  const tech = buildTechContext({ issueBody: issue.body || '' });

  // Payload estruturado (RFC-002 §5.2): spec_content + tech_context.
  const payload = {
    spec_content: specContent || '(spec.md ainda não gerado — baseie-se na descrição da Feature)',
    feature_title: issue.title,
    feature_description: issue.body || '(sem descrição)',
    tech_context: {
      static: tech.merged,
      dynamic: tech.dynamic,
      overrides: tech.overrides,
    },
  };
  const userContent = `Gere o plan.md a partir deste payload JSON:\n\n${JSON.stringify(payload, null, 2)}`;

  console.log(`Gerando plan.md para: ${issue.title}`);
  const content = await generateDocument(SYSTEM_PROMPT, userContent);

  mkdirSync(featureDir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');

  // Commit and push
  const git = (cmd) => execSync(cmd, { stdio: 'inherit' });
  git(`git config user.email "spec-wave[bot]@github.com"`);
  git(`git config user.name "spec-wave[bot]"`);
  git(`git add "${filePath}"`);
  git(`git commit -m "docs: generate plan.md for ${slug} [spec-wave]"`);
  git('git pull --rebase');
  git('git push');

  // Remove trigger label
  await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:plan');

  // Comment on issue
  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `📋 **plan.md gerado automaticamente!**\n\n` +
    `📄 Arquivo: [\`${filePath}\`](https://github.com/${owner}/${repo}/blob/main/${filePath})\n\n` +
    `Revise o plano e, quando estiver pronto, valide a Feature: mova o card para **✅ Ready** ou use:\n` +
    `\`\`\`\ngh issue edit ${issueNumber} --add-label "spec-wave:ready"\n\`\`\``
  );

  console.log(`plan.md criado em: ${filePath}`);
}
