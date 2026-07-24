// Helpers compartilhados de manipulação do board (GitHub Projects v2).
// Extraídos de code-review.mjs/qa.mjs para uso também pelos comandos de CLI
// (task/story/order). Ver a distinção Etapa × Status em config.mjs.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addProjectItem, setItemSingleSelect, getSingleSelectField, getItemSingleSelectValue } from '../api/github-graphql.mjs';
import { CONFIG_FILE, STAGE_ORDER } from '../config.mjs';

/**
 * Carrega o bloco `project` do .spec-wave.json do diretório atual.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()] diretório onde procurar o config
 * @returns {{ project: object|null, error: string|null }} project = bloco com
 *          id/fields; error = motivo legível quando project é null (compõe os
 *          avisos "… — board não atualizado." dos chamadores).
 */
export function loadProjectConfig({ cwd = process.cwd() } = {}) {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    return { project: null, error: `${CONFIG_FILE} não encontrado` };
  }
  let project;
  try {
    project = JSON.parse(readFileSync(configPath, 'utf-8')).project || {};
  } catch (err) {
    return { project: null, error: `${CONFIG_FILE} corrompido (${err.message})` };
  }
  if (!project.id) {
    return { project: null, error: `Project não configurado em ${CONFIG_FILE}` };
  }
  return { project, error: null };
}

/**
 * Resolve um campo SINGLE_SELECT do Project pelo nome: usa os IDs gravados no
 * .spec-wave.json (bloco `fields`, ou o formato legado etapaFieldId/
 * stageOptions para "Etapa") e cai na API GraphQL como fallback.
 *
 * @param {string} token
 * @param {object} project bloco project do .spec-wave.json (precisa de .id)
 * @param {string} name nome do campo (ex.: 'Etapa', 'Status')
 * @returns {Promise<{ id: string, options: Record<string,string> }|null>}
 */
export async function resolveField(token, project, name) {
  if (project.fields?.[name]) return project.fields[name];
  if (name === 'Etapa' && project.etapaFieldId) {
    return { id: project.etapaFieldId, options: project.stageOptions || {} };
  }
  return await getSingleSelectField(token, project.id, name);
}

/**
 * Avança um item do board para `targetStage` (Etapa) e define o Status para
 * `targetStatus`. Uma issue só AVANÇA: se já estiver em `targetStage` ou em uma
 * etapa posterior (pela ordem canônica STAGE_ORDER), não é tocada.
 *
 * @param {string} token token com scope project
 * @param {object} project bloco project (precisa de .id)
 * @param {{id,options}|null} etapaField campo "Etapa" (ver resolveField)
 * @param {{id,options}|null} statusField campo nativo "Status"
 * @param {string} nodeId node id da issue
 * @param {string} targetStage nome da etapa de destino
 * @param {string} targetStatus valor do Status (Todo/In Progress/Done)
 * @returns {Promise<boolean>} true se avançou; false se já estava adiante
 */
export async function advanceToStage(token, project, etapaField, statusField, nodeId, targetStage, targetStatus) {
  const itemId = await addProjectItem(token, project.id, nodeId);

  if (etapaField?.id && targetStage) {
    // Nunca retroceder: compara a etapa atual com a de destino na ordem canônica.
    const current = await getItemSingleSelectValue(token, itemId, etapaField.id).catch(() => null);
    const curIdx = current ? STAGE_ORDER.indexOf(current) : -1;
    const tgtIdx = STAGE_ORDER.indexOf(targetStage);
    if (curIdx !== -1 && tgtIdx !== -1 && curIdx >= tgtIdx) {
      return false; // já está nessa etapa ou adiante — não retrocede
    }
    const optionId = etapaField.options?.[targetStage];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, etapaField.id, optionId);
  }
  if (statusField?.id && targetStatus) {
    const optionId = statusField.options?.[targetStatus];
    if (optionId) await setItemSingleSelect(token, project.id, itemId, statusField.id, optionId);
  }
  return true;
}

/**
 * Define APENAS o Status nativo (Todo/In Progress/Done) de um item, sem tocar
 * na Etapa — usado para marcar progresso dentro da etapa atual.
 *
 * @param {string} token token com scope project
 * @param {object} project bloco project (precisa de .id)
 * @param {{id,options}|null} statusField campo nativo "Status"
 * @param {string} nodeId node id da issue
 * @param {string} status valor de destino (Todo/In Progress/Done)
 * @returns {Promise<boolean>} true se definiu; false se campo/opção ausentes
 */
export async function setItemStatus(token, project, statusField, nodeId, status) {
  if (!statusField?.id) return false;
  const optionId = statusField.options?.[status];
  if (!optionId) return false;
  const itemId = await addProjectItem(token, project.id, nodeId);
  await setItemSingleSelect(token, project.id, itemId, statusField.id, optionId);
  return true;
}
