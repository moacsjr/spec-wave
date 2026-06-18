import { createLabel } from '../api/github-rest.mjs';
import { ALL_LABELS } from '../config.mjs';

const DELAY_MS = 120;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function setupLabels(token, owner, repo, spinner) {
  for (let i = 0; i < ALL_LABELS.length; i++) {
    const label = ALL_LABELS[i];
    spinner.message(`Criando label ${i + 1}/${ALL_LABELS.length}: ${label.name}`);
    await createLabel(token, owner, repo, label);
    if (i < ALL_LABELS.length - 1) await sleep(DELAY_MS);
  }
}
