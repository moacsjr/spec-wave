import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, getProvider, DEFAULT_PROVIDER } from '../config.mjs';
import { lintLanguage } from './output-lint.mjs';

/**
 * Resolve provider/modelo de IA (função PURA — testável sem process.env nem fs).
 *
 * Precedência do modelo: env.SPEC_WAVE_MODEL → fileAi.models[action] →
 * fileAi.model → default do provider. Provider: env.SPEC_WAVE_PROVIDER →
 * fileAi.provider → default. Assim uma ação específica (ex.: critique) pode
 * usar modelo próprio via bloco `ai.models` do .spec-wave.json.
 *
 * @param {object} params
 * @param {object} [params.env] objeto tipo process.env
 * @param {object} [params.fileAi] bloco `ai` do .spec-wave.json
 * @param {string} [params.action] ação de IA (ver AI_ACTIONS em config.mjs)
 * @returns {{ provider: string, model: string, secret: string }}
 */
export function resolveAiConfig({ env = {}, fileAi = {}, action } = {}) {
  const provider = (env.SPEC_WAVE_PROVIDER || fileAi.provider || DEFAULT_PROVIDER).toLowerCase();
  const meta = getProvider(provider) || getProvider(DEFAULT_PROVIDER);
  const model = env.SPEC_WAVE_MODEL
    || (action && fileAi.models?.[action])
    || fileAi.model
    || meta.defaultModel;
  return { provider: meta.value, model, secret: meta.secret };
}

// Resolve o provider/modelo de IA a partir do .spec-wave.json (gravado pelo init
// e versionado no repo) com precedência para variáveis de ambiente — assim os
// workflows usam exatamente o que foi escolhido no init, sem depender de flags.
// Wrapper fino: lê o arquivo e delega a decisão à resolveAiConfig (pura).
function resolveAi(action) {
  let fileAi = {};
  try {
    const configPath = path.join(process.cwd(), CONFIG_FILE);
    if (existsSync(configPath)) {
      fileAi = JSON.parse(readFileSync(configPath, 'utf-8')).ai || {};
    }
  } catch {
    // config ausente/corrompido → cai nos defaults/env
  }
  return resolveAiConfig({ env: process.env, fileAi, action });
}

// temperature padrão 0.2 (RFC-002 §5): "Determinism over Creativity". Pode ser
// sobrescrita por chamada via opts, mas o default cobre spec/plan/decompose.
//
// opts:
//  • action: ação de IA ('spec'|'plan'|'decompose'|'critique') — permite modelo
//    por ação via `ai.models` do .spec-wave.json;
//  • lint: { lang } — após gerar, roda lintLanguage no resultado; se reprovar,
//    RE-GERA uma única vez com instrução de idioma reforçada; se reprovar de
//    novo, segue com o conteúdo e reporta os findings;
//  • withReport: true → retorna { content, lintFindings, retried } em vez da
//    string (o retorno string é mantido para os chamadores existentes).
export async function generateDocument(systemPrompt, userContent, opts = {}) {
  const ai = resolveAi(opts.action);
  const temperature = opts.temperature ?? 0.2;
  // Modelos de reasoning (ex.: deepseek-r1) consomem tokens "pensando" antes da
  // resposta, então o teto precisa ser maior para o plano não vir truncado.
  const maxTokens = opts.maxTokens ?? 8192;
  console.log(`Provider de IA: ${ai.provider} · modelo: ${ai.model} · temperature: ${temperature} · max_tokens: ${maxTokens}`);

  const generate = async (system) => {
    const raw = ai.provider === 'openrouter'
      ? await generateWithOpenRouter(system, userContent, ai, temperature, maxTokens)
      : await generateWithAnthropic(system, userContent, ai, temperature, maxTokens);
    return stripOuterFence(raw);
  };

  let content = await generate(systemPrompt);
  let lintFindings = [];
  let retried = false;

  if (opts.lint) {
    const lang = opts.lint.lang || 'pt-BR';
    const allowlist = opts.lint.allowlist || [];
    let result = lintLanguage(content, { lang, allowlist });
    if (!result.ok) {
      // Uma única nova tentativa, com a instrução de idioma reforçada no system
      // prompt — cobre o caso de modelos que vazam caracteres CJK/cirílicos.
      retried = true;
      console.warn(`Lint de idioma reprovou a saída (${result.findings.length} ocorrência(s)) — re-gerando com instrução reforçada.`);
      const reinforced = systemPrompt +
        `\n\nIMPORTANTE: responda exclusivamente em ${lang}. ` +
        'Não use caracteres de outros alfabetos (CJK, cirílico, árabe, tailandês).';
      content = await generate(reinforced);
      result = lintLanguage(content, { lang, allowlist });
      if (!result.ok) {
        // Segue com o conteúdo mesmo assim; o chamador decide o que fazer.
        console.warn(`Lint de idioma reprovou novamente (${result.findings.length} ocorrência(s)) — seguindo com o conteúdo gerado.`);
        lintFindings = result.findings;
      }
    }
  }

  return opts.withReport ? { content, lintFindings, retried } : content;
}

// Remove blocos de raciocínio que alguns modelos (ex.: deepseek-r1) embutem no
// content. A OpenRouter normalmente separa em `reasoning`, mas isto é uma rede
// de segurança caso o <think> venha junto do conteúdo final.
function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Alguns modelos (ex.: deepseek-r1) envolvem o documento inteiro numa fence
// ```markdown ... ```. Removemos só o wrapper externo (a primeira e a última
// linha de cerca), preservando fences internas (gherkin, typescript, etc.).
function stripOuterFence(text) {
  const t = (text || '').trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  return m ? m[1].trim() : t;
}

async function generateWithAnthropic(systemPrompt, userContent, ai, temperature, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not set.\n' +
      'Add it as a GitHub Actions secret or set it in your environment.'
    );
  }

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: ai.model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'user', content: userContent }],
    system: systemPrompt,
  });

  return message.content[0].text;
}

async function generateWithOpenRouter(systemPrompt, userContent, ai, temperature, maxTokens) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY not set.\n' +
      'Add it as a GitHub Actions secret or set it in your environment.'
    );
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/moacsjr/spec-wave',
      'X-Title': 'spec-wave',
    },
    body: JSON.stringify({
      model: ai.model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = stripReasoning(data?.choices?.[0]?.message?.content || '');
  if (!content) {
    throw new Error(`OpenRouter retornou resposta vazia: ${JSON.stringify(data)}`);
  }
  return content;
}
