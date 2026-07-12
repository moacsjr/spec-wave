// Single source of truth for all RFC-001 data

// Marcador de configuração gravado pelo `init` na raiz do repo-alvo e lido
// pelo comando `info` (e pela skill) para detectar se o spec-wave já foi configurado.
export const CONFIG_FILE = '.spec-wave.json';

// Portal Web da ferramenta — exibido ao final do `init` e no `info`.
export const PORTAL_URL = 'https://spec-wave.astratech.net.br';

// Providers de IA suportados pelos workflows (generate-plan/spec/decompose).
// O provider e o modelo escolhidos no `init` são persistidos em .spec-wave.json
// (bloco `ai`) e lidos em runtime por src/lib/claude.mjs. Cada provider declara
// o secret do GitHub Actions de onde a chave é lida.
export const AI_PROVIDERS = [
  {
    value: 'anthropic',
    label: 'Anthropic (API direta)',
    hint: 'Usa o secret ANTHROPIC_API_KEY',
    secret: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-6',
    modelHint: 'ex.: claude-sonnet-4-6, claude-opus-4-1',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter (multi-modelo)',
    hint: 'Usa o secret OPENROUTER_API_KEY',
    secret: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-3.7-sonnet',
    modelHint: 'ex.: anthropic/claude-3.7-sonnet, openai/gpt-4o — veja openrouter.ai/models',
  },
];

export const DEFAULT_PROVIDER = 'anthropic';

export function getProvider(value) {
  return AI_PROVIDERS.find(p => p.value === value);
}

export const STATUS_OPTIONS = [
  { name: '📥 Backlog',          color: 'GRAY'   },
  { name: '🎯 Priorizado',       color: 'BLUE'   },
  { name: '📋 Spec',             color: 'YELLOW' },
  { name: '📋 Plan',             color: 'YELLOW' },
  { name: '✅ Ready',            color: 'GREEN'  },
  { name: '📋 Backlog Técnico',  color: 'BLUE'   },
  { name: '🚧 Desenvolvimento',  color: 'ORANGE' },
  { name: '👀 Code Review',      color: 'PURPLE' },
  { name: '🧪 QA',              color: 'PINK'   },
  { name: '📋 Homologação',      color: 'YELLOW' },
  { name: '🚀 Deploy',           color: 'ORANGE' },
  { name: '🎉 Done',            color: 'GREEN'  },
];

// ⚠️ Dois campos DISTINTOS no board (não confundir):
//  • "Etapa" (campo custom = as opções de STATUS_OPTIONS acima): as colunas do
//    kanban. Determina a DIREÇÃO do fluxo — uma issue só AVANÇA, nunca volta.
//  • "Status" (campo nativo: Todo/In Progress/Done): o PROGRESSO dentro da etapa
//    atual. Ao avançar de etapa, o Status reinicia em "Todo".

// Etapas (campo Etapa) referenciadas pelo fluxo de implementação.
export const STAGE_DEVELOPMENT = STATUS_OPTIONS.find(s => s.name.includes('Desenvolvimento')).name;
export const STAGE_CODE_REVIEW = STATUS_OPTIONS.find(s => s.name.includes('Code Review')).name;
export const STAGE_DONE = STATUS_OPTIONS.find(s => s.name.includes('Done')).name;
// Ordem canônica das etapas — usada para garantir que uma issue só AVANÇA.
export const STAGE_ORDER = STATUS_OPTIONS.map(s => s.name);

// Valores do campo nativo "Status" (progresso dentro da etapa).
export const PROGRESS_TODO = 'Todo';
export const PROGRESS_IN_PROGRESS = 'In Progress';
export const PROGRESS_DONE = 'Done';

export const CUSTOM_FIELDS = [
  {
    name: 'Work Item Type',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: 'Initiative', color: 'PINK', description: 'Agrupamento estratégico de Epics' },
      { name: 'Epic',    color: 'PURPLE', description: 'Objetivo estratégico' },
      { name: 'Feature', color: 'BLUE',   description: 'Capacidade funcional' },
      { name: 'Story',   color: 'GREEN',  description: 'Necessidade do usuário' },
      { name: 'Task',    color: 'YELLOW', description: 'Atividade técnica' },
      { name: 'Bug',     color: 'RED',    description: 'Defeito a corrigir' },
      { name: 'Spike',   color: 'ORANGE', description: 'Investigação técnica' },
      { name: 'RFC',     color: 'GRAY',   description: 'Proposta de processo' },
    ],
  },
  {
    name: 'Priority',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: 'P0', color: 'RED',    description: 'Crítico' },
      { name: 'P1', color: 'ORANGE', description: 'Alta' },
      { name: 'P2', color: 'YELLOW', description: 'Média' },
      { name: 'P3', color: 'GRAY',   description: 'Baixa' },
    ],
  },
  {
    name: 'Story Points',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: '1',  color: 'GREEN',  description: '' },
      { name: '2',  color: 'GREEN',  description: '' },
      { name: '3',  color: 'BLUE',   description: '' },
      { name: '5',  color: 'BLUE',   description: '' },
      { name: '8',  color: 'YELLOW', description: '' },
      { name: '13', color: 'ORANGE', description: '' },
      { name: '21', color: 'RED',    description: '' },
    ],
  },
  {
    name: 'Area',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: 'Frontend', color: 'BLUE',   description: '' },
      { name: 'Backend',  color: 'GREEN',  description: '' },
      { name: 'Mobile',   color: 'PURPLE', description: '' },
      { name: 'Infra',    color: 'ORANGE', description: '' },
      { name: 'DevOps',   color: 'YELLOW', description: '' },
      { name: 'Data',     color: 'PINK',   description: '' },
    ],
  },
  {
    name: 'Release',
    dataType: 'TEXT',
  },
];

// Tipos de work item (Epic, Feature, Story, Task, Bug, Spike, RFC) — derivados do
// campo "Work Item Type". Usados pelo comando `issue` para validar --type.
export const WORK_ITEM_TYPES = CUSTOM_FIELDS
  .find(f => f.name === 'Work Item Type')
  .options.map(o => o.name);

export const TYPE_LABELS = [
  { name: '[INITIATIVE]', color: 'C5DEF5', description: 'Agrupamento estratégico de Epics' },
  { name: '[EPIC]',    color: '7B61FF', description: 'Objetivo estratégico'  },
  { name: '[FEATURE]', color: '0075CA', description: 'Capacidade funcional'  },
  { name: '[STORY]',   color: '0E8A16', description: 'Necessidade do usuário' },
  { name: '[TASK]',    color: 'E4E669', description: 'Atividade técnica'     },
  { name: '[BUG]',     color: 'D93F0B', description: 'Defeito a corrigir'    },
  { name: '[SPIKE]',   color: 'E99695', description: 'Investigação técnica'  },
  { name: '[RFC]',     color: 'EDEDED', description: 'Proposta de processo'  },
];

export const PRIORITY_LABELS = [
  { name: 'P0', color: 'B60205', description: 'Crítico'  },
  { name: 'P1', color: 'D93F0B', description: 'Alta'     },
  { name: 'P2', color: 'E4E669', description: 'Média'    },
  { name: 'P3', color: 'EDEDED', description: 'Baixa'    },
];

export const TRIGGER_LABELS = [
  { name: 'spec-wave:spec',          color: 'BFD4F2', description: 'Gerar spec.md via GitHub Action'      },
  { name: 'spec-wave:plan',          color: 'BFD4F2', description: 'Gerar plan.md via GitHub Action'      },
  { name: 'spec-wave:ready',         color: '0E8A16', description: 'Validar spec+plan e mover para Ready'  },
  { name: 'spec-wave:plan-approved', color: '0E8A16', description: 'Spec+plan validados com sucesso'       },
  { name: 'spec-wave:decompose',     color: 'BFD4F2', description: 'Decompor em Stories e Tasks'          },
];

export const ALL_LABELS = [...TYPE_LABELS, ...PRIORITY_LABELS, ...TRIGGER_LABELS];

export const WORKFLOW_FILES = [
  'generate-plan.yml',
  'generate-spec.yml',
  'validate.yml',
  'decompose.yml',
  'code-review.yml',
  'qa.yml',
];

export const ISSUE_TEMPLATE_FILES = [
  'plan-template.md',
  'spec-template.md',
];

export const REQUIRED_SPEC_SECTIONS = [
  'Visão Geral',
  'Critérios de Aceite',
  'Requisitos Não-Funcionais',
];

export const REQUIRED_PLAN_SECTIONS = [
  'Estratégia Técnica',
  'Detalhamento da Implementação',
  'Segurança e Conformidade',
  'Estratégia de Testes',
  'Rollback e Monitoramento',
];

// Arquivos de configuração versionados gerados pelo `init` em .github/config/.
// O tech_context.yml (RFC-002 §4) é a fonte de verdade estática que o
// generate-plan lê para embasar o plano técnico. O scaffold em setup/files.mjs
// só cria o arquivo se ainda não existir, para não sobrescrever ajustes manuais.
export const CONFIG_FILES = [
  'tech_context.yml',
];
