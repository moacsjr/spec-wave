import { issue } from './issue.mjs';

// `initiative` é um atalho de `issue --type initiative`. A Initiative é o nó raiz
// da hierarquia (Initiative → Epic → Feature → Story → Task) e agrupa Epics.
// Toda a lógica vive em issue.mjs.
export async function initiative(options) {
  return issue({ ...options, type: 'initiative' });
}
