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

  // CI fails on the 1.20 branch and for the 1.21 release.
  const states = { 'master-1.20-lts': 'FAILURE', 'master-1.21-lts': 'SUCCESS', '1.20.1-1.0.0': 'SUCCESS', '1.21.1-2.0.0': 'FAILURE' };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { query } = JSON.parse(body);
      queries.push(query);
      const refs = sb.git(sb.path('origin', 'ModG.git'), 'for-each-ref', '--format=%(refname) %(objectname)').trim().split('\n').map(l => l.split(' '));
      const nodes = prefix => refs.filter(([r]) => r.startsWith(prefix)).map(([r, oid]) => {
        const name = r.slice(prefix.length);
        return { name, target: { oid, statusCheckRollup: { state: states[name] } } };
      });
      const repo = { heads: { nodes: nodes('refs/heads/') }, tags: { nodes: nodes('refs/tags/').map(n => ({ name: n.name, target: { oid: n.target.oid } })) } };
      for (const m of query.matchAll(/(release\d+): ref\(qualifiedName: "refs\/tags\/([^"]+)"\)/g)) {
        repo[m[1]] = { target: { target: { statusCheckRollup: { state: states[m[2]] } } } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
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
    assert.deepStrictEqual(cells.map(c => [c.ci, c.releaseCi]), [['FAILURE', 'SUCCESS'], ['SUCCESS', 'FAILURE']]);
    // It asked for the last releases it knew of.
    assert.match(queries[0], /release0: ref\(qualifiedName: "refs\/tags\/1\.20\.1-1\.0\.0"\)/);
    assert.strictEqual(monitor.info.github, 'ok');

    // Nothing changed on origin: nothing to fetch.
    await monitor.request('remote');
    assert.strictEqual(monitor.info.fetched.count, 0);

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
