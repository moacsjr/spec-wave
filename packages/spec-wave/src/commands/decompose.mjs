import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, createIssue, removeLabel, commentOnIssue } from '../api/github-rest.mjs';
import { addSubIssue, addProjectItem, setItemSingleSelect, getSingleSelectField } from '../api/github-graphql.mjs';
import { generateDocument } from '../lib/claude.mjs';
import { slugify } from '../lib/slugify.mjs';
import { CONFIG_FILE } from '../config.mjs';

const READY_STAGE = 'Todo';

// Carrega o projeto do .spec-wave.json. Retorna null se ausente ou sem project.id.
function loadProject() {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')).project || null;
  } catch {
    return null;
  }
}

// Resolve o campo Status do Project: usa .spec-wave.json ou consulta API.
async function resolveStatusField(token, project) {
  if (project.fields?.Status) return project.fields.Status;
  return await getSingleSelectField(token, project.id, 'Status');
}

// Adiciona issue ao board e move para a etapa informada. Best-effort.
async function moveToStage(token, project, statusField, nodeId, stageName) {
  if (!project?.id || !statusField) return;
  const optionId = statusField.options?.[stageName];
  if (!statusField.id || !optionId) return;
  const itemId = await addProjectItem(token, project.id, nodeId);
  await setItemSingleSelect(token, project.id, itemId, statusField.id, optionId);
}

const SYSTEM_PROMPT = `Você é um Tech Lead experiente em decomposição de trabalho ágil.
A partir da Feature fornecida (com spec.md e plan.md), gere uma lista de Stories e Tasks.

Responda APENAS com JSON válido neste formato:
{
  "stories": [
    {
      "title": "Título curto da story (apenas a parte 'quero', sem prefixo)",
      "userStory": "Como <perfil>, quero <objetivo>, para <benefício>",
      "body": "Descrição complementar da story com contexto e critérios de aceite relevantes",
      "tasks": [
        {
          "title": "Título técnico curto da task (sem prefixo)",
          "body": "Descrição técnica detalhada"
        }
      ]
    }
  ]
}

Regras:
- "title" deve ser CURTO (máx. ~60 caracteres): apenas a parte "quero" da user story, sem o "Como" nem o "para", e sem prefixo. Ex.: "visualizar meus repositórios em layout responsivo"
- "userStory" deve trazer a user story completa no formato "Como <perfil>, quero <objetivo>, para <benefício>"
- "body" é texto complementar (contexto, critérios de aceite); não repita o título
- Cada Story deve ter 2–5 Tasks associadas
- Tasks devem ser atividades técnicas concretas, com "title" curto e "body" detalhado
- Gere entre 3 e 7 Stories por Feature`;

export async function decompose({ issueNumber }) {
  const token = await resolveToken();
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');

  if (!owner || !repo) {
    throw new Error(
      'GITHUB_REPOSITORY env var não definida.\n' +
      'Este comando roda no GitHub Actions. Para testar localmente:\n' +
      '  GITHUB_REPOSITORY=owner/repo spec-wave decompose --issue-number 1'
    );
  }

  const issue = await getIssue(token, owner, repo, parseInt(issueNumber, 10));
  const slug = slugify(issue.title);

  // Carrega projeto e resolve campo Status uma vez (reutilizado em todos os itens).
  const project = loadProject();
  let statusField = null;
  if (project?.id && READY_STAGE) {
    try {
      statusField = await resolveStatusField(token, project);
    } catch (err) {
      console.warn(`Não foi possível resolver campo Status do board: ${err.message}`);
    }
  }
  const featureDir = `docs/features/${slug}`;

  const planContent = existsSync(`${featureDir}/plan.md`)
    ? readFileSync(`${featureDir}/plan.md`, 'utf-8')
    : '(plan.md não encontrado)';

  const specContent = existsSync(`${featureDir}/spec.md`)
    ? readFileSync(`${featureDir}/spec.md`, 'utf-8')
    : '(spec.md não encontrado)';

  console.log(`Decompondo feature: ${issue.title}`);

  const userContent = [
    `Feature: ${issue.title}`,
    `Issue #${issueNumber}`,
    `\n## spec.md\n${specContent}`,
    `\n## plan.md\n${planContent}`,
  ].join('\n');

  const raw = await generateDocument(SYSTEM_PROMPT, userContent);

  let decomposition;
  try {
    decomposition = JSON.parse(raw);
  } catch {
    // Try to extract JSON from the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return valid JSON');
    decomposition = JSON.parse(jsonMatch[0]);
  }

  // node id da Feature — necessário para vincular as stories como sub-issues.
  const featureNodeId = issue.node_id;

  const created = [];

  for (const story of decomposition.stories) {
    console.log(`Criando story: ${story.title}`);
    const storyTitle = `[STORY] ${story.title}`;
    // Corpo: user story completa (Como/quero/para) + texto complementar.
    const storyBody = [story.userStory, story.body]
      .map(s => (s || '').trim())
      .filter(Boolean)
      .join('\n\n') || '_(sem descrição)_';
    const createdStory = await createIssue(token, owner, repo, storyTitle, storyBody, ['[STORY]']);
    created.push({ type: 'story', title: storyTitle, url: createdStory.url });

    // Vincula a story como sub-issue da Feature (relação nativa do GitHub).
    try {
      await addSubIssue(token, featureNodeId, createdStory.nodeId);
    } catch (err) {
      console.warn(`  Story #${createdStory.number} criada, mas falhou ao vincular à Feature: ${err.message}`);
    }

    // Move story para Ready no board.
    try {
      await moveToStage(token, project, statusField, createdStory.nodeId, READY_STAGE);
    } catch (err) {
      console.warn(`  Falha ao mover story #${createdStory.number} para "${READY_STAGE}": ${err.message}`);
    }

    for (const task of story.tasks || []) {
      console.log(`  Criando task: ${task.title}`);
      const taskTitle = `[TASK] ${task.title}`;
      const taskBody = `${task.body}\n\n_Story pai: ${createdStory.url}_`;
      const createdTask = await createIssue(token, owner, repo, taskTitle, taskBody, ['[TASK]']);

      // Vincula a task como sub-issue da Story.
      try {
        await addSubIssue(token, createdStory.nodeId, createdTask.nodeId);
      } catch (err) {
        console.warn(`    Task #${createdTask.number} criada, mas falhou ao vincular à Story: ${err.message}`);
      }

      // Move task para Ready no board.
      try {
        await moveToStage(token, project, statusField, createdTask.nodeId, READY_STAGE);
      } catch (err) {
        console.warn(`    Falha ao mover task #${createdTask.number} para "${READY_STAGE}": ${err.message}`);
      }
    }
  }

  // Move a própria Feature para Ready no board.
  try {
    await moveToStage(token, project, statusField, featureNodeId, READY_STAGE);
    if (project?.id && statusField) console.log(`Feature movida para "${READY_STAGE}" no board.`);
  } catch (err) {
    console.warn(`Falha ao mover Feature para "${READY_STAGE}": ${err.message}`);
  }

  // Remove trigger label
  await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:decompose');

  const storyList = created.map(s => `- ${s.url} — ${s.title}`).join('\n');
  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `🔀 **Decomposição concluída!**\n\n` +
    `Foram criados ${decomposition.stories.length} stories e suas tasks:\n\n${storyList}\n\n` +
    `Mova o card para **📋 Backlog Técnico** para iniciar o desenvolvimento.`
  );

  console.log(`Decomposição concluída: ${decomposition.stories.length} stories criadas.`);
}
