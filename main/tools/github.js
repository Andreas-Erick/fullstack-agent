// Agent tools: GitHub through the gh CLI and git (github.js): read, clone, branch, commit, push, PRs.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const github = require('../github');
const { obj, str, int, bool, requireApproval } = require('./common');

const isCloned = (repo) => require('fs').promises.access(require('path').join(github.localPath(repo), '.git')).then(() => true, () => false);

module.exports = [
  {
    name: 'github_list_repos',
    group: 'github',
    description: "List the user's GitHub repositories (or another owner's/organisation's), most recently updated first.",
    parameters: obj({ owner: str('User or organisation (default: the signed-in user)'), limit: int('Max results (default 30)') }),
    run: async (a) => github.listRepos(a),
  },
  {
    name: 'github_repo',
    group: 'github',
    description: 'Overview of one repository: description, default branch, open issues/PRs, whether it is cloned locally and where.',
    parameters: obj({ repo: str('owner/name') }, ['repo']),
    run: async (a) => github.repoInfo(a.repo),
  },
  {
    name: 'github_issues',
    group: 'github',
    description: 'List issues of a repository, or open one (with comments) by number.',
    parameters: obj({ repo: str('owner/name'), number: int('Issue number to open (omit to list)'), state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['repo']),
    untrusted: true,
    run: async (a) => (a.number ? github.viewIssue(a.repo, a.number) : github.listIssues(a.repo, a)),
  },
  {
    name: 'github_pull_requests',
    group: 'github',
    description: 'List pull requests of a repository, or open one by number (description, changed files, CI checks, reviews; diff: true adds the diff).',
    parameters: obj({ repo: str('owner/name'), number: int('PR number to open (omit to list)'), state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] }, diff: bool('Include the diff') }, ['repo']),
    untrusted: true,
    run: async (a) => (a.number ? github.viewPullRequest(a.repo, a.number, a) : github.listPullRequests(a.repo, a)),
  },
  {
    name: 'github_read_file',
    group: 'github',
    description: 'Read a file from a repository: from the local clone when there is one (including uncommitted work), otherwise from GitHub. ref reads a branch, tag or commit on GitHub.',
    parameters: obj({ repo: str('owner/name'), path: str('File path in the repo'), ref: str('Branch, tag or commit (optional)') }, ['repo', 'path']),
    untrusted: true,
    run: async (a) => (!a.ref && (await isCloned(a.repo)) ? github.readFile(a.repo, a.path) : github.readRemoteFile(a.repo, a.path, a.ref)),
  },
  {
    name: 'github_search',
    group: 'github',
    description: 'Search code in a repository (case-insensitive): the local clone when there is one, otherwise GitHub code search. With a clone, pattern lists files instead (e.g. "src/**/*.ts").',
    parameters: obj({ repo: str('owner/name'), query: str('Text to find'), pattern: str('List files matching this path pattern (local clone only)') }, ['repo']),
    untrusted: true,
    run: async (a) => {
      const local = await isCloned(a.repo);
      if (a.pattern || !a.query) {
        if (!local) throw new Error('Listing files needs a local clone (github_clone).');
        return github.listFiles(a.repo, a.pattern);
      }
      return local ? github.search(a.repo, a.query) : github.searchCode(a.repo, a.query);
    },
  },
  {
    name: 'github_clone',
    group: 'github',
    description: "Clone a repository into the user's repos folder so you can work on it (or update an existing clone from GitHub). Returns the local path.",
    parameters: obj({ repo: str('owner/name') }, ['repo']),
    run: async (a) => github.clone(a.repo),
  },
  {
    name: 'github_start_branch',
    group: 'github',
    description: 'Create (or switch to) a work branch in a cloned repository, starting from the latest default branch. All changes happen on such a branch, never on the default branch. Name it after the work, e.g. "fix/login-timeout".',
    parameters: obj({ repo: str('owner/name'), branch: str('Branch name') }, ['repo', 'branch']),
    run: async (a) => github.startBranch(a.repo, a.branch),
  },
  {
    name: 'github_status',
    group: 'github',
    description: 'State of a local clone: current branch, changed files, whether it is pushed. diff: true adds the full diff of uncommitted work.',
    parameters: obj({ repo: str('owner/name'), diff: bool('Include the diff') }, ['repo']),
    run: async (a) => ({ ...(await github.repoStatus(a.repo)), ...(a.diff ? { diff: await github.diff(a.repo) } : {}) }),
  },
  {
    name: 'github_change_file',
    group: 'github',
    description:
      'Change a file in a cloned repository on its work branch: either replace old_text with new_text (old_text must occur exactly once; read the file first), or write the whole file with content (creates it if new). Approval follows the permission mode.',
    parameters: obj({ repo: str('owner/name'), path: str('File path in the repo'), old_text: str('Exact text to replace'), new_text: str('Replacement'), content: str('Whole new file content (instead of old_text/new_text)') }, ['repo', 'path']),
    run: async (a, ctx) => {
      const { branch } = await github.requireWorkBranch(a.repo);
      await requireApproval(ctx, 'repo_change', `Change files in ${a.repo} (branch ${branch})`, `${a.path}\n\n${String(a.content ?? a.new_text ?? '').slice(0, 600)}`);
      const file = a.content != null ? await github.writeFile(a.repo, a.path, a.content) : await github.editFile(a.repo, a.path, a.old_text, a.new_text ?? '');
      return { changed: file, branch };
    },
  },
  {
    name: 'github_commit',
    group: 'github',
    description: 'Commit all changes in a cloned repository on its work branch, with a clear message (what and why). Local only; github_push publishes.',
    parameters: obj({ repo: str('owner/name'), message: str('Commit message') }, ['repo', 'message']),
    run: async (a, ctx) => {
      const { branch } = await github.requireWorkBranch(a.repo);
      await requireApproval(ctx, 'repo_change', `Commit in ${a.repo} (branch ${branch})`, a.message);
      return github.commit(a.repo, a.message);
    },
  },
  {
    name: 'github_push',
    group: 'github',
    description: 'Push the work branch of a cloned repository to GitHub. Always asks the user first and shows exactly which commits go out. Never pushes the default branch.',
    parameters: obj({ repo: str('owner/name') }, ['repo']),
    run: async (a, ctx) => {
      const p = await github.pendingPush(a.repo);
      if (!p.commits.length) throw new Error('Nothing to push: every commit on this branch is already on GitHub.');
      const detail = `Branch: ${p.branch} (new commits for ${a.repo} on GitHub)\n\nCommits:\n${p.commits.join('\n')}\n\nFiles:\n${p.stat}${p.uncommitted ? '\n\n(Uncommitted changes stay local.)' : ''}`;
      await requireApproval(ctx, 'github_publish', `Push ${p.commits.length} commit${p.commits.length > 1 ? 's' : ''} to GitHub (${a.repo})`, detail);
      return github.push(a.repo);
    },
  },
  {
    name: 'github_create_pull_request',
    group: 'github',
    description: 'Open a pull request from the pushed work branch into the default branch (or base). Always asks the user first. Write a clear title and a body that says what changed, why, and how it was tested. You never merge; the user does.',
    parameters: obj({ repo: str('owner/name'), title: str('PR title'), body: str('PR description (Markdown)'), draft: bool('Open as a draft'), base: str('Target branch (default: the default branch)') }, ['repo', 'title']),
    run: async (a, ctx) => {
      const p = await github.pendingPush(a.repo);
      if (p.commits.length) throw new Error(`The branch has ${p.commits.length} commit(s) that are not on GitHub yet; push first (github_push).`);
      await requireApproval(ctx, 'github_publish', `Open a pull request in ${a.repo}`, `${p.branch} → ${a.base || p.main}${a.draft ? ' (draft)' : ''}\n\nTitle: ${a.title}\n\n${String(a.body || '').slice(0, 1500)}`);
      return github.createPullRequest(a.repo, a);
    },
  },
];
