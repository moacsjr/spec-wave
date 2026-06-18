import { execSync } from 'node:child_process';

export async function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated
  }
  throw new Error(
    'GitHub token not found.\n' +
    'Set GITHUB_TOKEN or GH_TOKEN environment variable, or run: gh auth login'
  );
}

export async function verifyTokenScopes(token) {
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({ auth: token });
  try {
    const response = await octokit.request('GET /user');
    const scopes = response.headers['x-oauth-scopes'] || '';
    const scopeList = scopes.split(',').map(s => s.trim());
    const hasProject = scopeList.includes('project') || scopeList.includes('read:project');
    // `repo` covers private repos; `public_repo` covers public-only repos
    const hasRepo = scopeList.includes('repo') || scopeList.includes('public_repo');
    // `workflow` is required to create/update files under .github/workflows/
    const hasWorkflow = scopeList.includes('workflow');
    return { login: response.data.login, hasProject, hasRepo, hasWorkflow, scopes: scopeList };
  } catch (err) {
    throw new Error(`Token verification failed: ${err.message}`);
  }
}
