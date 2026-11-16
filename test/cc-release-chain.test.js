'use strict';
// End-to-end tests of cc-release-chain, with stand-ins for the build, the editor and Claude.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSandbox } = require('./helpers');

const HEADER = "As always, don't forget to backup your world before updating!\n\n";
const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\n`;

const TOOLS = {
  // Logs where it ran and with which GRADLE_OPTS; fails in the dir named by CC_TEST_BUILD_FAIL.
  build: '#!/bin/sh\necho "build $(basename "$(dirname "$PWD")") GRADLE_OPTS=[$GRADLE_OPTS]" >> "$CC_TEST_LOG"\n'
    + 'if [ "$(basename "$(dirname "$PWD")")" = "$CC_TEST_BUILD_FAIL" ]; then echo "compile error"; exit 1; fi\n',
  // Logs the prompt (last argument); edits a file when CC_TEST_REVIEW_EDIT is set.
  review: '#!/bin/sh\nfor last; do :; done\necho "review $(basename "$(dirname "$PWD")"): $last" >> "$CC_TEST_LOG"\n'
    + 'if [ -n "$CC_TEST_REVIEW_EDIT" ]; then echo fixed >> src/main/java/A.java; fi\necho "Verdict: fine"\n',
  // Resolves conflicts by taking the incoming side, then commits the merge.
  upmerge: '#!/bin/sh\necho "upmerge-claude $(basename "$(dirname "$PWD")")" >> "$CC_TEST_LOG"\n'
    + 'git diff --name-only --diff-filter=U | xargs git checkout --theirs --\ngit add -A\ngit commit -q --no-edit\n',
  fix: '#!/bin/sh\necho "fix-claude" >> "$CC_TEST_LOG"\n',
  // Appends CC_TEST_EDITOR_APPEND to the file, like a person editing the draft.
  editor: '#!/bin/sh\necho "edit $1" >> "$CC_TEST_LOG"\n'
    + 'if [ -n "$CC_TEST_EDITOR_APPEND" ]; then printf "%s\\n" "$CC_TEST_EDITOR_APPEND" >> "$1"; fi\n',
};

let sb;
afterEach(() => sb && sb.cleanup());

// ModA on 1.20 and 1.21 (both released), with an unreleased fix on 1.20.
// `conflict`: 1.21 changed the same line. `withNew`: a 26 version without releases yet.
function setup({ conflict = false, withNew = false, releases = true } = {}) {
  sb = createSandbox('cc-release-chain-test-');
  const w = sb.newMod('ModA');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  sb.commit(w, 'Initial', {
    'gradle.properties': props('1.20.1', '1.0.0'),
    'secrets.properties_template': '',
    '.gitattributes': 'gradle.properties merge=ours\nCHANGELOG.md merge=ours\n',
    'src/main/java/A.java': 'a\n',
    'resources/changelog/1.20.1-1.0.0.txt': `${HEADER}Initial 1.20.1 release\n`,
  });
  if (releases) sb.git(w, 'tag', '1.20.1-1.0.0');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(w, 'Port to 1.21', {
    'gradle.properties': props('1.21.1', '2.0.0'),
    'resources/changelog/1.21.1-2.0.0.txt': `${HEADER}Initial 1.21.1 release\n`,
  });
  if (releases) sb.git(w, 'tag', '1.21.1-2.0.0');
  if (conflict) sb.commit(w, 'Change A on 1.21', { 'src/main/java/A.java': 'a-1.21\n' });
  const branches = ['master-1.20-lts', 'master-1.21-lts'];
  if (withNew) {
    sb.git(w, 'checkout', '-q', '-b', 'master-26');
    sb.commit(w, 'Port to 26', { 'gradle.properties': props('26.3', '3.0.0') });
    branches.push('master-26');
  }
  sb.git(w, 'checkout', '-q', 'master-1.20-lts');
  sb.commit(w, 'Fix crash', { 'src/main/java/A.java': 'a-fixed\n' });
  sb.git(w, 'push', '-q', '--tags', 'origin', ...branches);

  const versions = [
    { dir: sb.path('mc20-lts'), branch: 'master-1.20-lts', gradleOpts: { 'org.gradle.java.home': '/jdk17' } },
    { dir: sb.path('mc21-lts'), branch: 'master-1.21-lts' },
  ];
  sb.checkout('mc20-lts', 'ModA', 'master-1.20-lts');
  sb.checkout('mc21-lts', 'ModA', 'master-1.21-lts');
  sb.write(sb.path('mc21-lts', '.upmerge-src-branch'), 'master-1.20-lts\n');
  if (withNew) {
    versions.push({ dir: sb.path('mc26'), branch: 'master-26' });
    sb.checkout('mc26', 'ModA', 'master-26');
    sb.write(sb.path('mc26', '.upmerge-src-branch'), 'master-1.21-lts\n');
  }

  const tool = name => {
    const file = sb.path('tools', name);
    sb.write(file, TOOLS[name]);
    fs.chmodSync(file, 0o755);
    return file;
  };
  sb.write(sb.path('cc-helpers.json'), JSON.stringify({
    versions,
    build: [tool('build')],
    editor: tool('editor'),
    notify: false,
    maxParallelBuilds: 1,
    claude: { review: [tool('review')], upmerge: [tool('upmerge')], fix: [tool('fix')] },
  }));
}

function chain(args, input, env = {}) {
  return sb.run('cc-release-chain', args, {
    input,
    env: {
      CC_HELPERS_CONFIG: sb.path('cc-helpers.json'),
      CC_HELPERS_STATE_DIR: sb.path('state'),
      CC_TEST_LOG: sb.path('log.txt'),
      GRADLE_OPTS: '',
      ...env,
    },
  });
}

const log = () => (fs.existsSync(sb.path('log.txt')) ? sb.read(sb.path('log.txt')) : '');
const originTags = () => sb.git(sb.path('origin', 'ModA.git'), 'tag', '-l').split('\n').filter(Boolean).sort();
const originHead = branch => sb.git(sb.path('origin', 'ModA.git'), 'rev-parse', branch).trim();
const localHead = dir => sb.git(sb.path(dir, 'ModA'), 'rev-parse', 'HEAD').trim();
const changelog = (dir, name) => sb.read(sb.path(dir, 'ModA', 'resources', 'changelog', `${name}.txt`));

test('releases a fix on 1.20 and 1.21, and pushes the upmerge to a version without releases', () => {
  setup({ withNew: true });
  // Start, bump 1.20 (default), bump 1.21 (default), push the 26 upmerge.
  const r = chain(['moda'], 'y\n\n\n\n');
  assert.strictEqual(r.code, 0, r.out + r.err);

  assert.deepStrictEqual(originTags(), ['1.20.1-1.0.0', '1.20.1-1.0.1', '1.21.1-2.0.0', '1.21.1-2.0.1']);
  assert.strictEqual(originHead('master-1.20-lts'), localHead('mc20-lts'));
  assert.strictEqual(originHead('master-1.21-lts'), localHead('mc21-lts'));
  assert.strictEqual(originHead('master-26'), localHead('mc26'));
  assert.strictEqual(changelog('mc20-lts', '1.20.1-1.0.1'), `${HEADER}Fixes:\n* Fix crash\n`);
  // Carried over from the 1.20 release that the chain just made.
  assert.strictEqual(changelog('mc21-lts', '1.21.1-2.0.1'), `${HEADER}Fixes:\n* Fix crash\n`);

  const lines = log().split('\n');
  assert.ok(lines.includes('build mc20-lts GRADLE_OPTS=["-Dorg.gradle.java.home=/jdk17"]'), log());
  assert.ok(lines.includes('build mc21-lts GRADLE_OPTS=[]'), log());
  assert.match(log(), /^review mc21-lts: Was the upmerge in last commit correct\? If not, fix it, but don't git commit it yet\./m);
  assert.match(log(), /^review mc26: /m);
  assert.ok(!log().includes('review mc20-lts'), 'no review without an upmerge');

  assert.match(r.out, /Suggested: patch \(no Additions\)\./);
  assert.match(r.out, /1\.20-lts {2}released 1\.20\.1-1\.0\.1 \(patch\), build ok\n/);
  assert.match(r.out, /1\.21-lts {2}released 1\.21\.1-2\.0\.1 \(patch\), build ok, review: no changes\n/);
  assert.match(r.out, /26 {8}upmerge pushed \(there is no 26\.3 release yet\), build ok, review: no changes\n/);
  assert.ok(!fs.existsSync(sb.path('state', 'locks', 'ModA')), 'lock released');
  assert.ok(!fs.existsSync(sb.path('mc21-lts', 'ModA', '.git', 'cc-release-chain', 'state.json')), 'state cleared');
});

test('hands conflicts to Claude, and a failing build can be skipped', () => {
  setup({ conflict: true });
  // Start, bump 1.20, skip the failing 1.21 build, bump 1.21.
  const r = chain(['ModA'], 'y\n\ns\n\n', { CC_TEST_BUILD_FAIL: 'mc21-lts' });
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(log(), /^upmerge-claude mc21-lts$/m);
  assert.ok(!log().includes('review mc21-lts'), 'no review after a conflicted upmerge');
  assert.match(r.out, /compile error\n[\s\S]*Build failed after/);
  assert.match(r.out, /1\.21-lts {2}released 1\.21\.1-2\.0\.1 \(patch\), build skipped\n/);
  assert.strictEqual(sb.read(sb.path('mc21-lts', 'ModA', 'src', 'main', 'java', 'A.java')), 'a-fixed\n');
  assert.ok(originTags().includes('1.21.1-2.0.1'));
});

test('commits the fixes of the Claude review, then builds again', () => {
  setup();
  // Start, bump 1.20, commit the review fix with the default message, bump 1.21.
  const r = chain(['ModA'], 'y\n\ny\n\n\n', { CC_TEST_REVIEW_EDIT: '1' });
  assert.strictEqual(r.code, 0, r.out + r.err);
  const repo = sb.path('mc21-lts', 'ModA');
  assert.match(sb.git(repo, 'log', '--format=%s', '-3'), /^Bump mod version\nFix upmerge from master-1\.20-lts\nMerge /);
  assert.strictEqual(log().split('\n').filter(l => l.startsWith('build mc21-lts')).length, 2);
  assert.match(r.out, /review: fixed/);
});

test('can be stopped and continued, keeping the edited changelog draft', () => {
  setup();
  // Stop at the 1.20 bump prompt (input ends there).
  let r = chain(['ModA'], 'y\n', { CC_TEST_EDITOR_APPEND: '* Fix another thing' });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Run cc-release-chain ModA again to continue where it stopped\./);
  assert.ok(!fs.existsSync(sb.path('state', 'locks', 'ModA')), 'lock released');
  assert.deepStrictEqual(originTags(), ['1.20.1-1.0.0', '1.21.1-2.0.0']);

  // Continue: start, use the saved draft, bump 1.20, bump 1.21.
  r = chain(['ModA'], 'y\nu\n\n\n');
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /continuing an earlier run/);
  assert.strictEqual(changelog('mc20-lts', '1.20.1-1.0.1'), `${HEADER}Fixes:\n* Fix crash\n* Fix another thing\n`);
  assert.ok(originTags().includes('1.21.1-2.0.1'));
  // The 1.20 build already passed in the first run.
  assert.strictEqual(log().split('\n').filter(l => l.startsWith('build mc20-lts')).length, 1);
});

test('starts at the given version', () => {
  setup();
  // Start at 1.21: upmerges the unreleased 1.20 fix, releases only 1.21.
  const r = chain(['ModA', '1.21-lts'], 'y\n\n');
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.deepStrictEqual(originTags(), ['1.20.1-1.0.0', '1.21.1-2.0.0', '1.21.1-2.0.1']);
  assert.ok(!log().includes('mc20-lts'));
  assert.strictEqual(changelog('mc21-lts', '1.21.1-2.0.1'), `${HEADER}Fixes:\n* Fix crash\n`);
});

test('only upmerges a mod without releases, like a compat mod', () => {
  setup({ releases: false });
  // Start, push the 1.21 upmerge.
  const r = chain(['ModA'], 'y\n\n');
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /1\.21-lts {2}only upmerged \(no releases\), 1 to upmerge\n/);
  assert.deepStrictEqual(originTags(), []);
  assert.strictEqual(originHead('master-1.21-lts'), localHead('mc21-lts'));
  assert.match(sb.git(sb.path('mc21-lts', 'ModA'), 'log', '--format=%s', '-3'), /^Merge .*\nFix crash\n/);
  assert.ok(!log().includes('edit '), 'no changelog to edit');
  assert.ok(!r.out.includes('== ModA 1.20-lts'), 'nothing to do on the lowest version');
  assert.match(r.out, /1\.21-lts {2}upmerge pushed \(this mod is only upmerged, it has no releases\), build ok, review: no changes\n/);
});

test('refuses to start when a release tag differs from origin', () => {
  setup();
  // The 1.20 release tag is recreated on origin, at the fix.
  const w = sb.path('work', 'ModA');
  sb.git(w, 'tag', '-f', '1.20.1-1.0.0', 'master-1.20-lts');
  sb.git(w, 'push', '-q', '-f', 'origin', 'refs/tags/1.20.1-1.0.0');
  const r = chain(['ModA'], 'y\n');
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /tag 1\.20\.1-1\.0\.0 differs from origin \(to use the ones from origin: git fetch --tags --force origin\)/);
  assert.match(r.err, /Fix the problems above first \(1\.20-lts, 1\.21-lts\)/);
});

test('refuses to run twice for the same mod', () => {
  setup();
  fs.mkdirSync(sb.path('state', 'locks', 'ModA'), { recursive: true });
  fs.writeFileSync(sb.path('state', 'locks', 'ModA', 'pid'), String(process.pid));
  const r = chain(['ModA'], 'y\n');
  assert.strictEqual(r.code, 1);
  assert.match(r.err, new RegExp(`A release chain for ModA is already running \\(pid ${process.pid}\\)`));
  assert.deepStrictEqual(originTags(), ['1.20.1-1.0.0', '1.21.1-2.0.0']);
});

test('takes over the lock of a chain that died', () => {
  setup();
  fs.mkdirSync(sb.path('state', 'locks', 'ModA'), { recursive: true });
  fs.writeFileSync(sb.path('state', 'locks', 'ModA', 'pid'), '999999999');
  const r = chain(['ModA'], 'n\n');
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /Release chain for ModA:/);
});

test('stops before starting when a checkout needs attention', () => {
  setup();
  sb.write(sb.path('mc21-lts', 'ModA', 'src', 'main', 'java', 'A.java'), 'local edit\n');
  const r = chain(['ModA'], 'y\n');
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /uncommitted changes/);
  assert.match(r.err, /Fix the problems above first \(1\.21-lts\)/);
});

test('cc-build uses the gradleOpts of the version, and --env prints them', () => {
  setup();
  const cwd = sb.path('mc20-lts', 'ModA');
  const env = { CC_HELPERS_CONFIG: sb.path('cc-helpers.json'), CC_TEST_LOG: sb.path('log.txt'), GRADLE_OPTS: '-Xfoo' };
  let r = sb.run('cc-build', ['--env'], { cwd, env });
  assert.strictEqual(r.out, `export GRADLE_OPTS='-Xfoo "-Dorg.gradle.java.home=/jdk17"'\n`);
  r = sb.run('cc-build', [], { cwd, env });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(log(), 'build mc20-lts GRADLE_OPTS=[-Xfoo "-Dorg.gradle.java.home=/jdk17"]\n');
  r = sb.run('cc-build', [], { cwd: sb.dir, env });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /is not a mod checkout/);
});
