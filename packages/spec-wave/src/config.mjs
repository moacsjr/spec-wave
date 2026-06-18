// Single source of truth for all RFC-001 data

// Marcador de configuração gravado pelo `init` na raiz do repo-alvo e lido
// pelo comando `info` (e pela skill) para detectar se o spec-wave já foi configurado.
export const CONFIG_FILE = '.spec-wave.json';

export const STATUS_OPTIONS = [
  { name: '📥 Backlog',          color: 'GRAY'   },
  { name: '🎯 Priorizado',       color: 'BLUE'   },
  { name: '📋 Plan',             color: 'YELLOW' },
  { name: '📋 Spec',             color: 'YELLOW' },
  { name: '✅ Ready',            color: 'GREEN'  },
  { name: '📋 Backlog Técnico',  color: 'BLUE'   },
  { name: '🚧 Desenvolvimento',  color: 'ORANGE' },
  { name: '👀 Code Review',      color: 'PURPLE' },
  { name: '🧪 QA',              color: 'PINK'   },
  { name: '📋 Homologação',      color: 'YELLOW' },
  { name: '🚀 Deploy',           color: 'ORANGE' },
  { name: '🎉 Done',            color: 'GREEN'  },
];

export const CUSTOM_FIELDS = [
  {
    name: 'Work Item Type',
    dataType: 'SINGLE_SELECT',
    options: [
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

export const TYPE_LABELS = [
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
  { name: 'spec-wave:plan',      color: 'BFD4F2', description: 'Gerar plan.md via GitHub Action'     },
  { name: 'spec-wave:spec',      color: 'BFD4F2', description: 'Gerar spec.md via GitHub Action'     },
  { name: 'spec-wave:ready',     color: '0E8A16', description: 'Validar spec+plan e mover para Ready' },
  { name: 'spec-wave:decompose', color: 'BFD4F2', description: 'Decompor em Stories e Tasks'         },
];

export const ALL_LABELS = [...TYPE_LABELS, ...PRIORITY_LABELS, ...TRIGGER_LABELS];

export const WORKFLOW_FILES = [
  'generate-plan.yml',
  'generate-spec.yml',
  'validate.yml',
  'decompose.yml',
];

export const ISSUE_TEMPLATE_FILES = [
  'plan-template.md',
  'spec-template.md',
];

export const REQUIRED_PLAN_SECTIONS = [
  'Frontend',
  'Backend',
  'Banco de dados',
  'Testes',
];

export const REQUIRED_SPEC_SECTIONS = [
  'Objetivo',
  'Critérios de Aceite',
];
