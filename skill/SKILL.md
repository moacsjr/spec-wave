---
name: spec-wave
description: "Use when the user wants to set up a spec-driven GitHub workflow, create a Feature issue, generate plan.md or spec.md, decompose a Feature into Stories/Tasks, or write RFC documentation. Implements the RFC-001 workflow with GitHub Projects v2, labels, and AI-powered GitHub Actions."
argument-hint: "[info|setup|feature|plan|spec|ready|decompose|rfc] [target]"
user-invocable: true
allowed-tools:
  - Bash(npx spec-wave *)
  - Bash(gh issue *)
  - Bash(gh project *)
  - Bash(gh repo view *)
  - Bash(gh auth status)
  - Read
  - Write
---

# spec-wave Skill

Este skill guia o usuário pelo fluxo spec-driven definido no RFC-001.

> **Antes de responder a qualquer sub-comando**, leia o arquivo `rfc/rfc-integrate-spec-kit-into-kanban.md` se ele existir no diretório atual, para embasar suas respostas no processo real da equipe.

---

## Detecção de configuração (faça isto primeiro, sempre)

Antes de qualquer sub-comando, leia o arquivo `.spec-wave.json` na raiz do repositório atual (use o tool Read). Esse arquivo é gravado pelo `npx spec-wave init` e é a fonte de estado persistente entre sessões.

- **Se existir**, o spec-wave já foi configurado. Use seus campos para contextualizar as respostas, sem perguntar de novo:
  - `owner`/`repo` → repositório alvo dos comandos `gh`
  - `project.url` / `project.title` → o GitHub Project a referenciar
  - `version` → versão da CLI usada no `init` (compare com `npx spec-wave --version`; se divergir, sugira `npx spec-wave refresh --config` para atualizar o arquivo, ou re-rodar o `init` para atualizar workflows/labels)
  - `initializedAt` → quando foi configurado
  Não rode `/spec-wave setup` de novo a menos que o usuário peça explicitamente.
- **Se não existir**, o repositório provavelmente ainda não foi configurado. Sugira começar por `/spec-wave setup`.

Exemplo de `.spec-wave.json`:
```json
{
  "version": "0.1.0",
  "owner": "acme",
  "repo": "loja",
  "project": {
    "title": "loja — Spec Wave",
    "url": "https://github.com/users/acme/projects/5",
    "id": "PVT_..."
  },
  "initializedAt": "2026-06-18T13:40:00.000Z"
}
```

---

## Regra fundamental

**Nunca gere `spec.md` ou `plan.md` diretamente.** Sempre acione a label correspondente e deixe o GitHub Action gerar o arquivo. Isso garante que o arquivo seja commitado no repositório e referenciado na issue.

Exceção: se o usuário pedir explicitamente para revisar ou melhorar um documento já gerado, use o Write tool para editar o arquivo local.

---

## Fluxo Kanban

```
📥 Backlog → 🎯 Priorizado → 📋 Plan → 📋 Spec → ✅ Ready
→ 📋 Backlog Técnico → 🚧 Desenvolvimento → 👀 Code Review
→ 🧪 QA → 📋 Homologação → 🚀 Deploy → 🎉 Done
```

Labels de gatilho:
- `spec-wave:plan` → dispara `generate-plan.yml` → gera `plan.md`
- `spec-wave:spec` → dispara `generate-spec.yml` → gera `spec.md`
- `spec-wave:ready` → dispara `validate.yml` → valida ambos os arquivos
- `spec-wave:decompose` → dispara `decompose.yml` → gera Stories e Tasks

---

## Referência da CLI (conheça os parâmetros ANTES de executar)

Esta skill é um **wrapper** da CLI `spec-wave`. Regra de ouro: **nunca rode um comando sem os parâmetros que ele aceita** esperando que ele pergunte — colete os valores com o usuário e passe via flags. Em especial, **`init` sem `--repo` abre um wizard interativo (@clack/prompts) que a skill NÃO consegue dirigir** — sempre passe `--repo`.

### `spec-wave init` — configura o repositório
| Flag | Tipo | Descrição |
|------|------|-----------|
| `--repo <owner/repo>` | string | Repositório alvo. **Passe SEMPRE** para evitar o wizard interativo. |
| `--project-title <title>` | string | Nome do GitHub Project. Padrão: `<repo> — Spec Wave`. |
| `--skip-project` | flag | Pula a criação do Project (use ao re-rodar se já existe). |
| `--skip-labels` | flag | Pula a criação das labels. |
| `--skip-files` | flag | Pula a criação dos workflows + issue templates. |
| `--dry-run` | flag | Simula a configuração sem alterar nada. |

### `spec-wave feature` — cria Feature, adiciona ao Project e move para 📥 Backlog
| Flag | Tipo | Descrição |
|------|------|-----------|
| `--title <title>` | string (obrigatório) | Título, **sem** o prefixo `[FEATURE]` (a CLI adiciona). |
| `--body <text>` | string | Descrição da feature. |
| `--priority <p>` | string | `P0`, `P1`, `P2` ou `P3` (vira label). |
| `--area <area>` | string | `Frontend`, `Backend`, `Mobile`, `Infra`, `DevOps` ou `Data`. |

> Este comando faz tudo: cria a issue (labels `[FEATURE]` + prioridade), adiciona ao Project e define a Etapa = 📥 Backlog. Lê o Project do `.spec-wave.json`. **Não use `gh issue create` direto** — ele não adiciona a issue ao board.

### `spec-wave info` — status de configuração do repo atual
| Flag | Tipo | Descrição |
|------|------|-----------|
| `--json` | flag | Saída JSON (`{"initialized":bool, ...}`) para parsing programático. |

### `spec-wave refresh` — atualiza o `.spec-wave.json` local
| Flag | Tipo | Descrição |
|------|------|-----------|
| `--config` | flag | Re-consulta o GitHub Project e reescreve o `.spec-wave.json` (IDs do campo Etapa, opções, number, versão da CLI). |

> Use quando o `.spec-wave.json` estiver desatualizado: repos inicializados por uma versão antiga (sem `etapaFieldId`/`stageOptions`), Project renomeado, ou versão da CLI divergente. Escreve no arquivo **local** — faça commit depois.

### `spec-wave generate-plan` · `generate-spec` · `validate` · `decompose`
| Flag | Tipo | Descrição |
|------|------|-----------|
| `--issue-number <n>` | string (obrigatório) | Número da issue no GitHub. |

> ⚠️ Esses quatro comandos são executados pelos **GitHub Actions** (disparados por labels), **não** pela skill diretamente. Veja a *Regra fundamental*: para gerar plan/spec/decompor, adicione a **label** correspondente — não rode o comando à mão (a não ser para debug local).

---

## Sub-comandos

### `/spec-wave info`

Mostra se o repositório atual já foi configurado com o spec-wave.

**Passos:**
1. Execute: `npx spec-wave info`
2. **Se o repositório estiver inicializado**, o comando mostra os dados do `.spec-wave.json` (owner/repo, project, versão da CLI, data). Apresente essas informações ao usuário.
3. **Se NÃO estiver inicializado**, pergunte ao usuário: "Este repositório ainda não foi configurado com o spec-wave. Quer rodar o `init` agora?"
   - Se sim → siga o fluxo de `/spec-wave setup`.
   - Se não → encerre sem alterar nada.

---

### `/spec-wave setup`

Configura o spec-wave no repositório. Você dirige o `init` com flags — **nunca rode `npx spec-wave init` sem `--repo`** (abre o wizard interativo que você não controla).

**Passos:**
1. **Já configurado?** Leia `.spec-wave.json` (ou rode `npx spec-wave info`). Se existir, avise (mostre `project.url` e `version`) e confirme com o usuário antes de reconfigurar.
2. **Descubra o repositório alvo** (parâmetro `--repo`): rode `gh repo view --json nameWithOwner -q .nameWithOwner` para obter `owner/repo` do repo atual. Confirme com o usuário; se não houver remote, pergunte o `owner/repo`.
3. **Pergunte o título do Project** (parâmetro `--project-title`). Ofereça o default `<repo> — Spec Wave` e aceite-o se o usuário não tiver preferência.
4. **Cheque o auth:** `gh auth status`. Se faltarem os escopos `project,repo,workflow`, oriente o usuário a rodar ele mesmo `gh auth refresh --scopes project,repo,workflow` (comando interativo — o usuário executa, não você).
5. **(Opcional) Pré-visualize** antes de aplicar: `npx spec-wave init --repo <owner/repo> --dry-run`.
6. **Execute com os parâmetros coletados:**
   ```bash
   npx spec-wave init --repo <owner/repo> --project-title "<título>"
   ```
   Use `--skip-project` / `--skip-labels` / `--skip-files` **apenas** para re-rodar uma fase específica que falhou antes.
7. O `init` cria o Project, as labels, os workflows e grava `.spec-wave.json`. Oriente o usuário a fazer `git pull` para trazer o arquivo ao checkout local.
8. Instrua o usuário a adicionar `ANTHROPIC_API_KEY` como secret no repositório (Settings → Secrets → Actions).

---

### `/spec-wave feature <descrição>`

Crie uma nova Feature já adicionada ao board em **📥 Backlog**.

**Passos:**
1. Pergunte ao usuário: título da feature (sem o prefixo `[FEATURE]`), descrição, área (Frontend/Backend/Mobile/Infra/DevOps/Data) e prioridade (P0/P1/P2/P3).
2. Execute o comando com os parâmetros coletados:
   ```bash
   npx spec-wave feature \
     --title "<título>" \
     --body "<descrição>" \
     --area "<área>" \
     --priority "<prioridade>"
   ```
   A CLI cria a issue (labels `[FEATURE]` + prioridade), adiciona ao Project e define a Etapa = 📥 Backlog automaticamente — lendo o Project do `.spec-wave.json`. **Não use `gh issue create`** (ele não adiciona a issue ao board).
3. Informe o número da issue criada (a CLI já confirma que está em 📥 Backlog).
4. Oriente: "Quando quiser iniciar o planejamento técnico, mova o card para **📋 Plan** e use `/spec-wave plan <número>`"

---

### `/spec-wave plan <número-da-issue>`

Inicia a geração do plano técnico para uma Feature.

**Passos:**
1. Adicione a label de gatilho:
   ```bash
   gh issue edit <número> --add-label "spec-wave:plan"
   ```
2. Informe: "Label `spec-wave:plan` adicionada. O GitHub Action `generate-plan.yml` irá gerar o `plan.md` automaticamente. Acompanhe em: Actions → Generate Plan."
3. Após a conclusão (cheque comentários na issue ou aguarde confirmação do usuário), ofereça revisar o plan.md gerado em `docs/features/<slug>/plan.md`.

---

### `/spec-wave spec <número-da-issue>`

Inicia a geração da especificação funcional para uma Feature.

**Passos:**
1. Verifique se plan.md já existe (o spec usa o plano como contexto)
2. Adicione a label de gatilho:
   ```bash
   gh issue edit <número> --add-label "spec-wave:spec"
   ```
3. Informe: "Label `spec-wave:spec` adicionada. O GitHub Action `generate-spec.yml` irá gerar o `spec.md` automaticamente."
4. Após a conclusão, ofereça revisar o spec.md gerado em `docs/features/<slug>/spec.md`.

---

### `/spec-wave ready <número-da-issue>`

Valida que spec.md e plan.md estão completos e a Feature pode avançar.

**Passos:**
1. Adicione a label de validação:
   ```bash
   gh issue edit <número> --add-label "spec-wave:ready"
   ```
2. Informe: "Validação iniciada. O workflow verificará se spec.md e plan.md contêm todas as seções obrigatórias."
3. Se a validação falhar, o workflow comentará os problemas na issue e adicionará automaticamente `spec-wave:spec`. Informe o usuário para corrigir e tentar novamente.
4. Se passar, oriente: "Feature validada! Mova o card para **✅ Ready** e depois para **📋 Backlog Técnico** para iniciar a decomposição."

---

### `/spec-wave decompose <número-da-issue>`

Decompõe uma Feature em Stories e Tasks automaticamente.

**Passos:**
1. Confirme que a Feature está em **✅ Ready** (spec.md e plan.md validados)
2. Adicione a label de decomposição:
   ```bash
   gh issue edit <número> --add-label "spec-wave:decompose"
   ```
3. Informe: "Decomposição iniciada. O workflow gerará Stories e Tasks baseados em spec.md e plan.md."
4. Após a conclusão, as issues filhas aparecerão como comentário na Feature pai.

---

### `/spec-wave rfc <tópico>`

Crie um documento RFC seguindo a estrutura do RFC-001.

**Passos:**
1. Entreviste o usuário sobre: objetivo, problema atual, solução proposta, princípios, stakeholders afetados
2. Escreva o RFC em português com as seções:
   - 1. Objetivo
   - 2. Princípios
   - 3. Papéis e Responsabilidades
   - 4. Estrutura de Trabalho
   - 5. Fluxo de Trabalho
   - 6. Automação
   - 7. Métricas
   - 8. Riscos e Mitigações
3. Salve em `rfc/rfc-<slug-do-tópico>.md` usando o Write tool
4. Crie uma issue de RFC:
   ```bash
   gh issue create --title "[RFC] <título>" --label "[RFC]"
   ```

---

## Estrutura de arquivos gerados

```
docs/
  features/
    <slug-da-feature>/
      plan.md    ← gerado pelo GitHub Action quando spec-wave:plan é adicionado
      spec.md    ← gerado pelo GitHub Action quando spec-wave:spec é adicionado
```

O slug é gerado a partir do título da issue: `[FEATURE] Cadastro de Pedidos com PIX` → `cadastro-de-pedidos-com-pix`
