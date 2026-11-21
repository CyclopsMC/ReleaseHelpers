'use strict';
// The dashboard's monitor against a stand-in for GitHub's GraphQL API: CI states and planned fetches.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { createSandbox } = require('./helpers');

const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\n`;
let sb;
let server;
const queries = [];

before(async () => {
  sb = createSandbox('cc-monitor-test-');
  // Remotes on "GitHub" are served from the local origins.
  fs.appendFileSync(sb.env.GIT_CONFIG_GLOBAL, `[url "${sb.path('origin')}/"]\n\tinsteadOf = https://github.com/Test/\n`);
  const w = sb.newMod('ModG');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  sb.commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/G.java': 'g' });
  sb.git(w, 'tag', '-a', '-m', 'Release', '1.20.1-1.0.0');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '2.0.0') });
  sb.git(w, 'tag', '-a', '-m', 'Release', '1.21.1-2.0.0');
  sb.git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');
  for (const [dir, branch] of [['mc20-lts', 'master-1.20-lts'], ['mc21-lts', 'master-1.21-lts']]) {
    sb.git(sb.dir, 'clone', '-q', '-b', branch, 'https://github.com/Test/ModG.git', sb.path(dir, 'ModG'));
  }
  sb.write(sb.path('mc21-lts', '.upmerge-src-branch'), 'master-1.20-lts\n');
  sb.write(sb.path('cc-helpers.json'), JSON.stringify({ versions: [
    { dir: sb.path('mc20-lts'), branch: 'master-1.20-lts' },
    { dir: sb.path('mc21-lts'), branch: 'master-1.21-lts' },
  ] }));

  // Both commits fail by their combined state, the 1.21 one only by a check outside GitHub Actions.
  const c20 = sb.git(w, 'rev-parse', 'master-1.20-lts').trim();
  const c21 = sb.git(w, 'rev-parse', 'master-1.21-lts').trim();
  const rollups = { [c20]: 'FAILURE', [c21]: 'FAILURE' };
  const run = (workflow, event, conclusion, createdAt) => ({ status: 'COMPLETED', conclusion, createdAt, workflowRun: { event, workflow: { name: workflow } } });
  // GitHub Actions runs per commit, in pages.
  const suites = {
    [c20]: [[run('CI', 'push', 'FAILURE', '2026-11-01T10:00:00Z')]],
    // CI failed on the push of the branch, passed on the push of the tag; a scheduled job failed later.
    [c21]: [
      [run('CI', 'push', 'FAILURE', '2026-11-02T10:00:00Z'), { status: 'QUEUED', conclusion: null, createdAt: '2026-11-02T10:00:00Z', workflowRun: null }],
      [run('CI', 'push', 'SUCCESS', '2026-11-02T10:05:00Z'), run('Crowdin', 'schedule', 'FAILURE', '2026-11-03T03:00:00Z')],
    ],
  };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { query } = JSON.parse(body);
      queries.push(query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (/checkSuites/.test(query)) {
        const data = {};
        for (const m of query.matchAll(/(c\d+): repository\([^)]*\) \{\s*object\(oid: "(\w+)"\) \{ \.\.\. on Commit \{ checkSuites\(first: 100(?:, after: "(\d+)")?/g)) {
          const pages = suites[m[2]] || [[]];
          const page = m[3] ? Number(m[3]) : 0;
          data[m[1]] = { object: { checkSuites: { pageInfo: { hasNextPage: page + 1 < pages.length, endCursor: String(page + 1) }, nodes: pages[page] } } };
        }
        return res.end(JSON.stringify({ data }));
      }
      const refs = sb.git(sb.path('origin', 'ModG.git'), 'for-each-ref', '--format=%(refname) %(objectname) %(*objectname)').trim().split('\n').map(l => l.split(' '));
      const nodes = prefix => refs.filter(([r]) => r.startsWith(prefix)).map(([r, oid]) => {
        const name = r.slice(prefix.length);
        return { name, target: { oid, statusCheckRollup: { state: rollups[oid] } } };
      });
      const repo = {
        heads: { nodes: nodes('refs/heads/') },
        tags: { nodes: nodes('refs/tags/').map(n => ({ name: n.name, target: { oid: n.target.oid } })) },
        openIssues: { totalCount: 3 },
        openPullRequests: { totalCount: 1 },
      };
      for (const m of query.matchAll(/(release\d+): ref\(qualifiedName: "(refs\/tags\/[^"]+)"\)/g)) {
        // An annotated tag, and its commit.
        const [, tagOid, oid] = refs.find(([r]) => r === m[2]);
        repo[m[1]] = { target: { oid: tagOid, target: { oid, statusCheckRollup: { state: rollups[oid] } } } };
      }
      res.end(JSON.stringify({ data: { r0: repo } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, sb.env, {
    CC_HELPERS_CONFIG: sb.path('cc-helpers.json'),
    GH_TOKEN: 'secret',
    CC_HELPERS_GITHUB_API: `http://127.0.0.1:${server.address().port}/graphql`,
  });
});

after(() => server.close());

test('shows the CI state of branches and releases, and fetches only what changed', async () => {
  const { Monitor } = require('../bin/lib/monitor');
  const monitor = new Monitor({ options: { localInterval: 3600, remoteInterval: 3600 } });
  try {
    monitor.reload();
    await monitor.request('local');
    await monitor.request('remote');
    const cells = monitor.snapshot().mods.find(m => m.name === 'ModG').cells;
    // Only GitHub Actions counts: the latest run of each workflow that a push started.
    assert.deepStrictEqual(cells.map(c => [c.ci, c.releaseCi]), [['FAILURE', 'FAILURE'], ['SUCCESS', 'SUCCESS']]);
    // Once per failing commit, and the next page where there is one.
    const suiteQueries = () => queries.filter(q => /checkSuites/.test(q));
    assert.strictEqual(suiteQueries().length, 2);
    assert.strictEqual((suiteQueries()[0].match(/object\(oid:/g) || []).length, 2);
    assert.match(suiteQueries()[1], /after: "1"/);
    // It asked for the last releases it knew of.
    assert.match(queries[0], /release0: ref\(qualifiedName: "refs\/tags\/1\.20\.1-1\.0\.0"\)/);
    assert.strictEqual(monitor.info.github, 'ok');
    // The same request counts the open issues and pull requests.
    assert.match(queries[0], /openIssues: issues\(states: OPEN\) \{ totalCount \}/);
    assert.deepStrictEqual(monitor.snapshot().insights.github, { mods: [{ name: 'ModG', issues: 3, prs: 1 }], issues: 3, prs: 1 });

    // Nothing changed on origin: nothing to fetch, and the Actions states are still known.
    await monitor.request('remote');
    assert.strictEqual(monitor.info.fetched.count, 0);
    assert.strictEqual(suiteQueries().length, 2);
    assert.deepStrictEqual(monitor.snapshot().mods.find(m => m.name === 'ModG').cells.map(c => c.ci), ['FAILURE', 'SUCCESS']);

    // A new commit on origin: only those checkouts are fetched.
    const w = sb.path('work', 'ModG');
    sb.git(w, 'checkout', '-q', 'master-1.21-lts');
    sb.commit(w, 'Fix G', { 'src/main/java/G.java': 'g2' });
    sb.git(w, 'push', '-q', 'origin', 'master-1.21-lts');
    await monitor.request('remote');
    assert.strictEqual(monitor.info.fetched.count, 1);
    assert.strictEqual(monitor.info.fetched.total, 2);
    assert.deepStrictEqual(monitor.snapshot().mods.find(m => m.name === 'ModG').cells.map(c => c.text), ['.', '1']);
  } finally {
    monitor.stop();
  }
});

test('sums up GitHub Actions runs', () => {
  const { actionsState } = require('../bin/lib/github');
  const run = (event, status, conclusion) => ({ status, conclusion, createdAt: '2026-11-01T10:00:00Z', workflowRun: { event, workflow: { name: 'CI' } } });
  assert.strictEqual(actionsState([]), null);
  assert.strictEqual(actionsState([run('schedule', 'COMPLETED', 'FAILURE')]), null);
  assert.strictEqual(actionsState([run('push', 'IN_PROGRESS', null)]), 'PENDING');
  assert.strictEqual(actionsState([run('push', 'COMPLETED', 'SKIPPED')]), 'SUCCESS');
  assert.strictEqual(actionsState([run('push', 'COMPLETED', 'CANCELLED')]), 'FAILURE');
});
