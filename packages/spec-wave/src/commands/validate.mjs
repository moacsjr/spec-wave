import { existsSync, readFileSync } from 'node:fs';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, addLabel, commentOnIssue } from '../api/github-rest.mjs';
import { slugify } from '../lib/slugify.mjs';
import { REQUIRED_PLAN_SECTIONS, REQUIRED_SPEC_SECTIONS } from '../config.mjs';

export async function validate({ issueNumber }) {
  const token = await resolveToken();
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');

  if (!owner || !repo) {
    throw new Error(
      'GITHUB_REPOSITORY env var não definida.\n' +
      'Este comando roda no GitHub Actions. Para testar localmente:\n' +
      '  GITHUB_REPOSITORY=owner/repo spec-wave validate --issue-number 1'
    );
  }

  const issue = await getIssue(token, owner, repo, parseInt(issueNumber, 10));
  const slug = slugify(issue.title);
  const featureDir = `docs/features/${slug}`;

  const errors = [];

  // Check plan.md
  const planPath = `${featureDir}/plan.md`;
  if (!existsSync(planPath)) {
    errors.push('❌ `plan.md` não encontrado em `' + planPath + '`');
  } else {
    const planContent = readFileSync(planPath, 'utf-8');
    for (const section of REQUIRED_PLAN_SECTIONS) {
      if (!planContent.includes(`# ${section}`)) {
        errors.push(`❌ Seção obrigatória ausente no plan.md: **${section}**`);
      }
    }
  }

  // Check spec.md
  const specPath = `${featureDir}/spec.md`;
  if (!existsSync(specPath)) {
    errors.push('❌ `spec.md` não encontrado em `' + specPath + '`');
  } else {
    const specContent = readFileSync(specPath, 'utf-8');
    for (const section of REQUIRED_SPEC_SECTIONS) {
      if (!specContent.includes(`# ${section}`)) {
        errors.push(`❌ Seção obrigatória ausente no spec.md: **${section}**`);
      }
    }
  }

  // Remove trigger label
  await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:ready');

  if (errors.length > 0) {
    await commentOnIssue(
      token, owner, repo, parseInt(issueNumber, 10),
      `⚠️ **Validação falhou — Feature não está pronta.**\n\n` +
      errors.join('\n') +
      `\n\nCorreija os problemas e adicione novamente a label \`spec-wave:ready\`.`
    );
    // Send back to spec stage
    await addLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:spec');
    console.error('Validação falhou:', errors.join(', '));
    process.exit(1);
  }

  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `✅ **Validação concluída com sucesso!**\n\n` +
    `- [\`${planPath}\`](${planPath}) ✓\n` +
    `- [\`${specPath}\`](${specPath}) ✓\n\n` +
    `A Feature está pronta para decomposição. Mova o card para **📋 Backlog Técnico** ou use:\n` +
    `\`\`\`\ngh issue edit ${issueNumber} --add-label "spec-wave:decompose"\n\`\`\``
  );

  console.log('Validação OK. Feature pronta para decomposição.');
}
