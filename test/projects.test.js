'use strict';
// GitHub project boards in the dashboard, against a stand-in for GitHub's GraphQL API.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { createSandbox } = require('./helpers');
const { parseProject, fetchProject, commitRefs, summarizeProjects } = require('../bin/lib/projects');

const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\n`;
const STATUSES = ['Todo', 'In Progress', 'Done'];
const issue = (number, title, status, extra = {}) => ({
  isArchived: false,
  status: status ? { name: status } : null,
  content: {
    __typename: 'Issue', number, title, url: `https://github.com/Test/ModP/issues/${number}`, issueState: 'OPEN',
    repository: { nameWithOwner: 'Test/ModP' }, labels: { nodes: [] }, ...extra,
  },
});
// Two pages, to check that all of a board is read.
const PAGES = [
  [
    issue(1, 'Crash on load', 'In Progress'),
    issue(2, 'Wrong tooltip', 'Todo'),
    issue(3, 'Old crash', 'Done', { issueState: 'CLOSED' }),
    { ...issue(4, 'Archived', 'Todo'), isArchived: true },
  ],
  [
    issue(7, 'Fluid dupe', 'Done', { issueState: 'CLOSED' }),
    issue(8, 'Closed but not moved', 'Todo', { issueState: 'CLOSED' }),
    issue(9, 'Unsorted', null),
    { isArchived: false, status: { name: 'Todo' }, content: { __typename: 'DraftIssue', title: 'An idea' } },
  ],
];
let sb;
let server;
let scopes = true;
const queries = [];

before(async () => {
  sb = createSandbox('cc-projects-test-');
  fs.appendFileSync(sb.env.GIT_CONFIG_GLOBAL, `[url "${sb.path('origin')}/"]\n\tinsteadOf = https://github.com/Test/\n`);
  const w = sb.newMod('ModP');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(w, 'Initial', { 'gradle.properties': props('1.21.1', '1.0.0'), 'src/main/java/P.java': 'p' });
  sb.git(w, 'tag', '-a', '-m', 'Release', '1.21.1-1.0.0');
  // Unreleased: the fix for #7, which the board already has as done.
  sb.commit(w, 'Fix fluid dupe\n\nCloses #7', { 'src/main/java/P.java': 'p2' });
  sb.git(w, 'push', '-q', '--tags', 'origin', 'master-1.21-lts');
  sb.git(sb.dir, 'clone', '-q', '-b', 'master-1.21-lts', 'https://github.com/Test/ModP.git', sb.path('mc21-lts', 'ModP'));
  sb.write(sb.path('cc-helpers.json'), JSON.stringify({
    versions: [{ dir: sb.path('mc21-lts'), branch: 'master-1.21-lts' }],
    dashboard: { insights: false, projects: ['https://github.com/orgs/Test/projects/3', 'nonsense'] },
  }));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(body);
      queries.push({ query, variables });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!/projectV2/.test(query)) return res.end(JSON.stringify({ data: {} }));
      if (!scopes) {
        return res.end(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes." }] }));
      }
      const page = variables.after ? 1 : 0;
      res.end(JSON.stringify({ data: { owner: { projectV2: {
        title: 'Maintenance',
        url: 'https://github.com/orgs/Test/projects/3',
        status: { options: STATUSES.map(name => ({ name })) },
        items: { pageInfo: { hasNextPage: page === 0, endCursor: page === 0 ? 'c1' : null }, nodes: PAGES[page] },
      } } } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, sb.env, {
    CC_HELPERS_CONFIG: sb.path('cc-helpers.json'),
    GH_TOKEN: 'secret',
    CC_HELPERS_GITHUB_API: `http://127.0.0.1:${server.address().port}/graphql`,
  });
});

after(() => {
  server.close();
  sb.cleanup();
});

test('reads boards from their URL or owner/number', () => {
  assert.deepStrictEqual(parseProject('https://github.com/orgs/CyclopsMC/projects/3/views/1'), { owner: 'CyclopsMC', number: 3, user: false });
  assert.deepStrictEqual(parseProject('CyclopsMC/4'), { owner: 'CyclopsMC', number: 4, user: false });
  assert.deepStrictEqual(parseProject('https://github.com/users/someone/projects/2'), { owner: 'someone', number: 2, user: true });
  assert.strictEqual(parseProject('https://github.com/CyclopsMC/CyclopsCore'), null);
});

test('finds the issues and pull requests a commit closes', () => {
  const refs = (subject, body = '') => [...commitRefs({ subject, body }, 'Test/ModP')];
  assert.deepStrictEqual(refs('Fix crash', 'Closes #12'), ['test/modp#12']);
  assert.deepStrictEqual(refs('Fix things', 'Fixes #1, #2 and Other/Repo#3'), ['test/modp#1', 'test/modp#2', 'other/repo#3']);
  // A merged pull request, as GitHub names its commit.
  assert.deepStrictEqual(refs('Fix storage extraction (#49)'), ['test/modp#49']);
  assert.deepStrictEqual(refs('Mention #4 in the docs', 'Related to #5'), []);
});

test('reads every page of a board, and skips archived items', async () => {
  const board = await fetchProject({ owner: 'Test', number: 3, user: false });
  assert.strictEqual(board.title, 'Maintenance');
  assert.deepStrictEqual(board.statuses, STATUSES);
  assert.deepStrictEqual(board.items.map(i => i.number || i.title), [1, 2, 3, 7, 8, 9, 'An idea']);
  assert.strictEqual(board.items.find(i => i.number === 3).state, 'CLOSED');
  assert.strictEqual(board.items.find(i => i.title === 'An idea').kind, 'draft');
});

test('says how to add the scope when the token lacks it', async () => {
  scopes = false;
  try {
    await assert.rejects(fetchProject({ owner: 'Test', number: 3, user: false }),
      /The GitHub token lacks the read:project scope: run gh auth refresh -s read:project\./);
  } finally {
    scopes = true;
  }
});

test('sums up a board: active columns furthest first, and fixes that are not released yet', async () => {
  const data = await fetchProject({ owner: 'Test', number: 3, user: false });
  const mods = [{ name: 'ModP', repo: 'Test/ModP', unreleased: [
    { version: '1.21-lts', commits: [{ subject: 'Fix fluid dupe', body: 'Closes #7' }, { subject: 'Fix crash on load', body: 'Fixes #1' }] },
    { version: '26', commits: [{ subject: 'Fix fluid dupe', body: 'Closes #7' }] },
  ] }];
  const { projects: [b], perMod } = summarizeProjects([{ spec: 'x', data, error: null }], mods, { perColumn: 1 });
  // Done is the last status; a closed issue is done whatever its column.
  assert.deepStrictEqual(b.columns.map(c => [c.name, c.count, c.items.map(i => i.number || i.title)]),
    [['In Progress', 1, [1]], ['Todo', 2, [2]], [null, 1, [9]]]);
  assert.deepStrictEqual([b.open, b.done], [4, 3]);
  assert.deepStrictEqual(b.unreleased.map(i => [i.number, i.unreleased]), [[7, ['1.21-lts', '26']]]);
  // The panel: furthest along first, done but not released last; an open item notes its unreleased fix.
  assert.deepStrictEqual(perMod.ModP.map(i => [i.number, i.status, i.unreleased]),
    [[1, 'In Progress', ['1.21-lts']], [2, 'Todo', []], [9, null, []], [7, 'Done', ['1.21-lts', '26']]]);
});

test('shows the boards of the config, with the commits that are not released yet', async () => {
  const { Monitor } = require('../bin/lib/monitor');
  const monitor = new Monitor({ options: {} });
  try {
    monitor.reload();
    await monitor.request('local');
    await monitor.refreshProjects();
    const { projects } = monitor.snapshot().projects;
    assert.strictEqual(projects[0].title, 'Maintenance');
    assert.deepStrictEqual(projects[0].unreleased.map(i => [i.mod, i.number, i.unreleased]), [['ModP', 7, ['1.21-lts']]]);
    assert.deepStrictEqual(projects[1], { spec: 'nonsense', error: 'Not a project board: nonsense' });
    assert.ok(queries.some(q => q.variables.owner === 'Test' && q.variables.number === 3));
  } finally {
    monitor.stop();
  }
});
