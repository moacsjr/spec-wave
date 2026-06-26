import { issue } from './issue.mjs';

// `feature` é um atalho de `issue --type feature`, mantido para compatibilidade
// com a skill e o fluxo do RFC-001. Toda a lógica vive em issue.mjs.
export async function feature(options) {
  return issue({ ...options, type: 'feature' });
}
