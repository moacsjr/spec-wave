import { TYPE_LABELS } from '../config.mjs';

// Mapa de prefixo de label (ex.: "[STORY]") → nome canônico do tipo ("Story").
// Derivado de TYPE_LABELS para manter uma única fonte da verdade.
const TAG_TO_TYPE = Object.fromEntries(
  TYPE_LABELS.map(l => [l.name.toUpperCase(), capitalize(l.name.replace(/[[\]]/g, ''))])
);

function capitalize(s) {
  const lower = s.toLowerCase();
  // RFC fica em caixa alta; os demais tipos seguem Capitalizado (Story, Task...).
  return lower === 'rfc' ? 'RFC' : lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Detecta o tipo canônico de uma issue ('Story', 'Task', 'Feature', ...) a partir
// do prefixo do título ([STORY], [TASK], ...) com fallback nas labels. Retorna
// null quando não é possível determinar.
export function detectIssueType(issue) {
  if (!issue) return null;

  // 1. Prefixo do título: "[STORY] ..." → "Story".
  const titleMatch = String(issue.title || '').match(/^\s*(\[[^\]]+\])/);
  if (titleMatch) {
    const type = TAG_TO_TYPE[titleMatch[1].toUpperCase()];
    if (type) return type;
  }

  // 2. Fallback: varrer as labels da issue procurando um dos prefixos de tipo.
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  for (const label of labels) {
    const name = (typeof label === 'string' ? label : label?.name) || '';
    const type = TAG_TO_TYPE[name.toUpperCase()];
    if (type) return type;
  }

  return null;
}
