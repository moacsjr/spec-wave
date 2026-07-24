// Crítica adversarial dos artefatos gerados por IA (plan e stories).
//
// Um segundo passe de IA, com papel de revisor cético, audita o documento
// recém-gerado contra a spec/regras de negócio/tech_context e classifica cada
// contradição como GRAVE ou MENOR. Findings graves aplicam a label
// `spec-wave:critique-failed`, que bloqueia o `spec-wave:ready` até correção.
//
// Contrato: a crítica NUNCA deve derrubar o fluxo principal — parse tolerante
// a JSON sujo, e falhas de API são tratadas pelo chamador como não-fatais.

import { generateDocument } from './claude.mjs';
import { LABEL_CRITIQUE_FAILED } from '../config.mjs';

// Tamanho máximo da resposta bruta preservada no fallback de parse.
const RAW_FALLBACK_MAX = 400;

// Redação específica por tipo de auditoria. 'plan' audita o plan.md contra a
// spec; 'stories' audita as stories propostas contra spec + plan.
const KIND_FOCUS = {
  plan:
    'Audite o plan.md contra o spec.md, as regras de negócio e o tech_context fornecidos. ' +
    'Procure decisões técnicas que contradizem ou ignoram requisitos da spec e ' +
    'tecnologias/serviços fora do tech_context.',
  stories:
    'Audite as Stories propostas (JSON) contra o spec.md e o plan.md fornecidos. ' +
    'Procure stories que contradizem, invertem ou ignoram requisitos da spec ou ' +
    'decisões do plan, e critérios de aceite incompatíveis com as regras de negócio.',
};

function buildSystemPrompt(kind) {
  const focus = KIND_FOCUS[kind] || KIND_FOCUS.plan;
  return `Você é um revisor técnico CÉTICO e adversarial. Seu papel é encontrar problemas, não elogiar.

${focus}

Liste:
- contradições diretas entre os documentos;
- inversões de requisito (ex.: consentimento→persistência invertidos: a spec exige consentimento ANTES de persistir e o documento persiste antes de pedir consentimento);
- violações de restrições explícitas (ex.: minimização de dados LGPD, limites de retenção, campos proibidos);
- itens que contradizem ou ignoram a spec.

Classifique cada finding:
- "grave": contradiz um requisito ou regra explícita — causaria implementação errada;
- "menor": inconsistência, omissão ou ambiguidade que merece atenção mas não inverte requisito.

NÃO invente problemas: se os documentos estiverem consistentes, retorne a lista vazia.
Escreva os findings em português (pt-BR).

Responda APENAS com JSON neste formato, sem texto adicional:
{"findings": [{"severity": "grave"|"menor", "text": "..."}]}`;
}

/**
 * Interpreta a resposta do modelo crítico (função PURA — testável).
 *
 * Tolerante a JSON sujo: fences de código, texto ao redor do objeto e
 * severities em maiúsculas/variantes ("GRAVE", "Grave"). Qualquer severity que
 * não comece com "grave" vira "menor". Se nada parseável for encontrado,
 * retorna a resposta bruta (truncada) como um único finding menor — a crítica
 * nunca deve explodir.
 *
 * @param {string} text resposta bruta do modelo
 * @returns {{ grave: boolean, findings: Array<{ severity: 'grave'|'menor', text: string }> }}
 */
export function parseCritiqueResponse(text) {
  const raw = (text || '').trim();

  // Candidatos a JSON, do mais provável ao mais permissivo: conteúdo de fence
  // de código, resposta inteira, primeiro objeto {...} encontrado no texto.
  const candidates = [];
  const fence = raw.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue; // tenta o próximo candidato
    }
    const list = Array.isArray(parsed?.findings) ? parsed.findings
      : Array.isArray(parsed) ? parsed
      : null;
    if (!list) continue;
    const findings = list
      .filter(f => f && typeof f.text === 'string' && f.text.trim())
      .map(f => ({
        severity: /^grave/i.test(String(f.severity || '').trim()) ? 'grave' : 'menor',
        text: f.text.trim(),
      }));
    return { grave: findings.some(f => f.severity === 'grave'), findings };
  }

  // Fallback: resposta não-parseável → finding menor com a resposta bruta.
  if (!raw) return { grave: false, findings: [] };
  const truncated = raw.length > RAW_FALLBACK_MAX ? `${raw.slice(0, RAW_FALLBACK_MAX)}…` : raw;
  return { grave: false, findings: [{ severity: 'menor', text: truncated }] };
}

// Monta o comentário de issue a partir dos findings classificados.
function renderMarkdown(findings) {
  const header = '🔎 **Crítica adversarial (spec-wave)**';
  if (findings.length === 0) {
    return `${header}\n\n✅ crítica não encontrou contradições.`;
  }

  const graves = findings.filter(f => f.severity === 'grave');
  const menores = findings.filter(f => f.severity === 'menor');
  const parts = [header];
  if (graves.length > 0) {
    parts.push(`### ❌ Graves\n\n${graves.map(f => `- ${f.text}`).join('\n')}`);
  }
  if (menores.length > 0) {
    parts.push(`### ⚠️ Menores\n\n${menores.map(f => `- ${f.text}`).join('\n')}`);
  }
  parts.push(graves.length > 0
    ? `⛔ Há findings **graves**: a label \`${LABEL_CRITIQUE_FAILED}\` bloqueia o ` +
      `\`spec-wave:ready\` até ser removida após a correção dos pontos acima.`
    : `_Findings menores não bloqueiam o fluxo. Se houvesse graves, a label ` +
      `\`${LABEL_CRITIQUE_FAILED}\` bloquearia o \`spec-wave:ready\` até ser removida após correção._`);
  return parts.join('\n\n');
}

/**
 * Roda a crítica adversarial sobre os artefatos fornecidos.
 *
 * Seções ausentes (spec/plan/tech_context/stories) são simplesmente omitidas
 * do prompt. Erros de API PROPAGAM — o chamador deve tratar com try/catch e
 * seguir o fluxo principal (crítica indisponível não é fatal).
 *
 * @param {object} params
 * @param {'plan'|'stories'} params.kind o que está sendo auditado
 * @param {string} [params.spec] conteúdo do spec.md
 * @param {string} [params.plan] conteúdo do plan.md
 * @param {string} [params.techContextYaml] tech_context serializado em YAML
 * @param {object[]} [params.stories] stories propostas (antes da criação)
 * @returns {Promise<{ grave: boolean, findings: Array<{ severity: string, text: string }>, markdown: string }>}
 */
export async function runCritique({ kind, spec, plan, techContextYaml, stories } = {}) {
  const sections = [];
  if (spec) sections.push(`## spec.md\n\n${spec}`);
  if (plan) sections.push(`## plan.md\n\n${plan}`);
  if (techContextYaml) sections.push(`## tech_context\n\n\`\`\`yaml\n${techContextYaml}\n\`\`\``);
  if (stories) sections.push(`## Stories propostas (JSON)\n\n\`\`\`json\n${JSON.stringify(stories, null, 2)}\n\`\`\``);
  const userContent = sections.join('\n\n') || '(nenhum documento fornecido)';

  const raw = await generateDocument(buildSystemPrompt(kind), userContent, {
    action: 'critique',
    temperature: 0,
    maxTokens: 4096,
  });

  const { grave, findings } = parseCritiqueResponse(raw);
  return { grave, findings, markdown: renderMarkdown(findings) };
}
