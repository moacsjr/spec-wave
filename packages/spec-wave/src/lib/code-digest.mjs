// Digest do estado atual do código — anexado ao contexto do `implement` para o
// agente NÃO reimplementar o que já existe (caso real: módulo `landing` criado
// duplicando o módulo `waves`). Duas fontes, ambas best-effort:
//   • commits recentes (git log desde a criação da Feature);
//   • árvore rasa dos módulos citados no plan.md.
// Contrato: buildCodeDigest NUNCA lança — cada seção tem seu try/catch e, se
// tudo falhar, retorna null (o chamador simplesmente omite a seção).

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Limites — o digest é contexto auxiliar, não pode dominar o arquivo.
const MAX_PATHS = 30;
const MAX_LOG_LINES = 50;
const MAX_TREE_ENTRIES = 40;
const MAX_TREE_DEPTH = 2;

// Extensões comuns de código/config — usadas para aceitar nomes sem "/" como
// caminho (ex.: `config.mjs`).
const COMMON_EXT_RE = /\.(mjs|cjs|jsx?|tsx?|json|ya?ml|md|css|scss|html|vue|svelte|py|rb|go|rs|java|kt|sql|sh|prisma|toml)$/i;

// Prefixos de diretório que aparecem "soltos" no texto do plan (fora de backticks).
const LOOSE_PATH_RE = /(?:^|[\s(])((?:src|server|client|packages)\/[\w./@-]+)/gm;

// Caracteres que denunciam código inline, não caminho: chamadas, objetos, aspas…
const NON_PATH_CHARS_RE = /[(){}<>|"'`\\=,;!?*\s]/;

function normalizePath(raw) {
  return String(raw)
    .trim()
    .replace(/^\.\//, '')     // sem "./" inicial
    .replace(/\/+$/, '')      // sem "/" final
    .replace(/\.+$/, '');     // pontuação de fim de frase colada ("src/lib.")
}

function looksLikePath(candidate) {
  if (!candidate || candidate.startsWith('-') || candidate.includes('://')) return false;
  if (NON_PATH_CHARS_RE.test(candidate)) return false;
  return candidate.includes('/') || COMMON_EXT_RE.test(candidate);
}

/**
 * Extrai caminhos de arquivo/diretório citados no plan.md: conteúdo de
 * backticks que pareça caminho (tem "/" ou extensão comum) e padrões soltos
 * tipo `src/...`, `server/...`, `client/...`, `packages/...`.
 *
 * @param {string|null|undefined} planText conteúdo do plan.md
 * @returns {string[]} caminhos normalizados, sem duplicatas, no máx. 30
 */
export function extractPathsFromPlan(planText) {
  if (!planText) return [];
  const paths = [];
  const push = (raw) => {
    const candidate = normalizePath(raw);
    if (looksLikePath(candidate) && !paths.includes(candidate)) paths.push(candidate);
  };
  for (const m of planText.matchAll(/`([^`\n]+)`/g)) push(m[1]);
  for (const m of planText.matchAll(LOOSE_PATH_RE)) push(m[1]);
  return paths.slice(0, MAX_PATHS);
}

// exec padrão: execSync capturando stdout (stderr descartado — falha vira
// exceção e a seção é omitida).
function defaultExec(command, options = {}) {
  return execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// Listagem rasa de um diretório (profundidade máx. 2, orçamento de entradas
// compartilhado), formato indentado. Erros de leitura interrompem só o ramo.
function listDirTree(absDir, budget) {
  const lines = [];
  const walk = (dir, depth) => {
    if (depth > MAX_TREE_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (budget.remaining <= 0) {
        budget.truncated = true;
        return;
      }
      budget.remaining--;
      const indent = '  '.repeat(depth + 1);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        walk(path.join(dir, entry.name), depth + 1);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
  };
  walk(absDir, 0);
  return lines;
}

// Seção "Commits desde a criação da feature" — null se a seção falhar.
function buildCommitsSection({ sinceIso, cwd, exec }) {
  if (!sinceIso) return null;
  try {
    // Sanitiza o ISO antes de interpolar no shell (só chars de data/hora).
    const safeSince = String(sinceIso).replace(/[^\w:+.-]/g, '');
    const out = exec(`git log --oneline --no-merges --since="${safeSince}"`, { cwd });
    const commits = String(out).split('\n').filter(l => l.trim()).slice(0, MAX_LOG_LINES);
    const lines = ['### Commits desde a criação da feature', ''];
    if (commits.length === 0) {
      lines.push('nenhum commit no período.');
    } else {
      lines.push('```', ...commits, '```');
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

// Seção "Árvore dos módulos citados no plan" — null se não houver paths ou se
// a seção falhar.
function buildTreeSection({ paths, cwd }) {
  if (!paths || paths.length === 0) return null;
  try {
    const lines = ['### Árvore dos módulos citados no plan', ''];
    const missing = [];
    const budget = { remaining: MAX_TREE_ENTRIES, truncated: false };
    for (const rel of paths) {
      let stat;
      try {
        stat = statSync(path.join(cwd, rel));
      } catch {
        missing.push(rel);
        continue;
      }
      if (stat.isDirectory()) {
        lines.push(`- \`${rel}/\` (diretório):`);
        lines.push('```');
        lines.push(...listDirTree(path.join(cwd, rel), budget));
        lines.push('```');
      } else {
        let lineCount = null;
        try {
          const content = readFileSync(path.join(cwd, rel), 'utf-8');
          lineCount = content.split('\n').length;
        } catch { /* tamanho é opcional */ }
        lines.push(`- \`${rel}\` — arquivo existente${lineCount != null ? ` (${lineCount} linhas)` : ''}`);
      }
    }
    if (budget.truncated) lines.push(`_(listagem truncada em ${MAX_TREE_ENTRIES} entradas)_`);
    if (missing.length > 0) {
      lines.push(`- não existem ainda (a criar): ${missing.map(m => `\`${m}\``).join(', ')}`);
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * Monta o digest do estado do código em markdown. Best-effort: cada seção tem
 * try/catch próprio; NUNCA lança — se nada puder ser gerado, retorna null.
 *
 * @param {object} opts
 * @param {string|null} [opts.sinceIso] ISO da criação da Feature (limite do git log)
 * @param {string[]} [opts.paths] caminhos citados no plan (ver extractPathsFromPlan)
 * @param {string} [opts.cwd] raiz do repo alvo
 * @param {Function} [opts.exec] injetável para testes (default: execSync utf-8)
 * @returns {Promise<string|null>} markdown do digest, ou null
 */
export async function buildCodeDigest({ sinceIso, paths = [], cwd = process.cwd(), exec = defaultExec } = {}) {
  try {
    const sections = [
      buildCommitsSection({ sinceIso, cwd, exec }),
      buildTreeSection({ paths, cwd }),
    ].filter(Boolean);
    return sections.length > 0 ? sections.join('\n\n') : null;
  } catch {
    return null;
  }
}
