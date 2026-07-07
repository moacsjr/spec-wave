# spec-wave — Workflow Spec-Driven com GitHub

`@spec-wave/cli` é uma CLI Node.js que implementa um fluxo de desenvolvimento orientado a especificação sobre GitHub Projects v2, Issues e Actions. A IA gera spec e plano técnico; o board atualiza automaticamente conforme o trabalho avança.

---

## Benefícios

- **Rastreabilidade end-to-end** — cada Feature nasce como issue, gera spec.md + plan.md versionados no repo, é decomposta em Stories/Tasks com sub-issue nativa do GitHub.
- **IA como copiloto de processo** — spec e plano gerados automaticamente via Anthropic ou OpenRouter, com prompts calibrados por Tech Lead e Product Manager.
- **Board auto-gerenciado** — GitHub Actions move cards entre etapas sem intervenção manual: PR aberto → Code Review, PR aprovado → QA, etc.
- **100% GitHub-native** — sem ferramentas externas. Issues, Projects v2, Actions, sub-issues, labels — tudo dentro do ecossistema GitHub.
- **Auditável** — spec.md e plan.md são arquivos versionados em `docs/features/<slug>/`, com histórico de commits rastreável.
- **Multi-provider de IA** — suporte a Anthropic (API direta) e OpenRouter (acesso a centenas de modelos).

---

## Hierarquia de Work Items

```
Initiative          → agrupa Epics (objetivo estratégico de alto nível)
  └── Epic          → objetivo estratégico
        └── Feature → capacidade funcional (unidade principal do fluxo)
              └── Story  → necessidade do usuário
                    └── Task → atividade técnica concreta
```

Tipos adicionais: **Bug**, **Spike**, **RFC**.

---

## Kanban — Etapas do Board

| Etapa | Significado |
|-------|-------------|
| 📥 Backlog | Issue criada, ainda não priorizada |
| 🎯 Priorizado | Selecionada para refinamento |
| 📋 Spec | Aguardando geração/revisão do spec.md |
| 📋 Plan | Aguardando geração/revisão do plan.md |
| ✅ Ready | Spec + plan validados, pronta para decomposição |
| 📋 Backlog Técnico | Decomposta em Stories/Tasks |
| 🚧 Desenvolvimento | Em implementação |
| 👀 Code Review | PR aberto |
| 🧪 QA | PR aprovado, aguardando testes |
| 📋 Homologação | Em homologação com stakeholders |
| 🚀 Deploy | Em processo de deploy |
| 🎉 Done | Entregue |

---

## Fluxo Automatizado

```
[FEATURE] criada
    │
    ├─ label spec-wave:spec
    │       └─► GitHub Action → generate-spec → spec.md commitado
    │
    ├─ label spec-wave:plan
    │       └─► GitHub Action → generate-plan → plan.md commitado
    │
    ├─ label spec-wave:ready
    │       └─► GitHub Action → validate
    │               ├─ falha → label spec-wave:spec (volta ao início)
    │               └─ sucesso → label spec-wave:plan-approved
    │
    ├─ label spec-wave:decompose
    │       └─► GitHub Action → decompose
    │               └─ cria Stories + Tasks como sub-issues
    │                  move Feature + Stories + Tasks → Status "Todo"
    │
    ├─ PR aberto (Closes #N)
    │       └─► GitHub Action → code-review
    │               └─ Feature → Etapa "👀 Code Review" + Status "Todo"
    │
    └─ PR aprovado
            └─► GitHub Action → qa
                    └─ Feature → Etapa "🧪 QA" + Status "Todo"
```

---

## Comandos CLI

```bash
npx @spec-wave/cli <comando>
```

### Setup

| Comando | Descrição |
|---------|-----------|
| `init` | Configura spec-wave em um repositório: cria GitHub Project, labels e workflow files |
| `init --skip-project` | Atualiza labels e workflows sem recriar o Project (preserva config existente) |
| `refresh` | Atualiza `.spec-wave.json` local com dados atuais do GitHub Project |
| `info` | Exibe status de configuração do repositório atual |
| `uninstall` | Remove labels, workflows e `.spec-wave.json` do repositório |

### Criação de Work Items

| Comando | Descrição |
|---------|-----------|
| `initiative --title "..."` | Cria uma Initiative |
| `feature --title "..." [--parent <epic#>]` | Cria uma Feature |
| `issue --type <tipo> --title "..."` | Cria qualquer tipo de work item |

### Fluxo de Feature (acionados por GitHub Actions via labels)

| Comando | Trigger | Descrição |
|---------|---------|-----------|
| `generate-spec --issue-number N` | `spec-wave:spec` | Gera spec.md via IA e commita |
| `generate-plan --issue-number N` | `spec-wave:plan` | Gera plan.md via IA e commita |
| `validate --issue-number N` | `spec-wave:ready` | Valida seções obrigatórias de spec.md e plan.md |
| `decompose --issue-number N` | `spec-wave:decompose` | Decompõe Feature em Stories e Tasks via IA |
| `code-review --pr-number N` | PR aberto | Move Feature para Code Review no board |
| `qa --pr-number N` | PR aprovado | Move Feature para QA no board |

### Implementação

| Comando | Descrição |
|---------|-----------|
| `implement <issue#>` | Monta contexto (spec+plan+tasks) e aciona o spec-kit implement |

---

## Arquitetura

```
packages/spec-wave/
├── bin/spec-wave.mjs              Entrypoint CLI (Commander)
├── src/
│   ├── config.mjs                 Fonte única: etapas, campos, labels, seções obrigatórias
│   ├── commands/                  Um arquivo por comando CLI
│   ├── api/
│   │   ├── github-rest.mjs        Octokit REST (issues, labels, PRs, files)
│   │   └── github-graphql.mjs     Octokit GraphQL (Projects v2, sub-issues, campos)
│   ├── setup/                     Fases do init: project board, labels, workflow files
│   ├── lib/
│   │   ├── claude.mjs             Cliente IA (Anthropic/OpenRouter)
│   │   ├── issue-type.mjs         Detecta tipo de issue pelo prefixo do título
│   │   ├── slugify.mjs            Título → slug de diretório
│   │   └── tech-context.mjs       Lê .github/config/tech_context.yml para enriquecer plan
│   └── templates/
│       ├── workflows/             YAMLs instalados no repo-alvo via init
│       ├── issue/                 Templates de issue (plan-template.md, spec-template.md)
│       └── config/                tech_context.yml scaffold
skill/SKILL.md                     Skill Claude Code que guia o fluxo interativamente
rfc/                               Documentação de processo (RFC-001, RFC-002) em PT-BR
```

### Campos do GitHub Project criados pelo `init`

| Campo | Tipo | Valores |
|-------|------|---------|
| Etapa | Single Select | 12 etapas do kanban |
| Work Item Type | Single Select | Initiative, Epic, Feature, Story, Task, Bug, Spike, RFC |
| Priority | Single Select | P0, P1, P2, P3 |
| Story Points | Single Select | 1, 2, 3, 5, 8, 13, 21 |
| Area | Single Select | Frontend, Backend, Mobile, Infra, DevOps, Data |
| Release | Text | Livre |

---

## Configuração do Repositório-Alvo

Após `spec-wave init`, o repositório recebe:

- **`.spec-wave.json`** — config local: owner/repo, project id/fields, provider de IA
- **`.github/workflows/`** — 6 workflows: generate-spec, generate-plan, validate, decompose, code-review, qa
- **`.github/ISSUE_TEMPLATE/`** — templates de spec e plan
- **`.github/config/tech_context.yml`** — contexto técnico do projeto (lido pelo generate-plan)

### Secrets necessários

| Secret | Uso |
|--------|-----|
| `ANTHROPIC_API_KEY` | Geração de spec/plan com Anthropic (provider padrão) |
| `OPENROUTER_API_KEY` | Geração via OpenRouter (provider alternativo) |

O `GITHUB_TOKEN` é provido automaticamente pelo Actions — mas precisa de escopo `project` para atualizar o board (requer PAT com scope `project` como secret adicional).

---

## Instalação

```bash
# Setup em um repositório
npx @spec-wave/cli init --repo owner/repo

# Atualizar labels e workflows (sem recriar o Project)
npx @spec-wave/cli init --skip-project

# Adicionar a skill ao Claude Code
cp skill/SKILL.md ~/.claude/skills/spec-wave/SKILL.md
```
