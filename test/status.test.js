'use strict';
// Tests of the release status of mods (lib/status.js, used by cc-dashboard and cc-release-chain)
// against throwaway repos with a local "origin".

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');
const { loadConfig } = require('../bin/lib/config');
const {
  discoverMods, checkVersionDirs, computeStatus, planFetches, isUpmergeOnly, modWork, cellText,
} = require('../bin/lib/status');

const MARK = path.join(__dirname, '..', 'bin', 'cc-mark');
let tmp;
let env;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(work, message, files) {
  for (const [f, content] of Object.entries(files)) write(path.join(work, f), content);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
}

const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\n`;

// Creates origin/<mod>.git and a scratch clone to build history in.
function newMod(mod) {
  const origin = path.join(tmp, 'origin', `${mod}.git`);
  const work = path.join(tmp, 'work', mod);
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'init', '-q', work);
  git(work, 'remote', 'add', 'origin', origin);
  return work;
}

function checkout(versionDir, mod, branch) {
  git(tmp, 'clone', '-q', '-b', branch, path.join(tmp, 'origin', `${mod}.git`), path.join(tmp, versionDir, mod));
}

// The status as cc-dashboard computes it. Marks are read along with the config, like it does.
async function status({ fetch = false, mods } = {}) {
  const config = loadConfig();
  const found = discoverMods(config);
  const cells = await computeStatus(config, { ...found, mods: mods || found.mods }, { fetch });
  const texts = Object.fromEntries(Object.entries(cells).map(([m, cs]) => [m, cs.map(c => cellText(c, isUpmergeOnly(cs)))]));
  return { config, found, cells, texts };
}

const subjects = commits => commits.map(c => c.subject);

function mark(args, cwd = tmp) {
  const r = spawnSync(process.execPath, [MARK, ...args], { cwd, env: process.env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-helpers-status-test-'));
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n'
    + '[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n'
    // Remotes on "GitHub" are served from the local origins.
    + `[url "${path.join(tmp, 'origin')}/"]\n\tinsteadOf = https://github.com/Test/\n`);
  env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  // The status code runs in this process, so it gets the sandbox environment too.
  Object.assign(process.env, env, {
    CC_HELPERS_CONFIG: path.join(tmp, 'cc-helpers.json'),
    CC_HELPERS_MARKS: path.join(tmp, 'marks.json'),
    CC_HELPERS_STATE_DIR: path.join(tmp, 'state'),
  });
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;

  // ModA: maintained on both versions, several kinds of unreleased commits on 1.20.
  let w = newMod('ModA');
  git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/A.java': 'a' });
  git(w, 'tag', '1.20.1-1.0.0');
  git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '2.0.0') });
  git(w, 'tag', '1.21.1-2.0.0');
  git(w, 'checkout', '-q', 'master-1.20-lts');
  commit(w, 'Fix crash', { 'src/main/java/A.java': 'a2', 'src/test/java/ATest.java': 't' });
  commit(w, 'Add AGENTS.md', { 'AGENTS.md': 'x' });
  commit(w, 'New translations', { 'src/main/resources/assets/moda/lang/de_de.json': '{}' });
  commit(w, 'Bump compat version\n\nFixes:\n* Fix compat crash', { 'gradle.properties': `${props('1.20.1', '1.0.0')}compat=2\n` });
  commit(w, 'Bump compat version', { 'gradle.properties': `${props('1.20.1', '1.0.0')}compat=3\n` });
  git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');

  // ModB: only on 1.21, only translations unreleased.
  w = newMod('ModB');
  git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  commit(w, 'Initial', { 'gradle.properties': props('1.21.1', '1.0.0'), 'src/main/java/B.java': 'b' });
  git(w, 'tag', '1.21.1-1.0.0');
  commit(w, 'New Translations (#3)', { 'src/main/resources/assets/modb/lang/fr_fr.json': '{}' });
  git(w, 'push', '-q', '--tags', 'origin', 'master-1.21-lts');

  // ModC: everything released and upmerged.
  w = newMod('ModC');
  git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/C.java': 'c' });
  git(w, 'tag', '1.20.1-1.0.0');
  git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '2.0.0') });
  git(w, 'tag', '1.21.1-2.0.0');
  git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');

  // ModD: never released on 1.21.
  w = newMod('ModD');
  git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  commit(w, 'Initial', { 'gradle.properties': props('1.21.1', '0.1.0'), 'src/main/java/D.java': 'd' });
  git(w, 'push', '-q', 'origin', 'master-1.21-lts');

  // ModE-Compat: never released anywhere, like the compat mods, with a fix on 1.20 to upmerge.
  w = newMod('ModE-Compat');
  git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/E.java': 'e' });
  git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '1.0.0') });
  git(w, 'checkout', '-q', 'master-1.20-lts');
  commit(w, 'Fix compat', { 'src/main/java/E.java': 'e2' });
  git(w, 'push', '-q', 'origin', 'master-1.20-lts', 'master-1.21-lts');

  checkout('mc20-lts', 'ModA', 'master-1.20-lts');
  checkout('mc20-lts', 'ModE-Compat', 'master-1.20-lts');
  checkout('mc21-lts', 'ModE-Compat', 'master-1.21-lts');
  checkout('mc20-lts', 'ModC', 'master-1.20-lts');
  for (const m of ['ModA', 'ModB', 'ModC', 'ModD']) checkout('mc21-lts', m, 'master-1.21-lts');
  write(path.join(tmp, 'mc21-lts', '.upmerge-src-branch'), 'master-1.20-lts\n');
  // A temporary copy of ModA, not named after its origin.
  git(tmp, 'clone', '-q', '-b', 'master-1.20-lts', path.join(tmp, 'origin', 'ModA.git'), path.join(tmp, 'mc20-lts', 'ModA-tmp'));
  // Not mods: a plain dir and a repo without mod_version.
  fs.mkdirSync(path.join(tmp, 'mc20-lts', 'notes'));
  git(tmp, 'init', '-q', path.join(tmp, 'mc20-lts', 'OtherRepo'));
  // Local edit in a checkout.
  write(path.join(tmp, 'mc21-lts', 'ModC', 'src', 'main', 'java', 'C.java'), 'edited');

  write(path.join(tmp, 'cc-helpers.json'), JSON.stringify({
    versions: [
      { dir: path.join(tmp, 'mc20-lts'), branch: 'master-1.20-lts' },
      { dir: path.join(tmp, 'mc21-lts'), branch: 'master-1.21-lts' },
    ],
  }));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('finds the mod checkouts, and skips copies and other repos', () => {
  const found = discoverMods(loadConfig());
  assert.deepStrictEqual(found.mods, ['ModA', 'ModB', 'ModC', 'ModD', 'ModE-Compat']);
  assert.deepStrictEqual(found.skipped, [{ version: '1.20-lts', name: 'ModA-tmp', origin: 'ModA' }]);
});

test('computes the status of every cell', async () => {
  const { texts } = await status();
  assert.deepStrictEqual(texts, {
    ModA: ['3', '↑3'],
    ModB: ['-', '1t'],
    ModC: ['.', '.!'],
    // Never released anywhere: only upmerged, so no "new".
    ModD: ['-', '.'],
    'ModE-Compat': ['.', '↑1'],
  });
});

test('groups what needs doing by lowest MC version', async () => {
  const { cells } = await status();
  assert.deepStrictEqual(modWork(cells.ModA), { start: 0, group: 'todo' });
  assert.deepStrictEqual(modWork(cells.ModB), { start: 1, group: 'translations' });
  assert.deepStrictEqual(modWork(cells['ModE-Compat']), { start: 1, group: 'upmerge' });
  assert.deepStrictEqual(modWork(cells.ModC), { start: -1, group: null });
  assert.deepStrictEqual(modWork(cells.ModD), { start: -1, group: null });
});

test('explains each cell: the commits, the ones the filter dropped, and local problems', async () => {
  const { cells } = await status();
  const [a20, a21] = cells.ModA;
  assert.strictEqual(a20.lastRelease, '1.20.1-1.0.0');
  assert.deepStrictEqual(subjects(a20.unreleased.userFacing), ['Bump compat version', 'New translations', 'Fix crash']);
  assert.deepStrictEqual(a20.unreleased.dropped.map(c => [c.subject, c.reason]), [
    ['Bump compat version', 'compat bump without changelog entries'],
    ['Add AGENTS.md', 'only dev files'],
  ]);
  assert.deepStrictEqual(subjects(a21.pending.userFacing), ['Bump compat version', 'New translations', 'Fix crash']);
  assert.deepStrictEqual(cells.ModC[1].local, ['uncommitted changes']);
  assert.ok(isUpmergeOnly(cells['ModE-Compat']));
  assert.ok(!isUpmergeOnly(cells.ModA));
});

test('warns about a wrong .upmerge-src-branch', () => {
  const file = path.join(tmp, 'mc21-lts', '.upmerge-src-branch');
  fs.writeFileSync(file, 'master-1.19-lts\n');
  try {
    assert.deepStrictEqual(checkVersionDirs(loadConfig()),
      [`${file} says master-1.19-lts, but the version before it in the config is master-1.20-lts`]);
  } finally {
    fs.writeFileSync(file, 'master-1.20-lts\n');
  }
});

test('reports a missing config, and points to cc-mark when it still has ignoreCommits', () => {
  const file = process.env.CC_HELPERS_CONFIG;
  try {
    process.env.CC_HELPERS_CONFIG = path.join(tmp, 'nope.json');
    assert.throws(() => loadConfig(), /Can't read .*nope\.json/);
    process.env.CC_HELPERS_CONFIG = path.join(tmp, 'ignore.json');
    write(process.env.CC_HELPERS_CONFIG, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ignoreCommits: ['abcdef1'] }));
    assert.throws(() => loadConfig(), /"ignoreCommits" is replaced by cc-mark\. Run: cc-mark no-release abcdef1/);
  } finally {
    process.env.CC_HELPERS_CONFIG = file;
  }
});

test('fetches new commits only when asked', async () => {
  const w = path.join(tmp, 'work', 'ModC');
  git(w, 'checkout', '-q', 'master-1.20-lts');
  commit(w, 'Fix another crash', { 'src/main/java/C.java': 'c2' });
  git(w, 'push', '-q', 'origin', 'master-1.20-lts');

  assert.deepStrictEqual((await status({ mods: ['ModC'] })).texts.ModC, ['.', '.!']);
  assert.deepStrictEqual((await status({ mods: ['ModC'], fetch: true })).texts.ModC, ['1', '↑1!']);
});

test('reports tags that differ from origin instead of failing', async () => {
  // The 1.20 release tag of ModC is recreated on origin, at a later commit.
  const w = path.join(tmp, 'work', 'ModC');
  git(w, 'checkout', '-q', 'master-1.20-lts');
  git(w, 'tag', '-f', '1.20.1-1.0.0');
  git(w, 'push', '-q', '-f', 'origin', 'refs/tags/1.20.1-1.0.0');

  const { cells, texts } = await status({ mods: ['ModC'], fetch: true });
  assert.ok(!cells.ModC.some(c => c.error), JSON.stringify(cells.ModC));
  assert.deepStrictEqual(texts.ModC, ['1!', '↑1!']);
  assert.deepStrictEqual(cells.ModC[0].local, ['tag 1.20.1-1.0.0 differs from origin (to use the ones from origin: git fetch --tags --force origin)']);
  // In the 1.21 checkout, that tag isn't the last release, so it is only noted.
  assert.deepStrictEqual(cells.ModC[1].otherDifferingTags, ['1.20.1-1.0.0']);
  assert.ok(!cells.ModC[1].local.some(l => /tag/.test(l)));
});

test('cc-mark marks commits per MC version, or for all of them', async () => {
  const modA = path.join(tmp, 'mc20-lts', 'ModA');
  const fix = git(modA, 'log', '-1', '--format=%H', '--grep=Fix crash').trim();
  const agents = git(modA, 'log', '-1', '--format=%H', '--grep=Add AGENTS').trim();
  const cellsOfA = async () => (await status({ mods: ['ModA'] })).texts.ModA;

  // In a checkout, a mark is for its version: 1.21 still has the fix to upmerge.
  let r = mark(['no-release', fix.slice(0, 7)], modA);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `Marked ${fix.slice(0, 9)} ModA: Fix crash as needing no release on 1.20-lts\n`);
  assert.deepStrictEqual(await cellsOfA(), ['2', '↑3']);
  const dropped = (await status({ mods: ['ModA'] })).cells.ModA[0].unreleased.dropped.find(c => c.hash === fix);
  assert.deepStrictEqual([dropped.reason, dropped.marked], ['marked as no release on this version', 'master-1.20-lts']);

  // Elsewhere, you say which versions.
  r = mark(['no-release', fix]);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Say which MC versions this mark is for: --version <version> .*, or --all-versions\. Versions: 1\.20-lts, 1\.21-lts/);
  assert.match(mark(['no-release', fix, '--version', '1.19']).err, /Unknown version 1\.19/);
  assert.strictEqual(mark(['no-release', fix, '--version', '1.21-lts']).code, 0);
  assert.deepStrictEqual(await cellsOfA(), ['2', '↑2']);
  r = mark(['release', agents.slice(0, 10), '--all-versions', '--reason', 'docs ship in the jar']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /as needing a release on all versions\n$/);
  assert.deepStrictEqual(await cellsOfA(), ['3', '↑3']);
  assert.deepStrictEqual(mark(['list']).out.split('\n').filter(Boolean).map(l => l.split(/ {2,}/).slice(0, 3)), [
    ['no release', '1.20-lts', fix.slice(0, 9)],
    ['no release', '1.21-lts', fix.slice(0, 9)],
    ['release', 'all versions', agents.slice(0, 9)],
  ]);

  // Clearing one version, then everything.
  assert.strictEqual(mark(['clear', fix, '--version', '1.20-lts']).code, 0);
  assert.deepStrictEqual(await cellsOfA(), ['4', '↑3']);
  assert.strictEqual(mark(['clear', fix, agents]).code, 0);
  assert.deepStrictEqual(await cellsOfA(), ['3', '↑3']);
  assert.strictEqual(mark(['list']).out, 'No marks yet.\n');

  r = mark(['no-release', 'deadbeef', '--all-versions']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Commit deadbeef not found/);
  assert.strictEqual(mark(['--list-versions']).out, '1.20-lts\n1.21-lts\n');
});

test('reads marks of the first format as marks for all versions', async () => {
  const fix = git(path.join(tmp, 'mc20-lts', 'ModA'), 'log', '-1', '--format=%H', '--grep=Fix crash').trim();
  write(path.join(tmp, 'marks.json'), JSON.stringify({ commits: { [fix]: { release: false, subject: 'Fix crash', mod: 'ModA', date: '2026-11-16' } } }));
  try {
    assert.deepStrictEqual((await status({ mods: ['ModA'] })).texts.ModA, ['2', '↑2']);
  } finally {
    fs.rmSync(path.join(tmp, 'marks.json'));
  }
});

test('asks GitHub which checkouts changed, and only fetches those', async () => {
  // ModG lives on "GitHub", in its own version dirs.
  const w = newMod('ModG');
  git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/G.java': 'g' });
  git(w, 'tag', '1.20.1-1.0.0');
  git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '2.0.0') });
  git(w, 'tag', '1.21.1-2.0.0');
  git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');
  for (const [dir, branch] of [['gh20', 'master-1.20-lts'], ['gh21', 'master-1.21-lts']]) {
    git(tmp, 'clone', '-q', '-b', branch, 'https://github.com/Test/ModG.git', path.join(tmp, dir, 'ModG'));
  }
  write(path.join(tmp, 'gh21', '.upmerge-src-branch'), 'master-1.20-lts\n');
  const configFile = path.join(tmp, 'gh.json');
  write(configFile, JSON.stringify({ versions: [
    { dir: path.join(tmp, 'gh20'), branch: 'master-1.20-lts' },
    { dir: path.join(tmp, 'gh21'), branch: 'master-1.21-lts' },
  ] }));
  const pushFix = n => {
    git(w, 'checkout', '-q', 'master-1.20-lts');
    commit(w, `Fix G${n}`, { 'src/main/java/G.java': `g${n}` });
    git(w, 'push', '-q', 'origin', 'master-1.20-lts');
  };
  // What the fake GitHub reports: the refs of the origin at the time of the snapshot.
  const snapshot = () => {
    const refs = git(path.join(tmp, 'origin', 'ModG.git'), 'for-each-ref', '--format=%(refname) %(objectname)')
      .trim().split('\n').map(l => l.split(' '));
    const nodes = prefix => refs.filter(([r]) => r.startsWith(prefix)).map(([r, oid]) => ({ name: r.slice(prefix.length), target: { oid } }));
    return { heads: { nodes: nodes('refs/heads/') }, tags: { nodes: nodes('refs/tags/') } };
  };

  const requests = [];
  let answer;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const { query } = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, query });
      const { status: code, json } = answer(query);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = { config: process.env.CC_HELPERS_CONFIG };
  Object.assign(process.env, { CC_HELPERS_CONFIG: configFile, GH_TOKEN: 'secret', CC_HELPERS_GITHUB_API: `http://127.0.0.1:${server.address().port}/graphql` });
  const reply = refs => () => ({ status: 200, json: { data: { r0: refs } } });
  // As the dashboard does: ask GitHub, then fetch only what it says changed.
  const check = async () => {
    const config = loadConfig();
    const found = discoverMods(config);
    const plan = await planFetches(config, found);
    if (plan.error) return { plan };
    const cells = await computeStatus(config, found, { fetch: dir => plan.toFetch.has(dir) });
    return { plan, texts: cells.ModG.map(c => cellText(c, false)) };
  };
  try {
    pushFix(1);
    answer = reply(snapshot());
    let r = await check();
    assert.deepStrictEqual([r.plan.toFetch.size, r.plan.total], [2, 2]);
    assert.deepStrictEqual(r.texts, ['1', '↑1']);
    assert.strictEqual(requests[0].auth, 'bearer secret');
    assert.match(requests[0].query, /r0: repository\(owner: "Test", name: "ModG"\)/);

    // GitHub says nothing changed, so nothing is fetched.
    const stale = snapshot();
    pushFix(2);
    answer = reply(stale);
    r = await check();
    assert.strictEqual(r.plan.toFetch.size, 0);
    assert.deepStrictEqual(r.texts, ['1', '↑1']);

    // When GitHub fails, the caller hears why.
    answer = () => ({ status: 502, json: {} });
    assert.deepStrictEqual((await check()).plan, { error: 'GitHub answered 502' });

    // A new tag on origin is fetched too.
    git(w, 'tag', '1.20.1-1.0.1');
    git(w, 'push', '-q', 'origin', '1.20.1-1.0.1');
    answer = reply(snapshot());
    r = await check();
    assert.strictEqual(r.plan.toFetch.size, 2);
    assert.deepStrictEqual(r.texts, ['2', '↑2']);
    assert.ok(git(path.join(tmp, 'gh20', 'ModG'), 'tag', '-l', '1.20.1-1.0.1').trim());
  } finally {
    server.close();
    process.env.CC_HELPERS_CONFIG = saved.config;
    delete process.env.GH_TOKEN;
    delete process.env.CC_HELPERS_GITHUB_API;
  }
});
