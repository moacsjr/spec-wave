// Lint de idioma da saída da IA (módulo puro — sem I/O, sem dependências).
//
// Modelos ocasionalmente "vazam" caracteres de outros alfabetos no meio do
// texto (caso real: "Registration成功率" num spec pt-BR). Este lint detecta
// scripts Unicode incompatíveis com idiomas latinos via property escapes.

// Scripts que nunca aparecem em texto legítimo de idiomas latinos (pt-BR, en,
// es...). Acentos, emoji, pontuação e code fences NÃO casam com nenhum deles.
const FOREIGN_SCRIPTS = [
  { script: 'Han',      re: /\p{Script=Han}/u },
  { script: 'Hiragana', re: /\p{Script=Hiragana}/u },
  { script: 'Katakana', re: /\p{Script=Katakana}/u },
  { script: 'Hangul',   re: /\p{Script=Hangul}/u },
  { script: 'Cyrillic', re: /\p{Script=Cyrillic}/u },
  { script: 'Arabic',   re: /\p{Script=Arabic}/u },
  { script: 'Thai',     re: /\p{Script=Thai}/u },
];

// Distância máxima (em caracteres) entre dois achados para agrupá-los num
// mesmo finding — evita explodir a lista quando um parágrafo inteiro vaza.
const GROUP_GAP = 20;

// Identifica o script de um caractere (ou null se não for estrangeiro).
function scriptOf(char) {
  for (const s of FOREIGN_SCRIPTS) {
    if (s.re.test(char)) return s.script;
  }
  return null;
}

/**
 * Verifica se `text` contém caracteres de scripts incompatíveis com o
 * idioma-alvo. Para pt-BR (e idiomas latinos em geral), qualquer caractere
 * CJK, Hangul, cirílico, árabe ou tailandês é um finding.
 *
 * Findings contíguos (distância ≤ ~20 chars) são agrupados num único item
 * para runs longas não gerarem um finding por caractere.
 *
 * @param {string} text texto a verificar
 * @param {object} [opts]
 * @param {string}   [opts.lang='pt-BR'] idioma-alvo (informativo; todos os
 *                   idiomas suportados hoje são latinos)
 * @param {string[]} [opts.allowlist=[]] substrings a ignorar (ex.: nomes
 *                   próprios ou termos técnicos legítimos em outro alfabeto)
 * @returns {{ ok: boolean, findings: Array<{ index: number, char: string, script: string, excerpt: string }> }}
 *          index = posição do primeiro caractere do grupo; char = trecho do
 *          grupo (do primeiro ao último caractere estrangeiro); script = script
 *          do primeiro caractere; excerpt = ~40 chars ao redor do grupo.
 */
export function lintLanguage(text, { lang = 'pt-BR', allowlist = [] } = {}) {
  const source = text || '';
  // Substitui trechos da allowlist por espaços (mesmo comprimento) para
  // preservar os índices/excerpts do texto original.
  let scanned = source;
  for (const allowed of allowlist) {
    if (!allowed) continue;
    scanned = scanned.split(allowed).join(' '.repeat(allowed.length));
  }

  // Coleta cada caractere estrangeiro com seu índice e script.
  const hits = [];
  for (const m of scanned.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/gu)) {
    hits.push({ index: m.index, char: m[0], script: scriptOf(m[0]) });
  }

  // Agrupa hits próximos num único finding.
  const findings = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    const start = Math.max(0, group.start - 20);
    const end = Math.min(source.length, group.end + 20);
    findings.push({
      index: group.start,
      char: source.slice(group.start, group.end),
      script: group.script,
      excerpt: source.slice(start, end),
    });
    group = null;
  };
  for (const hit of hits) {
    if (group && hit.index - group.end <= GROUP_GAP) {
      group.end = hit.index + hit.char.length;
    } else {
      flush();
      group = { start: hit.index, end: hit.index + hit.char.length, script: hit.script };
    }
  }
  flush();

  return { ok: findings.length === 0, findings };
}
