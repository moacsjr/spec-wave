import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveToken } from '../api/auth.mjs';
import { getIssue, removeLabel, commentOnIssue } from '../api/github-rest.mjs';
import { generateDocument } from '../lib/claude.mjs';
import { slugify } from '../lib/slugify.mjs';

const SYSTEM_PROMPT = `Você é um Tech Lead experiente em decomposição de trabalho ágil.
A partir da Feature fornecida (com spec.md e plan.md), gere uma lista de Stories e Tasks.

Responda APENAS com JSON válido neste formato:
{
  "stories": [
    {
      "title": "[STORY] Título da story no formato 'Como <perfil>, quero <objetivo>, para <benefício>'",
      "body": "Descrição da story com contexto e critérios de aceite relevantes",
      "tasks": [
        {
          "title": "[TASK] Título técnico da task",
          "body": "Descrição técnica detalhada"
        }
      ]
    }
  ]
}

Regras:
- Cada Story deve ter 2–5 Tasks associadas
- Stories devem seguir o formato de User Story
- Tasks devem ser atividades técnicas concretas
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

  const created = [];

  for (const story of decomposition.stories) {
    console.log(`Criando story: ${story.title}`);
    const storyOutput = execFileSync(
      'gh',
      ['issue', 'create', '--title', story.title, '--body', story.body, '--label', '[STORY]'],
      { encoding: 'utf-8' }
    ).trim();
    const storyUrl = storyOutput.trim();
    created.push({ type: 'story', title: story.title, url: storyUrl });

    for (const task of story.tasks || []) {
      console.log(`  Criando task: ${task.title}`);
      const taskBody = `${task.body}\n\n_Story pai: ${storyUrl}_`;
      execFileSync(
        'gh',
        ['issue', 'create', '--title', task.title, '--body', taskBody, '--label', '[TASK]'],
        { encoding: 'utf-8' }
      );
    }
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
