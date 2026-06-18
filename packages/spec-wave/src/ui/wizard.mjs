import * as p from '@clack/prompts';
import { execSync } from 'node:child_process';

export async function runWizard() {
  p.intro('spec-wave — configuração do fluxo spec-driven');

  const answers = await p.group(
    {
      repo: () =>
        p.text({
          message: 'Repositório GitHub (owner/repo):',
          placeholder: detectRepo(),
          defaultValue: detectRepo(),
          validate: v => {
            if (!v || !v.includes('/')) return 'Formato esperado: owner/repo';
          },
        }),

      projectTitle: ({ results }) =>
        p.text({
          message: 'Nome do GitHub Project:',
          defaultValue: `${results.repo?.split('/')[1] ?? 'projeto'} — Spec Wave`,
          placeholder: 'Meu Projeto — Spec Wave',
        }),

      triggerStrategy: () =>
        p.select({
          message: 'Como prefere acionar os workflows automáticos?',
          options: [
            {
              value: 'labels',
              label: 'Labels (recomendado)',
              hint: 'A skill adiciona labels automaticamente ao mover cards',
            },
            {
              value: 'webhook',
              label: 'Webhook (em breve)',
              hint: 'Acionamento automático ao mover card no board — requer endpoint externo',
            },
          ],
        }),

      confirm: ({ results }) =>
        p.confirm({
          message: `Configurar ${results.repo} com GitHub Project "${results.projectTitle}"?\n  - 12 colunas kanban\n  - 5 campos customizados\n  - 15 labels\n  - 4 workflows + 2 issue templates`,
          initialValue: true,
        }),
    },
    {
      onCancel: () => {
        p.cancel('Operação cancelada.');
        process.exit(0);
      },
    }
  );

  if (!answers.confirm) {
    p.cancel('Operação cancelada.');
    process.exit(0);
  }

  if (answers.triggerStrategy === 'webhook') {
    p.note(
      'Webhook support está planejado para uma versão futura.\nUsando labels por enquanto.',
      'Aviso'
    );
  }

  const [owner, repo] = answers.repo.split('/');
  return { owner, repo, projectTitle: answers.projectTitle };
}

function detectRepo() {
  try {
    const remote = execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}
