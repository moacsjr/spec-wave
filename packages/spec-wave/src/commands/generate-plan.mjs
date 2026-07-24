import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, addLabel, commentOnIssue } from '../api/github-rest.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { allowsSpecPlan, SPEC_PLAN_EXCLUDED_TYPES, TARGET_LANGUAGE, LABEL_CRITIQUE_FAILED } from '../config.mjs';
import { generateDocument } from '../lib/claude.mjs';
import { runCritique } from '../lib/critique.mjs';
import { slugify } from '../lib/slugify.mjs';
import { buildTechContext } from '../lib/tech-context.mjs';

// Aviso anexado ao comentário quando o lint de idioma ainda reprova após o
// retry automático do generateDocument (excertos ao redor de cada vazamento).
function formatLintWarning(lintFindings) {
  if (!lintFindings || lintFindings.length === 0) return '';
  const excerpts = lintFindings
    .slice(0, 5)
    .map(f => `\`${f.excerpt.replace(/\s+/g, ' ').trim()}\``)
    .join(', ');
  return `\n\n⚠️ possíveis artefatos de idioma no documento: ${excerpts}`;
}

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

  // plan.md é artefato de Feature — não se aplica a Spike/RFC/Bug.
  const type = detectIssueType(issue);
  if (!allowsSpecPlan(type)) {
    console.log(`Issue #${issueNumber} é ${type}: plan.md não é gerado para ${SPEC_PLAN_EXCLUDED_TYPES.join('/')}.`);
    await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:plan');
    await commentOnIssue(
      token, owner, repo, parseInt(issueNumber, 10),
      `ℹ️ **plan.md não gerado:** o tipo **${type}** não usa spec/plan no fluxo spec-wave ` +
      `(esses artefatos são exclusivos de Features). Nenhum arquivo foi criado.`
    ).catch(() => {});
    return;
  }

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
  const { content, lintFindings } = await generateDocument(SYSTEM_PROMPT, userContent, {
    action: 'plan',
    lint: { lang: TARGET_LANGUAGE },
    withReport: true,
  });

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
    `\`\`\`\ngh issue edit ${issueNumber} --add-label "spec-wave:ready"\n\`\`\`` +
    formatLintWarning(lintFindings)
  );

  // Crítica adversarial: audita o plan recém-comitado contra spec +
  // tech_context. NUNCA desfaz o plan — falha da crítica vira só um aviso.
  try {
    const critique = await runCritique({
      kind: 'plan',
      spec: specContent,
      plan: content,
      techContextYaml: tech.yaml,
    });
    await commentOnIssue(token, owner, repo, parseInt(issueNumber, 10), critique.markdown);
    if (critique.grave) {
      await addLabel(token, owner, repo, parseInt(issueNumber, 10), LABEL_CRITIQUE_FAILED);
      console.log(`Crítica adversarial apontou findings GRAVES — label ${LABEL_CRITIQUE_FAILED} aplicada.`);
    }
  } catch (err) {
    console.warn(`Crítica adversarial indisponível: ${err.message}`);
    await commentOnIssue(
      token, owner, repo, parseInt(issueNumber, 10),
      `⚠️ crítica adversarial indisponível (erro: ${err.message})`
    ).catch(() => {});
  }

  console.log(`plan.md criado em: ${filePath}`);
}
