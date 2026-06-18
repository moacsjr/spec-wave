import { graphql } from '@octokit/graphql';

function makeClient(token) {
  return graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
}

export async function createProject(token, ownerId, title) {
  const client = makeClient(token);
  const result = await client(`
    mutation CreateProject($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 {
          id
          number
          url
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
              }
            }
          }
        }
      }
    }
  `, { ownerId, title });

  const project = result.createProjectV2.projectV2;
  const statusField = project.fields.nodes.find(f => f.name === 'Status');
  return { projectId: project.id, projectNumber: project.number, projectUrl: project.url, statusFieldId: statusField?.id };
}

export async function updateStatusField(token, fieldId, options) {
  const client = makeClient(token);
  await client(`
    mutation UpdateStatusField($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      updateProjectV2Field(input: {
        fieldId: $fieldId
        singleSelectOptions: $options
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
          }
        }
      }
    }
  `, {
    fieldId,
    options: options.map(o => ({ name: o.name, color: o.color, description: '' })),
  });
}

export async function createSingleSelectField(token, projectId, name, options) {
  const client = makeClient(token);
  const result = await client(`
    mutation CreateField($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: SINGLE_SELECT
        name: $name
        singleSelectOptions: $options
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  `, {
    projectId,
    name,
    options: options.map(o => ({ name: o.name, color: o.color, description: o.description || '' })),
  });
  const field = result.createProjectV2Field.projectV2Field;
  const optionIds = {};
  for (const o of field.options) optionIds[o.name] = o.id;
  return { id: field.id, options: optionIds };
}

// Lê um campo SINGLE_SELECT existente (id + mapa nome→id das opções). Usado pelo
// comando `feature` como fallback quando o .spec-flow.json não traz os IDs.
export async function getSingleSelectField(token, projectId, fieldName) {
  const client = makeClient(token);
  const result = await client(`
    query GetField($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
  `, { projectId });
  const field = result.node.fields.nodes.find(f => f && f.name === fieldName);
  if (!field) return null;
  const optionIds = {};
  for (const o of field.options) optionIds[o.name] = o.id;
  return { id: field.id, options: optionIds };
}

// Lê os metadados atuais de um Project (id, number, url, title) + o campo "Etapa"
// (id e opções), em uma única query. Usado pelo comando `refresh`.
export async function getProjectSnapshot(token, projectId) {
  const client = makeClient(token);
  const result = await client(`
    query Snapshot($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          id
          number
          url
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
  `, { projectId });
  const project = result.node;
  if (!project) return null;
  const etapa = project.fields.nodes.find(f => f && f.name === 'Etapa');
  let etapaFieldId = null, stageOptions = null;
  if (etapa) {
    etapaFieldId = etapa.id;
    stageOptions = {};
    for (const o of etapa.options) stageOptions[o.name] = o.id;
  }
  return {
    id: project.id,
    number: project.number,
    url: project.url,
    title: project.title,
    etapaFieldId,
    stageOptions,
  };
}

// Adiciona uma issue/PR (pelo node id do conteúdo) ao Project. Retorna o id do item criado.
export async function addProjectItem(token, projectId, contentId) {
  const client = makeClient(token);
  const result = await client(`
    mutation AddItem($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `, { projectId, contentId });
  return result.addProjectV2ItemById.item.id;
}

// Define o valor de um campo SINGLE_SELECT para um item do Project.
export async function setItemSingleSelect(token, projectId, itemId, fieldId, optionId) {
  const client = makeClient(token);
  await client(`
    mutation SetField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `, { projectId, itemId, fieldId, optionId });
}

export async function createTextField(token, projectId, name) {
  const client = makeClient(token);
  const result = await client(`
    mutation CreateTextField($projectId: ID!, $name: String!) {
      createProjectV2Field(input: {
        projectId: $projectId
        dataType: TEXT
        name: $name
      }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
    }
  `, { projectId, name });
  return result.createProjectV2Field.projectV2Field.id;
}

export async function linkProjectToRepo(token, projectId, repositoryId) {
  const client = makeClient(token);
  await client(`
    mutation LinkProject($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: {
        projectId: $projectId
        repositoryId: $repositoryId
      }) {
        repository {
          id
        }
      }
    }
  `, { projectId, repositoryId });
}
