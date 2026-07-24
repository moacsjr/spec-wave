import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, addLabel, commentOnIssue } from '../api/github-rest.mjs';
import { slugify } from '../lib/slugify.mjs';
import { CONFIG_FILE, LABEL_CRITIQUE_FAILED, REQUIRED_PLAN_SECTIONS, REQUIRED_SPEC_SECTIONS } from '../config.mjs';

export async function validate({ issueNumber }) {
  const token = await resolveToken();
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  let cfg = {};
  try { if (existsSync(configPath)) cfg = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
  const owner = envOwner || cfg.owner;
  const repo = envRepo || cfg.repo;

  if (!owner || !repo) {
    throw new Error(
      'Não foi possível determinar owner/repo.\n' +
      'Defina GITHUB_REPOSITORY=owner/repo ou rode o comando dentro de um repositório com .spec-wave.json.'
    );
  }

  const issue = await getIssue(token, owner, repo, parseInt(issueNumber, 10));
  const slug = slugify(issue.title);
  const featureDir = `docs/features/${slug}`;

  const errors = [];

  // Bloqueio da crítica adversarial: enquanto a label critique-failed estiver
  // na issue, o ready não é liberado — a correção dos documentos é manual.
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const critiqueFailed = labelNames.includes(LABEL_CRITIQUE_FAILED);
  if (critiqueFailed) {
    errors.push(
      '🔎 A crítica adversarial apontou contradições GRAVES (veja o comentário na issue). ' +
      `Corrija os documentos e remova a label \`${LABEL_CRITIQUE_FAILED}\` para liberar o ready.`
    );
  }

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
    // Quando a ÚNICA falha é a da crítica adversarial, os documentos existem e
    // estão estruturalmente válidos — só precisam de correção manual. Nesse
    // caso NÃO devolvemos a feature para a etapa de spec (spec-wave:spec).
    const onlyCritiqueFailed = critiqueFailed && errors.length === 1;
    if (!onlyCritiqueFailed) {
      // Send back to spec stage
      await addLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:spec');
    }
    console.error('Validação falhou:', errors.join(', '));
    process.exit(1);
  }

  // Validação passou: adiciona label plan-approved.
  await addLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:plan-approved');

  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `✅ **Validação concluída com sucesso!**\n\n` +
    `- [\`${specPath}\`](${specPath}) ✓\n` +
    `- [\`${planPath}\`](${planPath}) ✓\n\n` +
    `A Feature está pronta para decomposição. Use:\n` +
    `\`\`\`\ngh issue edit ${issueNumber} --add-label "spec-wave:decompose"\n\`\`\``
  );

  console.log('Validação OK. Feature pronta para decomposição.');
}
