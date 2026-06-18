import {
  createProject,
  createSingleSelectField,
  createTextField,
  linkProjectToRepo,
} from '../api/github-graphql.mjs';
import { getOwnerNodeId, getRepoNodeId } from '../api/github-rest.mjs';
import { STATUS_OPTIONS, CUSTOM_FIELDS } from '../config.mjs';

// The GitHub Projects v2 API does not allow replacing the built-in Status field
// options atomically ("Position has already been taken" error). We create a custom
// "Etapa" field with the RFC-001 kanban columns instead, and configure the board
// view to group by it.
const ETAPA_FIELD = {
  name: 'Etapa',
  dataType: 'SINGLE_SELECT',
  options: STATUS_OPTIONS,
};

export async function setupProject(token, owner, repo, projectTitle, spinner) {
  spinner.message('Buscando IDs do owner e repositório...');
  const [ownerId, repositoryId] = await Promise.all([
    getOwnerNodeId(token, owner),
    getRepoNodeId(token, owner, repo),
  ]);

  spinner.message('Criando GitHub Project...');
  const { projectId, projectNumber, projectUrl } = await createProject(token, ownerId, projectTitle);

  spinner.message('Criando campos customizados...');
  const selectFields = CUSTOM_FIELDS.filter(f => f.dataType === 'SINGLE_SELECT');
  const textFields = CUSTOM_FIELDS.filter(f => f.dataType === 'TEXT');
  const allFields = [ETAPA_FIELD, ...selectFields];

  // Sequential creation: the GitHub Projects v2 API raises "Position has already
  // been taken" when multiple SINGLE_SELECT fields are created concurrently.
  let etapaFieldId, stageOptions;
  for (const f of allFields) {
    spinner.message(`Criando campo "${f.name}"...`);
    const created = await createSingleSelectField(token, projectId, f.name, f.options);
    if (f.name === ETAPA_FIELD.name) {
      etapaFieldId = created.id;
      stageOptions = created.options;
    }
  }
  for (const f of textFields) {
    spinner.message(`Criando campo "${f.name}"...`);
    await createTextField(token, projectId, f.name);
  }

  const result = { projectId, projectNumber, projectUrl, etapaFieldId, stageOptions };

  spinner.message('Vinculando projeto ao repositório...');
  try {
    await linkProjectToRepo(token, projectId, repositoryId);
  } catch (err) {
    // Linking is cosmetic (shows project in repo's Projects tab).
    // It requires `repo` scope in addition to `project`. Skip gracefully.
    spinner.message('');
    return { ...result, linkWarning: err.message };
  }

  return result;
}
