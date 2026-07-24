// Dependências entre Stories (módulo puro — sem I/O, sem dependências).
//
// O decompose grava uma linha "Depende de: #4, #5" no corpo das Stories; os
// comandos `order`/`task`/`story` (Fase 2) leem essa linha para ordenar o
// trabalho e criar as relações blocked_by no GitHub.

// Linha de dependência: começo de linha, opcionalmente com marcador de lista
// (-, *, >) e/ou ênfase (_itálico_, **negrito**), "Depende de" case-insensitive,
// com ou sem dois-pontos. Os números são capturados depois via /#\d+/g.
const DEP_LINE_RE = /^[\s>*-]*[*_]{0,2}depende\s+de[*_]{0,2}\s*:?/i;

/**
 * Formata a linha de dependências gravada no corpo de uma Story.
 *
 * @param {number[]} numbers números das issues das quais a Story depende
 * @returns {string} ex.: "Depende de: #4, #5" — string vazia para lista vazia
 */
export function formatDependencyLine(numbers) {
  if (!numbers || numbers.length === 0) return '';
  return `Depende de: ${numbers.map(n => `#${n}`).join(', ')}`;
}

/**
 * Extrai os números de dependência do corpo de uma issue. Tolerante a
 * variações de formatação: "Depende de: #4", "**Depende de** #4 e #5",
 * "- _depende de_ #4, #5".
 *
 * @param {string|null|undefined} body corpo da issue
 * @returns {number[]} números encontrados (sem duplicatas, na ordem do texto);
 *          [] para body nulo ou sem linha de dependência
 */
export function parseDependencies(body) {
  if (!body) return [];
  const numbers = [];
  for (const line of body.split(/\r?\n/)) {
    if (!DEP_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) {
      const n = parseInt(m[1], 10);
      if (n && !numbers.includes(n)) numbers.push(n);
    }
  }
  return numbers;
}

/**
 * Ordena Stories topologicamente pelas dependências (Kahn). Estável: entre as
 * Stories liberadas ao mesmo tempo, vence a de menor number. Dependências que
 * apontam para fora do conjunto (ex.: issue externa) são ignoradas.
 *
 * Contrato: NUNCA lança. Retorna sempre `{ order, cycle }`:
 *  • sem ciclo → order = todos os numbers em ordem de execução, cycle = [];
 *  • com ciclo → order = o que pôde ser ordenado, cycle = numbers restantes
 *    (envolvidos no ciclo ou bloqueados por ele), ambos em ordem crescente.
 * O chamador decide se trata cycle.length > 0 como erro.
 *
 * @param {Array<{ number: number, dependsOn: number[] }>} stories
 * @returns {{ order: number[], cycle: number[] }}
 */
export function orderStories(stories) {
  const known = new Set(stories.map(s => s.number));
  // indegree = quantas dependências INTERNAS ainda não resolvidas.
  const indegree = new Map();
  const dependents = new Map(); // number → numbers que dependem dele
  for (const s of stories) {
    const deps = (s.dependsOn || []).filter(d => known.has(d) && d !== s.number);
    indegree.set(s.number, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(s.number);
    }
  }

  const order = [];
  // Fila de liberados; o menor number sai primeiro (ordenação estável).
  const ready = [...indegree.entries()].filter(([, deg]) => deg === 0).map(([n]) => n);
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const n = ready.shift();
    order.push(n);
    for (const dep of dependents.get(n) || []) {
      const deg = indegree.get(dep) - 1;
      indegree.set(dep, deg);
      if (deg === 0) ready.push(dep);
    }
  }

  const cycle = [...indegree.entries()]
    .filter(([, deg]) => deg > 0)
    .map(([n]) => n)
    .sort((a, b) => a - b);
  return { order, cycle };
}
