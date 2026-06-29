# @spec-wave/cli

CLI e skill para implementar um fluxo **spec-driven** completo no GitHub — do backlog ao deploy — com GitHub Projects v2, labels de gatilho e GitHub Actions com IA.

---

## Conceito

Spec Wave é um sistema de processo de desenvolvimento baseado em especificações. Cada Feature passa por um ciclo documentado antes de ser implementada:

1. **Spec funcional** gerada por IA a partir do título e descrição da issue
2. **Plano técnico** gerado por IA a partir da spec e do contexto tecnológico do repositório
3. **Validação automática** das seções obrigatórias
4. **Decomposição em Stories e Tasks** gerada por IA
5. **Automação do board** durante o ciclo de desenvolvimento (Code Review → QA → Done)

O resultado é um board Kanban no GitHub Projects v2 que avança automaticamente conforme o trabalho progride, com toda a documentação versionada no próprio repositório.

---

## Fluxo Kanban

```
📥 Backlog
  → 🎯 Priorizado
  → 📋 Spec          ← label spec-wave:spec → Action gera spec.md
  → 📋 Plan          ← label spec-wave:plan → Action gera plan.md
  → ✅ Ready         ← label spec-wave:ready → Action valida ambos
  → 📋 Backlog Técnico
  → 🚧 Desenvolvimento ← comando local: spec-wave implement <n>
  → 👀 Code Review   ← PR aberto → Action move automaticamente
  → 🧪 QA            ← PR aprovado → Action move automaticamente
  → 📋 Homologação
  → 🚀 Deploy
  → 🎉 Done
```

---

## Hierarquia de Work Items

```
Initiative
  └── Epic
        └── Feature
              ├── Story
              │     └── Task
              └── Task
```

Cada nível é uma GitHub Issue com prefixo no título (`[FEATURE]`, `[STORY]`, etc.) e vínculo de sub-issue nativo do GitHub.

---

## Componentes

### CLI (`@spec-wave/cli`)

Ferramenta Node.js que configura e opera o fluxo via linha de comando.

| Comando | O que faz |
|---------|-----------|
| `init` | Cria o GitHub Project, labels, workflows e `.spec-wave.json` |
| `info` | Mostra o estado de configuração do repositório atual |
| `refresh` | Re-sincroniza o `.spec-wave.json` com o GitHub Project |
| `issue` | Cria qualquer work item (initiative/epic/feature/story/task/bug/spike/rfc) |
| `initiative` | Atalho para `issue --type initiative` |
| `feature` | Atalho para `issue --type feature` |
| `generate-spec` | Gera `spec.md` (usado pelo GitHub Action) |
| `generate-plan` | Gera `plan.md` (usado pelo GitHub Action) |
| `validate` | Valida spec.md e plan.md (usado pelo GitHub Action) |
| `decompose` | Decompõe Feature em Stories e Tasks (usado pelo GitHub Action) |
| `code-review` | Move Feature para Code Review ao abrir PR (usado pelo GitHub Action) |
| `qa` | Move Feature para QA ao aprovar PR (usado pelo GitHub Action) |
| `implement` | Aciona o spec-kit localmente para implementar uma Story ou Task |
| `uninstall` | Remove labels, workflows e `.spec-wave.json` |

### GitHub Actions (instalados pelo `init`)

| Workflow | Gatilho | Ação |
|----------|---------|------|
| `generate-spec.yml` | label `spec-wave:spec` | Gera `docs/features/<slug>/spec.md` via IA |
| `generate-plan.yml` | label `spec-wave:plan` | Gera `docs/features/<slug>/plan.md` via IA |
| `validate.yml` | label `spec-wave:ready` | Valida seções obrigatórias; adiciona `spec-wave:plan-approved` |
| `decompose.yml` | label `spec-wave:decompose` | Cria Stories e Tasks como sub-issues |
| `code-review.yml` | PR aberto/reaberto | Move Feature para `👀 Code Review` |
| `qa.yml` | PR aprovado | Move Feature para `🧪 QA` |

### Skill (`skill/SKILL.md`)

Claude Code skill que guia o usuário pelo fluxo via comandos como `/spec-wave spec 42`, `/spec-wave plan 42`, `/spec-wave decompose 42`. A skill lê o `.spec-wave.json` local, detecta o estado atual e executa os comandos corretos sem abrir wizards interativos.

### `.spec-wave.json`

Arquivo de configuração gerado pelo `init` na raiz do repositório. Armazena `owner/repo`, dados do GitHub Project (ID, URL, campos) e o provider de IA configurado. Todos os comandos leem este arquivo para operar sem precisar de flags adicionais.

### `tech_context.yml`

Arquivo em `.github/config/tech_context.yml` que descreve a stack tecnológica do sistema (backend, frontend, banco, infra, roles RBAC, schemas, serviços). O `generate-plan` usa este arquivo para embasar o plano técnico — sem ele, o plano fica genérico.

---

## Pré-requisitos

- Node.js >= 20
- GitHub CLI (`gh`) autenticado com escopos `project`, `repo` e `workflow`:
  ```bash
  gh auth refresh --scopes project,repo,workflow
  ```
- Secret no repositório: `ANTHROPIC_API_KEY` ou `OPENROUTER_API_KEY` (Settings → Secrets → Actions)
- Para repositórios em organizações: criar PAT com escopo `project` e adicionar como secret `GH_PROJECT_TOKEN`

---

## Instalação da CLI

Não é necessário instalar globalmente — use `npx`:

```bash
npx @spec-wave/cli --help
```

Para instalar globalmente:

```bash
npm install -g @spec-wave/cli
spec-wave --help
```

---

## Instalação da Skill

A skill permite usar o fluxo diretamente no Claude Code via `/spec-wave`.

**1. Copie o arquivo da skill:**

```bash
mkdir -p ~/.claude/skills/spec-wave
cp skill/SKILL.md ~/.claude/skills/spec-wave/SKILL.md
```

Ou, se estiver em outro repositório:

```bash
mkdir -p ~/.claude/skills/spec-wave
curl -o ~/.claude/skills/spec-wave/SKILL.md \
  https://raw.githubusercontent.com/moacsjr/spec-wave/main/skill/SKILL.md
```

**2. Adicione ao `CLAUDE.md` do projeto:**

```markdown
# spec-wave skill
Trigger `/spec-wave` to invoke the spec-wave skill.
```

**3. Use no Claude Code:**

```
/spec-wave setup
/spec-wave spec 42
/spec-wave plan 42
/spec-wave ready 42
/spec-wave decompose 42
/spec-wave implement 45
```

---

## Exemplo de uso — do início ao fim

### Contexto

Equipe quer implementar uma feature de "Checkout com PIX" em um repositório `acme/loja`.

---

### 1. Configurar o repositório

```bash
# Verificar autenticação
gh auth status

# Se faltarem escopos:
gh auth refresh --scopes project,repo,workflow

# Configurar spec-wave (cria Project, labels e workflows)
npx @spec-wave/cli init --repo acme/loja --project-title "Loja — Spec Wave"
```

O `init` cria:
- GitHub Project v2 com 12 colunas Kanban e campos personalizados (Work Item Type, Priority, Story Points, Area)
- 20+ labels de tipo, prioridade e gatilho
- 6 GitHub Actions workflows em `.github/workflows/`
- `.spec-wave.json` com os IDs do Project

Adicionar o secret de IA no GitHub: **Settings → Secrets → Actions → `ANTHROPIC_API_KEY`**.

---

### 2. Criar a hierarquia de issues

```bash
# Criar Epic
npx @spec-wave/cli issue \
  --type epic \
  --title "Checkout e Pagamentos" \
  --priority P1 \
  --area Backend
# → Issue #5 criada: [EPIC] Checkout e Pagamentos

# Criar Feature como sub-issue do Epic
npx @spec-wave/cli feature \
  --title "Checkout com PIX" \
  --parent 5 \
  --priority P1 \
  --area Backend
# → Issue #12 criada: [FEATURE] Checkout com PIX (sub-issue de #5)
# → Adicionada ao board em 📥 Backlog
```

---

### 3. Gerar a especificação funcional

```bash
gh issue edit 12 --add-label "spec-wave:spec"
```

O GitHub Action `generate-spec.yml` dispara, chama a IA e faz commit de:
```
docs/features/checkout-com-pix/spec.md
```

A issue #12 recebe um comentário com o link para o arquivo.

---

### 4. Gerar o plano técnico

Antes de gerar o plano, garanta que `.github/config/tech_context.yml` existe e reflete a stack real. O `init` cria um scaffold — edite-o:

```yaml
system_info:
  name: "Loja ACME"
  stack:
    backend: "Node.js (NestJS v11)"
    frontend: "Next.js 16"
    database: "PostgreSQL (Prisma 5)"
    infra: "Docker / AWS ECS"
security:
  auth_protocol: "JWT"
  rbac_roles: ["ADMIN", "CUSTOMER"]
database_schemas:
  - table: "orders"
    columns: "id, customer_id, status, total, created_at"
```

```bash
git add .github/config/tech_context.yml
git commit -m "chore: tech_context.yml"
git push

# Acionar geração do plano
gh issue edit 12 --add-label "spec-wave:plan"
```

O Action gera `docs/features/checkout-com-pix/plan.md` com:
- Estratégia Técnica e Matriz de Rastreabilidade
- Detalhamento da Implementação
- Segurança e Conformidade
- Estratégia de Testes
- Rollback e Monitoramento

---

### 5. Validar spec e plan

```bash
gh issue edit 12 --add-label "spec-wave:ready"
```

O Action `validate.yml` verifica se todas as seções obrigatórias estão presentes em spec.md e plan.md. Se passar:
- Remove a label `spec-wave:ready`
- Adiciona a label `spec-wave:plan-approved`
- Comenta "Validação aprovada ✅" na issue

---

### 6. Decompor em Stories e Tasks

```bash
gh issue edit 12 --add-label "spec-wave:decompose"
```

O Action `decompose.yml` usa IA para criar sub-issues da Feature #12:

```
#13 [STORY] Como cliente, quero selecionar PIX como forma de pagamento
  #14 [TASK] Criar endpoint POST /orders/:id/payment/pix
  #15 [TASK] Integrar API do banco via webhook
  #16 [TASK] Exibir QR Code na tela de checkout
#17 [STORY] Como cliente, quero receber confirmação do pagamento
  #18 [TASK] Webhook de confirmação do banco
  #19 [TASK] Notificação por e-mail ao confirmar
```

Todas as Stories e Tasks são adicionadas ao board em **📋 Backlog Técnico** com Status `Todo`.

---

### 7. Implementar

```bash
# Via skill no Claude Code:
/spec-wave implement 13

# Ou direto:
npx @spec-wave/cli implement 13 --dry-run   # ver contexto antes
npx @spec-wave/cli implement 13             # executar
```

O comando monta um arquivo de contexto com spec.md, plan.md e todas as Tasks da Story, e aciona o spec-kit configurado.

---

### 8. Code Review automático

Ao abrir um PR que referencia `Closes #14` (ou qualquer issue da hierarquia):

```markdown
## Descrição
Implementa endpoint PIX

Closes #14
```

O Action `code-review.yml` detecta a referência, sobe a hierarquia Task → Story → Feature, e move a Feature #12 para **👀 Code Review** no board.

---

### 9. QA automático

Quando um reviewer aprova o PR, o Action `qa.yml` move a Feature #12 para **🧪 QA**.

---

### 10. Estado final no board

```
Feature #12: [FEATURE] Checkout com PIX
  Etapa: 🧪 QA
  Status: Todo
  Work Item Type: Feature
  Priority: P1
  Area: Backend
```

Após QA passar, mover manualmente para **📋 Homologação → 🚀 Deploy → 🎉 Done**.

---

## Atualizar repositórios existentes

Quando uma nova versão da CLI for publicada, rode em cada repositório configurado:

```bash
npx @spec-wave/cli@latest init --skip-project --skip-labels
```

Isso atualiza apenas os arquivos de workflow sem recriar o Project ou as labels.

---

## Providers de IA

| Provider | Secret | Modelo padrão |
|----------|--------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenRouter | `OPENROUTER_API_KEY` | `anthropic/claude-3.7-sonnet` |

Configurar no `init`:
```bash
npx @spec-wave/cli init --repo owner/repo --provider openrouter --model anthropic/claude-3.7-sonnet
```

---

## Licença

MIT
