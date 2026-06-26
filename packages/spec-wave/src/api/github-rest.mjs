import { Octokit } from '@octokit/rest';

function makeOctokit(token) {
  return new Octokit({ auth: token });
}

export async function getOwnerNodeId(token, owner) {
  const octokit = makeOctokit(token);
  try {
    const res = await octokit.rest.orgs.get({ org: owner });
    return res.data.node_id;
  } catch {
    const res = await octokit.rest.users.getByUsername({ username: owner });
    return res.data.node_id;
  }
}

export async function getRepoNodeId(token, owner, repo) {
  const octokit = makeOctokit(token);
  const res = await octokit.rest.repos.get({ owner, repo });
  return res.data.node_id;
}

export async function getRepoDefaultBranch(token, owner, repo) {
  const octokit = makeOctokit(token);
  const res = await octokit.rest.repos.get({ owner, repo });
  return res.data.default_branch;
}

export async function createLabel(token, owner, repo, label) {
  const octokit = makeOctokit(token);
  try {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: label.name,
      color: label.color,
      description: label.description,
    });
  } catch (err) {
    // 422 = label already exists, skip
    if (err.status !== 422) throw err;
  }
}

export async function upsertFile(token, owner, repo, path, content, message) {
  const octokit = makeOctokit(token);
  let sha;
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path });
    sha = existing.data.sha;
  } catch {
    // file doesn't exist yet
  }
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

export async function createIssue(token, owner, repo, title, body, labels) {
  const octokit = makeOctokit(token);
  const res = await octokit.rest.issues.create({ owner, repo, title, body, labels });
  return { number: res.data.number, nodeId: res.data.node_id, url: res.data.html_url };
}

export async function getIssue(token, owner, repo, issueNumber) {
  const octokit = makeOctokit(token);
  const res = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  return res.data;
}

export async function deleteLabel(token, owner, repo, name) {
  const octokit = makeOctokit(token);
  try {
    await octokit.rest.issues.deleteLabel({ owner, repo, name });
    return true;
  } catch (err) {
    if (err.status === 404) return false; // label já não existe
    throw err;
  }
}

export async function deleteFile(token, owner, repo, filePath, message) {
  const octokit = makeOctokit(token);
  let sha;
  try {
    const existing = await octokit.rest.repos.getContent({ owner, repo, path: filePath });
    sha = existing.data.sha;
  } catch (err) {
    if (err.status === 404) return false; // arquivo já não existe
    throw err;
  }
  await octokit.rest.repos.deleteFile({ owner, repo, path: filePath, message, sha });
  return true;
}

export async function addLabel(token, owner, repo, issueNumber, labelName) {
  const octokit = makeOctokit(token);
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [labelName],
  });
}

export async function removeLabel(token, owner, repo, issueNumber, labelName) {
  const octokit = makeOctokit(token);
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: labelName,
    });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

export async function commentOnIssue(token, owner, repo, issueNumber, body) {
  const octokit = makeOctokit(token);
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

export async function isRepoInitialized(token, owner, repo) {
  const octokit = makeOctokit(token);
  try {
    await octokit.rest.repos.listCommits({ owner, repo, per_page: 1 });
    return true;
  } catch (err) {
    // GitHub returns 409 "Git Repository is empty" for repos with no commits
    if (err.status === 409 || err.status === 404) return false;
    throw err;
  }
}

export async function getPR(token, owner, repo, prNumber) {
  const octokit = makeOctokit(token);
  const res = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return res.data;
}

export async function getFileContent(token, owner, repo, path) {
  const octokit = makeOctokit(token);
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path });
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
