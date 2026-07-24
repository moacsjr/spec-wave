# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repo has two parts:
1. **`rfc/`** — Process documentation in Brazilian Portuguese defining the spec-driven workflow (RFC-001)
2. **`packages/spec-wave/`** — A Node.js CLI (`npx spec-wave`) and a coding-agent skill (`src/templates/skill/SKILL.md`) that implement the RFC

All documentation is written in **Brazilian Portuguese**.

## Architecture

```
packages/spec-wave/
├── bin/spec-wave.mjs          Entry point (Commander CLI)
├── src/
│   ├── config.mjs             Single source of truth: kanban columns, fields, labels
│   ├── commands/              One file per CLI command
│   ├── api/                   GitHub GraphQL (Projects v2) and REST API wrappers
│   ├── setup/                 Three setup phases: project board, labels, files
│   ├── lib/                   Shared utilities: slugify, Claude API client
│   └── templates/             Static markdown/YAML templates + skill/SKILL.md (bundled skill source)
```

The skill lives at `packages/spec-wave/src/templates/skill/SKILL.md` (bundled with
the npm package). The `install-skill` command installs it into whatever agent the
user runs — see "Adding the Skill" below.

**config.mjs is the authoritative source** for all RFC data (kanban columns, custom fields, labels). All other modules import from it — edit config.mjs to change the workflow definition.

## Commands

```bash
# Install dependencies (Node 20+, npm workspaces)
npm install

# Run CLI locally (no build step needed — pure ESM)
node packages/spec-wave/bin/spec-wave.mjs --help
node packages/spec-wave/bin/spec-wave.mjs init --dry-run

# Test against a real repo
node packages/spec-wave/bin/spec-wave.mjs init --repo owner/test-repo
```

## Key Concepts

**Trigger strategy (Phase 1 — labels):** GitHub Actions cannot trigger on Projects v2 column moves. Instead, the skill adds labels (`spec-wave:plan`, `spec-wave:spec`, `spec-wave:ready`, `spec-wave:decompose`) to issues programmatically, which trigger the corresponding workflows. Webhook-based triggers are planned for Phase 2.

**Document generation:** `generate-plan` and `generate-spec` commands call the Anthropic API (`ANTHROPIC_API_KEY` env var) and commit generated files to `docs/features/<slug>/`.

**Slug generation:** Issue title `[FEATURE] Cadastro de Pedidos com PIX` → folder `docs/features/cadastro-de-pedidos-com-pix/`. See `src/lib/slugify.mjs`.

## GitHub API Requirements

- `init` uses both REST (`@octokit/rest`) and GraphQL (`@octokit/graphql`) for Projects v2
- Token needs `project` scope for creating GitHub Projects: `gh auth refresh --scopes project`
- GitHub Actions workflows use `GITHUB_TOKEN` (auto-provided) + `ANTHROPIC_API_KEY` (must be added as repo secret)

## Adding the Skill

Run `npx @spec-wave/cli install-skill` in the target project. It autodetects the
coding agent(s) in use (Claude Code, Cursor, opencode, Cline, Kilo Code,
Antigravity, or a generic `AGENTS.md`) and writes the skill in each one's format
and location. Defaults to project scope; pass `--global` for user scope, or
`--agent <name>` / `--all` to select targets explicitly.

The bundled skill source is `packages/spec-wave/src/templates/skill/SKILL.md` —
edit it there. For Claude Code the file is copied verbatim to
`.claude/skills/spec-wave/SKILL.md`; then trigger `/spec-wave` to invoke it.
