import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, createIssue, removeLabel, addLabel, commentOnIssue, addBlockedBy } from '../api/github-rest.mjs';
import { addSubIssue, addProjectItem, setItemSingleSelect, getSingleSelectField, listSubIssues } from '../api/github-graphql.mjs';
import { generateDocument } from '../lib/claude.mjs';
import { runCritique } from '../lib/critique.mjs';
import { formatDependencyLine } from '../lib/dependencies.mjs';
import { lintLanguage } from '../lib/output-lint.mjs';
import { slugify } from '../lib/slugify.mjs';
import { detectIssueType } from '../lib/issue-type.mjs';
import { CONFIG_FILE, DECOMPOSE_TARGETS, LABEL_DECOMPOSED, LABEL_CRITIQUE_FAILED, TARGET_LANGUAGE } from '../config.mjs';

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

// Extrai JSON da resposta do modelo (tolera texto em volta).
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return valid JSON');
    return JSON.parse(jsonMatch[0]);
  }
}

// Prefixo de título das sub-issues geradas por cada tipo decompoível.
const CHILD_PREFIX = { Feature: '[STORY]', RFC: '[TASK]' };

/**
 * Guard de idempotência do decompose (função PURA — testável).
 *
 * Skip se a issue já foi decomposta: label `spec-wave:decomposed` presente OU
 * sub-issues já contêm um item do tipo-alvo (Feature → algum `[STORY]` no
 * título; RFC → algum `[TASK]`). Sub-issues de outro tipo não contam.
 *
 * @param {object} params
 * @param {Array<string|{name: string}>} [params.labels] labels da issue
 * @param {Array<{ number?: number, title?: string }>} [params.subIssues] sub-issues existentes
 * @param {string} params.type tipo da issue ('Feature' | 'RFC')
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipDecompose({ labels = [], subIssues = [], type } = {}) {
  const names = labels
    .map(l => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean);
  if (names.includes(LABEL_DECOMPOSED)) {
    return { skip: true, reason: `a issue já tem a label \`${LABEL_DECOMPOSED}\`` };
  }

  const prefix = CHILD_PREFIX[type];
  if (prefix) {
    const existing = subIssues.find(s => (s.title || '').includes(prefix));
    if (existing) {
      const ref = existing.number ? ` (ex.: #${existing.number} — ${existing.title})` : '';
      return { skip: true, reason: `a issue já tem sub-issues \`${prefix}\`${ref}` };
    }
  }

  return { skip: false, reason: '' };
}

// Lint de idioma sobre títulos+corpos gerados; retorna aviso pronto para
// anexar ao comentário final ('' se limpo).
function formatItemsLintWarning(texts) {
  const result = lintLanguage(texts.join('\n\n'), { lang: TARGET_LANGUAGE });
  if (result.ok) return '';
  const excerpts = result.findings
    .slice(0, 5)
    .map(f => `\`${f.excerpt.replace(/\s+/g, ' ').trim()}\``)
    .join(', ');
  return `\n\n⚠️ possíveis artefatos de idioma nos itens gerados: ${excerpts}`;
}

const FEATURE_SYSTEM_PROMPT = `Você é um Tech Lead experiente em decomposição de trabalho ágil.
A partir da Feature fornecida (com spec.md e plan.md), gere uma lista de Stories e Tasks.

Responda APENAS com JSON válido neste formato:
{
  "stories": [
    {
      "title": "Título curto da story (apenas a parte 'quero', sem prefixo)",
      "userStory": "Como <perfil>, quero <objetivo>, para <benefício>",
      "body": "Descrição complementar da story com contexto e critérios de aceite relevantes",
      "dependsOn": [0],
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
- Gere entre 3 e 7 Stories por Feature
- Ordene as stories na sequência de implementação — a ORDEM da lista importa
- "dependsOn" (opcional): índices 0-based das stories ANTERIORES na lista das quais esta story depende. Referencie apenas índices menores que o da própria story. Use [] quando a story puder ser feita em paralelo (sem dependências); se omitido, assume-se dependência da story anterior (sequencial)`;

const RFC_SYSTEM_PROMPT = `Você é um Tech Lead experiente. A partir do RFC fornecido (proposta técnica/de processo), gere a lista de Tasks técnicas concretas necessárias para implementá-lo.

Responda APENAS com JSON válido neste formato:
{
  "tasks": [
    {
      "title": "Título técnico curto da task (sem prefixo)",
      "body": "Descrição técnica detalhada (o que fazer, áreas/arquivos afetados, critério de pronto)"
    }
  ]
}

Regras:
- "title" CURTO (máx. ~60 caracteres), sem prefixo.
- "body" detalhado e acionável.
- Gere entre 3 e 10 Tasks concretas que, juntas, cubram o RFC.`;

// Decompõe uma Feature em Stories (+ Tasks), cada uma vinculada como sub-issue.
async function decomposeFeature(ctx) {
  const { token, projectToken, owner, repo, issue, issueNumber, project, statusField } = ctx;
  const slug = slugify(issue.title);
  const featureDir = `docs/features/${slug}`;

  const planContent = existsSync(`${featureDir}/plan.md`)
    ? readFileSync(`${featureDir}/plan.md`, 'utf-8')
    : '(plan.md não encontrado)';
  const specContent = existsSync(`${featureDir}/spec.md`)
    ? readFileSync(`${featureDir}/spec.md`, 'utf-8')
    : '(spec.md não encontrado)';

  console.log(`Decompondo Feature: ${issue.title}`);
  const userContent = [
    `Feature: ${issue.title}`,
    `Issue #${issueNumber}`,
    `\n## spec.md\n${specContent}`,
    `\n## plan.md\n${planContent}`,
  ].join('\n');

  const decomposition = parseJson(await generateDocument(FEATURE_SYSTEM_PROMPT, userContent));

  // Crítica adversarial ANTES de criar qualquer issue: stories que contradizem
  // a spec/plan não devem virar trabalho. Crítica indisponível → só avisa.
  let critique = null;
  try {
    critique = await runCritique({
      kind: 'stories',
      spec: existsSync(`${featureDir}/spec.md`) ? specContent : null,
      plan: existsSync(`${featureDir}/plan.md`) ? planContent : null,
      stories: decomposition.stories,
    });
  } catch (err) {
    console.warn(`Crítica adversarial indisponível: ${err.message}`);
    await commentOnIssue(
      token, owner, repo, parseInt(issueNumber, 10),
      `⚠️ crítica adversarial indisponível (erro: ${err.message}) — prosseguindo com a decomposição.`
    ).catch(() => {});
  }
  if (critique) {
    await commentOnIssue(token, owner, repo, parseInt(issueNumber, 10), critique.markdown)
      .catch(err => console.warn(`Falha ao comentar a crítica: ${err.message}`));
    if (critique.grave) {
      console.log('Crítica adversarial apontou findings GRAVES — nenhuma story foi criada.');
      await addLabel(token, owner, repo, parseInt(issueNumber, 10), LABEL_CRITIQUE_FAILED);
      await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:decompose');
      return;
    }
  }

  const featureNodeId = issue.node_id;
  const created = [];
  const createdStories = []; // issues criadas, na ordem dos índices das stories
  const generatedTexts = []; // títulos+corpos para o lint de idioma final

  for (let i = 0; i < decomposition.stories.length; i++) {
    const story = decomposition.stories[i];
    console.log(`Criando story: ${story.title}`);
    const storyTitle = `[STORY] ${story.title}`;
    let storyBody = [story.userStory, story.body]
      .map(s => (s || '').trim())
      .filter(Boolean)
      .join('\n\n') || '_(sem descrição)_';

    // Dependências: índices 0-based de stories anteriores. Default quando o
    // campo está ausente: sequencial (story i depende da i-1). [] explícito =
    // sem dependências. Índices inválidos/futuros são ignorados.
    const depIndexes = Array.isArray(story.dependsOn)
      ? [...new Set(story.dependsOn.filter(d => Number.isInteger(d) && d >= 0 && d < i))]
      : (i > 0 ? [i - 1] : []);
    const depIssues = depIndexes.map(idx => createdStories[idx]).filter(Boolean);
    const depLine = formatDependencyLine(depIssues.map(d => d.number));
    if (depLine) storyBody += `\n\n${depLine}`;

    const createdStory = await createIssue(token, owner, repo, storyTitle, storyBody, ['[STORY]']);
    created.push({ title: storyTitle, url: createdStory.url });
    createdStories.push(createdStory);
    generatedTexts.push(storyTitle, storyBody);

    // Relação nativa blocked_by (best-effort — a linha "Depende de" já basta).
    for (const dep of depIssues) {
      try {
        await addBlockedBy(token, owner, repo, createdStory.number, dep.id);
      } catch (err) {
        console.warn(`  Falha ao marcar story #${createdStory.number} como bloqueada por #${dep.number}: ${err.message}`);
      }
    }

    try {
      await addSubIssue(token, featureNodeId, createdStory.nodeId);
    } catch (err) {
      console.warn(`  Story #${createdStory.number} criada, mas falhou ao vincular à Feature: ${err.message}`);
    }
    try {
      await moveToStage(projectToken, project, statusField, createdStory.nodeId, READY_STAGE);
    } catch (err) {
      console.warn(`  Falha ao mover story #${createdStory.number} para "${READY_STAGE}": ${err.message}`);
    }

    for (const task of story.tasks || []) {
      console.log(`  Criando task: ${task.title}`);
      const taskTitle = `[TASK] ${task.title}`;
      const taskBody = `${task.body}\n\n_Story pai: ${createdStory.url}_`;
      const createdTask = await createIssue(token, owner, repo, taskTitle, taskBody, ['[TASK]']);
      generatedTexts.push(taskTitle, taskBody);
      try {
        await addSubIssue(token, createdStory.nodeId, createdTask.nodeId);
      } catch (err) {
        console.warn(`    Task #${createdTask.number} criada, mas falhou ao vincular à Story: ${err.message}`);
      }
      try {
        await moveToStage(projectToken, project, statusField, createdTask.nodeId, READY_STAGE);
      } catch (err) {
        console.warn(`    Falha ao mover task #${createdTask.number} para "${READY_STAGE}": ${err.message}`);
      }
    }
  }

  try {
    await moveToStage(projectToken, project, statusField, featureNodeId, READY_STAGE);
    if (project?.id && statusField) console.log(`Feature movida para "${READY_STAGE}" no board.`);
  } catch (err) {
    console.warn(`Falha ao mover Feature para "${READY_STAGE}": ${err.message}`);
  }

  // Marca a Feature como decomposta (guard de idempotência em runs futuros).
  try {
    await addLabel(token, owner, repo, parseInt(issueNumber, 10), LABEL_DECOMPOSED);
  } catch (err) {
    console.warn(`Falha ao aplicar a label ${LABEL_DECOMPOSED}: ${err.message}`);
  }
  await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:decompose');
  const list = created.map(s => `- ${s.url} — ${s.title}`).join('\n');
  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `🔀 **Decomposição concluída!**\n\n` +
    `Foram criados ${decomposition.stories.length} stories e suas tasks:\n\n${list}\n\n` +
    `Mova o card para **📋 Backlog Técnico** para iniciar o desenvolvimento.` +
    formatItemsLintWarning(generatedTexts)
  );
  console.log(`Decomposição concluída: ${decomposition.stories.length} stories criadas.`);
}

// Decompõe um RFC diretamente em Tasks (sem Stories), cada uma vinculada como
// sub-issue do RFC.
async function decomposeRFC(ctx) {
  const { token, projectToken, owner, repo, issue, issueNumber, project, statusField } = ctx;
  console.log(`Decompondo RFC: ${issue.title}`);

  const userContent = [
    `RFC: ${issue.title}`,
    `Issue #${issueNumber}`,
    `\n## Descrição\n${issue.body || '(sem descrição)'}`,
  ].join('\n');

  const decomposition = parseJson(await generateDocument(RFC_SYSTEM_PROMPT, userContent));
  const rfcNodeId = issue.node_id;
  const tasks = decomposition.tasks || [];
  const created = [];
  const generatedTexts = []; // títulos+corpos para o lint de idioma final

  for (const task of tasks) {
    console.log(`Criando task: ${task.title}`);
    const taskTitle = `[TASK] ${task.title}`;
    const taskBody = `${task.body}\n\n_RFC pai: ${issue.html_url || `#${issueNumber}`}_`;
    const createdTask = await createIssue(token, owner, repo, taskTitle, taskBody, ['[TASK]']);
    created.push({ title: taskTitle, url: createdTask.url });
    generatedTexts.push(taskTitle, taskBody);

    try {
      await addSubIssue(token, rfcNodeId, createdTask.nodeId);
    } catch (err) {
      console.warn(`  Task #${createdTask.number} criada, mas falhou ao vincular ao RFC: ${err.message}`);
    }
    try {
      await moveToStage(projectToken, project, statusField, createdTask.nodeId, READY_STAGE);
    } catch (err) {
      console.warn(`  Falha ao mover task #${createdTask.number} para "${READY_STAGE}": ${err.message}`);
    }
  }

  // Marca o RFC como decomposto (guard de idempotência em runs futuros).
  try {
    await addLabel(token, owner, repo, parseInt(issueNumber, 10), LABEL_DECOMPOSED);
  } catch (err) {
    console.warn(`Falha ao aplicar a label ${LABEL_DECOMPOSED}: ${err.message}`);
  }
  await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:decompose');
  const list = created.map(t => `- ${t.url} — ${t.title}`).join('\n');
  await commentOnIssue(
    token, owner, repo, parseInt(issueNumber, 10),
    `🔀 **Decomposição do RFC concluída!**\n\n` +
    `Foram criadas ${created.length} tasks:\n\n${list}\n\n` +
    `Mova o card para **📋 Backlog Técnico** para iniciar o desenvolvimento.` +
    formatItemsLintWarning(generatedTexts)
  );
  console.log(`Decomposição concluída: ${created.length} tasks criadas.`);
}

export async function decompose({ issueNumber }) {
  const token = await resolveToken();
  // PROJECT_TOKEN deve ter scope "project" para atualizar GitHub Projects v2.
  // Fallback para GITHUB_TOKEN (só funciona em repos pessoais sem org restrictions).
  const projectToken = process.env.PROJECT_TOKEN || token;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');

  if (!owner || !repo) {
    throw new Error(
      'GITHUB_REPOSITORY env var não definida.\n' +
      'Este comando roda no GitHub Actions. Para testar localmente:\n' +
      '  GITHUB_REPOSITORY=owner/repo spec-wave decompose --issue-number 1'
    );
  }

  const issue = await getIssue(token, owner, repo, parseInt(issueNumber, 10));
  const type = detectIssueType(issue);

  // Só Feature (→ Stories) e RFC (→ Tasks) podem ser decompostos.
  if (!DECOMPOSE_TARGETS[type]) {
    console.log(`Issue #${issueNumber} é ${type || 'desconhecido'} — decompose não se aplica.`);
    await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:decompose');
    await commentOnIssue(
      token, owner, repo, parseInt(issueNumber, 10),
      `ℹ️ **decompose não se aplica a ${type || 'este tipo'}.** ` +
      `Use em **Features** (gera Stories + Tasks) ou **RFCs** (gera Tasks).`
    ).catch(() => {});
    return;
  }

  // Guard de idempotência: label spec-wave:decomposed ou sub-issues do
  // tipo-alvo já existentes → não re-decompõe (evita duplicar stories/tasks).
  let subIssues = [];
  try {
    subIssues = await listSubIssues(token, issue.node_id);
  } catch (err) {
    console.warn(`Não foi possível listar sub-issues: ${err.message} — seguindo sem o guard de sub-issues.`);
    subIssues = [];
  }
  const guard = shouldSkipDecompose({ labels: issue.labels || [], subIssues, type });
  if (guard.skip) {
    console.log(`Decompose ignorado: ${guard.reason}.`);
    await removeLabel(token, owner, repo, parseInt(issueNumber, 10), 'spec-wave:decompose');
    await commentOnIssue(
      token, owner, repo, parseInt(issueNumber, 10),
      `⏭️ **decompose ignorado:** ${guard.reason}. Para forçar, remova a label ` +
      `\`${LABEL_DECOMPOSED}\` (e apague as sub-issues antigas se quiser re-gerar).`
    ).catch(() => {});
    return;
  }

  // Projeto + campo Status (reutilizado em todos os itens).
  const project = loadProject();
  let statusField = null;
  if (project?.id) {
    try {
      statusField = await resolveStatusField(projectToken, project);
    } catch (err) {
      console.warn(`Não foi possível resolver campo Status do board: ${err.message}`);
    }
  }

  const ctx = { token, projectToken, owner, repo, issue, issueNumber, project, statusField };
  if (type === 'Feature') await decomposeFeature(ctx);
  else if (type === 'RFC') await decomposeRFC(ctx);
}
