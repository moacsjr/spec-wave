import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, addLabel, commentOnIssue } from '../api/github-rest.mjs';
import { addProjectItem, setItemSingleSelect, getSingleSelectField } from '../api/github-graphql.mjs';
import { slugify } from '../lib/slugify.mjs';
import { CONFIG_FILE, REQUIRED_PLAN_SECTIONS, REQUIRED_SPEC_SECTIONS } from '../config.mjs';

// Opção nativa do campo Status do GitHub Projects (Todo / In Progress / Done).
const DONE_STAGE = 'Done';

// Resolve um campo SINGLE_SELECT pelo nome: usa o .spec-wave.json, cai para o
// formato legado (etapaFieldId/stageOptions) e, por fim, consulta o Project.
async function resolveField(token, project, name) {
  if (project.fields && project.fields[name]) return project.fields[name];
  if (name === 'Etapa' && project.etapaFieldId) {
    return { id: project.etapaFieldId, options: project.stageOptions || {} };
  }
  return await getSingleSelectField(token, project.id, name);
}

// Move o item da issue para a Etapa "🎉 Done" no board. Best-effort: loga e
// segue se o .spec-wave.json não tiver o Project ou o campo não for encontrado.
async function moveToDone(token, issue) {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.warn(`${CONFIG_FILE} não encontrado — status do board não atualizado.`);
    return;
  }
  let project;
  try {
    project = (JSON.parse(readFileSync(configPath, 'utf-8')).project) || {};
  } catch (err) {
    console.warn(`${CONFIG_FILE} corrompido (${err.message}) — status do board não atualizado.`);
    return;
  }
  if (!project.id) {
    console.warn(`Project não configurado no ${CONFIG_FILE} — status do board não atualizado.`);
    return;
  }
  // addProjectItem é idempotente: retorna o item existente se a issue já está no board.
  const itemId = await addProjectItem(token, project.id, issue.node_id);
  const field = await resolveField(token, project, 'Status');
  const optionId = field?.options?.[DONE_STAGE];
  if (field?.id && optionId) {
    await setItemSingleSelect(token, project.id, itemId, field.id, optionId);
    console.log(`Status do board atualizado para "${DONE_STAGE}".`);
  } else {
    console.warn(`Etapa "${DONE_STAGE}" não encontrada no Project — status do board não atualizado.`);
  }
}

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

  // Validação passou: move a issue para "🎉 Done" no board (best-effort).
  let doneOk = false;
  try {
    await moveToDone(token, issue);
    doneOk = !!DONE_STAGE;
  } catch (err) {
    console.warn(`Falha ao atualizar status do board: ${err.message}`);
  }

  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `✅ **Validação concluída com sucesso!**\n\n` +
    `- [\`${specPath}\`](${specPath}) ✓\n` +
    `- [\`${planPath}\`](${planPath}) ✓\n\n` +
    (doneOk ? `Status movido para **${DONE_STAGE}**. ` : '') +
    `A Feature está pronta para decomposição. Use:\n` +
    `\`\`\`\ngh issue edit ${issueNumber} --add-label "spec-wave:decompose"\n\`\`\``
  );

  console.log('Validação OK. Feature pronta para decomposição.');
}
