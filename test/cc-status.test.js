'use strict';
// End-to-end tests of cc-status against throwaway repos with a local "origin".

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'cc-status');
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

function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...env, NO_COLOR: '1', CC_HELPERS_CONFIG: path.join(tmp, 'cc-helpers.json'), ...extraEnv },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Cells of a mod's row in the table.
function row(out, mod) {
  const line = out.split('\n').find(l => l.startsWith(`${mod} `));
  assert.ok(line, `no row for ${mod} in:\n${out}`);
  return line.trim().split(/\s+/).slice(1);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-status-test-'));
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n'
    + '[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n');
  env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };

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

test('lists mods and versions for completion', () => {
  assert.strictEqual(run(['--list-mods']).out, 'ModA\nModB\nModC\nModD\nModE-Compat\n');
  assert.strictEqual(run(['--list-versions']).out, '1.20-lts\n1.21-lts\n');
});

test('shows the status table', () => {
  const r = run(['--no-fetch']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.err, '');
  assert.deepStrictEqual(row(r.out, 'ModA'), ['3', '↑3']);
  assert.deepStrictEqual(row(r.out, 'ModB'), ['-', '1t']);
  assert.deepStrictEqual(row(r.out, 'ModC'), ['.', '.!']);
  // Never released anywhere: only upmerged, so no "new".
  assert.deepStrictEqual(row(r.out, 'ModD'), ['-', '.']);
  assert.deepStrictEqual(row(r.out, 'ModE-Compat'), ['.', '↑1']);
  assert.ok(!r.out.includes('OtherRepo'));
});

test('groups what needs doing by lowest MC version', () => {
  const { out } = run(['--no-fetch']);
  assert.match(out, /To do, by lowest MC version:\n1\.20-lts: ModA\n/);
  assert.match(out, /Only translations:\n1\.21-lts: ModB\n/);
  assert.match(out, /Upmerge only:\n1\.21-lts: ModE-Compat\n/);
  assert.ok(!out.includes('ModD\n'), 'nothing to do for ModD');
  assert.ok(!/: .*ModC/.test(out.split('To do')[1]));
});

test('verbose output explains each cell', () => {
  const { out } = run(['--no-fetch', '-v', 'moda', 'ModC']);
  assert.ok(!out.includes('ModB'));
  assert.match(out, /unreleased:\n.* Bump compat version\n.* New translations\n.* Fix crash\n/);
  assert.match(out, /Add AGENTS\.md \(only dev files\)/);
  assert.match(out, /Bump compat version \(compat bump without changelog entries\)/);
  assert.match(out, /to upmerge:\n.* Bump compat version\n/);
  assert.match(out, /local: uncommitted changes/);
});

test('rejects unknown mods', () => {
  const r = run(['--no-fetch', 'Nope']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Unknown mod Nope/);
});

test('warns about a wrong .upmerge-src-branch', () => {
  const file = path.join(tmp, 'mc21-lts', '.upmerge-src-branch');
  fs.writeFileSync(file, 'master-1.19-lts\n');
  try {
    assert.match(run(['--no-fetch', 'ModD']).err, /says master-1\.19-lts, but the version before it in the config is master-1\.20-lts/);
  } finally {
    fs.writeFileSync(file, 'master-1.20-lts\n');
  }
});

test('reports a missing config', () => {
  const r = run(['--no-fetch'], { CC_HELPERS_CONFIG: path.join(tmp, 'nope.json') });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Can't read .*nope\.json/);
});

test('fetches new commits unless --no-fetch is given', () => {
  const w = path.join(tmp, 'work', 'ModC');
  git(w, 'checkout', '-q', 'master-1.20-lts');
  commit(w, 'Fix another crash', { 'src/main/java/C.java': 'c2' });
  git(w, 'push', '-q', 'origin', 'master-1.20-lts');

  assert.deepStrictEqual(row(run(['--no-fetch', 'ModC']).out, 'ModC'), ['.', '.!']);
  const r = run(['ModC']);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(row(r.out, 'ModC'), ['1', '↑1!']);
});

test('marks mods without releases as upmerge only in verbose output', () => {
  const { out } = run(['--no-fetch', '-v', 'ModE-Compat']);
  assert.match(out, /1\.21-lts \(upmerge only\)\n {4}to upmerge:\n.* Fix compat\n/);
});

test('reports tags that differ from origin instead of failing', () => {
  // The 1.20 release tag of ModC is recreated on origin, at a later commit.
  const w = path.join(tmp, 'work', 'ModC');
  git(w, 'checkout', '-q', 'master-1.20-lts');
  git(w, 'tag', '-f', '1.20.1-1.0.0');
  git(w, 'push', '-q', '-f', 'origin', 'refs/tags/1.20.1-1.0.0');

  const r = run(['-v', 'ModC']);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.ok(!r.out.includes('Errors:'), r.out);
  assert.deepStrictEqual(row(r.out, 'ModC'), ['1!', '↑1!']);
  assert.match(r.out, /local: tag 1\.20\.1-1\.0\.0 differs from origin \(to use the ones from origin: git fetch --tags --force origin\)/);
});
