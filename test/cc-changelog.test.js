'use strict';
// End-to-end tests of changelog drafting after an upmerge from 1.20 into 1.21.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createSandbox } = require('./helpers');

let sb;
let mc21;
const HEADER20 = "As always, don't forget to backup your world before updating!\nRequires CyclopsCore version 1.2.3 or higher.\n\n";
const HEADER21 = "As always, don't forget to backup your world before updating!\nRequires CyclopsCore version 1.5.0 or higher.\n\n";
const props = (mc, mod, cc) => `mod_version=${mod}\nminecraft_version=${mc}\ncyclopscore_version=${cc}\n`;

before(() => {
  sb = createSandbox('cc-changelog-test-');
  const w = sb.newMod('ModA');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  sb.commit(w, 'Initial', {
    'gradle.properties': props('1.20.1', '1.0.0', '1.2.3-45'),
    'secrets.properties_template': '',
    '.gitattributes': 'gradle.properties merge=ours\nCHANGELOG.md merge=ours\n',
    'src/main/java/A.java': 'a',
    'resources/changelog/1.20.1-1.0.0.txt': `${HEADER20}Initial 1.20.1 release\n`,
  });
  sb.git(w, 'tag', '1.20.1-1.0.0');

  // 1.21 already shipped "Add feature X" before it was backported to 1.20.
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(w, 'Port to 1.21', {
    'gradle.properties': props('1.21.1', '2.0.0', '1.5.0-60'),
    'resources/changelog/1.21.1-2.0.0.txt': `${HEADER21}Additions:\n* Add feature X\n`,
  });
  sb.git(w, 'tag', '1.21.1-2.0.0');

  // 1.20: a release whose changelog was edited by hand, plus one unreleased fix.
  sb.git(w, 'checkout', '-q', 'master-1.20-lts');
  sb.commit(w, 'Fix crash (#10)\n\nCloses #9', { 'src/main/java/A.java': 'a2' });
  sb.commit(w, 'Add feature X', { 'src/main/java/A.java': 'a3' });
  sb.commit(w, 'Add AGENTS.md', { 'AGENTS.md': 'x' });
  sb.commit(w, 'Bump mod version', {
    'gradle.properties': props('1.20.1', '1.0.1', '1.2.3-45'),
    'resources/changelog/1.20.1-1.0.1.txt': `${HEADER20}Additions:\n* Add feature X\n\nFixes:\n* Fix crash (#10), Closes #9\n  Hand-written detail.\n`,
  });
  sb.git(w, 'tag', '1.20.1-1.0.1');
  sb.commit(w, 'Fix unreleased thing', { 'src/main/java/A.java': 'a4' });

  // 1.21: its own changes.
  sb.git(w, 'checkout', '-q', 'master-1.21-lts');
  sb.commit(w, 'Update CI', { '.github/workflows/ci.yml': 'x' });
  sb.commit(w, 'Fix 1.21 only bug', { 'src/main/java/B.java': 'b' });
  sb.commit(w, 'New Translations (#5)', { 'src/main/resources/assets/moda/lang/de_de.json': '{}' });
  sb.commit(w, 'Bump compat version\n\nAdded:\n* Support compat mod Y (#3)', { 'gradle.properties': `${props('1.21.1', '2.0.0', '1.5.0-60')}compat=2\n` });
  sb.git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');

  sb.checkout('mc20-lts', 'ModA', 'master-1.20-lts');
  mc21 = sb.checkout('mc21-lts', 'ModA', 'master-1.21-lts');
  sb.write(sb.path('mc21-lts', '.upmerge-src-branch'), 'master-1.20-lts\n');
  const r = sb.run('cc-upmerge', [], { cwd: mc21 });
  assert.strictEqual(r.code, 0, r.out + r.err);
});

after(() => sb.cleanup());

test('drafts the changelog after an upmerge, explaining where entries come from', () => {
  const r = sb.run('cc-changelog-draft', [], { cwd: mc21 });
  assert.strictEqual(r.code, 0, r.err);
  const out = r.out.replace(/^#   [0-9a-f]{9} /m, '#   <hash> ');
  assert.strictEqual(out, `${HEADER21}`
    + '# Draft made by cc-changelog-draft: review every entry. Lines starting with # are removed on release.\n'
    + 'Additions:\n'
    + '# only on master-1.21-lts\n'
    + '* Support compat mod Y (#3)\n'
    + '* Add translations through Crowdin (#5)\n'
    + '\n'
    + 'Changes:\n'
    + '\n'
    + 'Fixes:\n'
    + '# from 1.20.1-1.0.1\n'
    + '* Fix crash (#10), Closes #9\n'
    + '  Hand-written detail.\n'
    + '# only on master-1.21-lts\n'
    + '* Fix 1.21 only bug\n'
    + '# from master-1.20-lts, not released there yet\n'
    + '* Fix unreleased thing\n'
    + '\n'
    + '# Left out:\n'
    + '#   * Add feature X (already in 1.21.1-2.0.0)\n'
    + '#   <hash> Update CI (only dev files)\n');
});

test('without a source branch, every commit is drafted from its message', () => {
  const r = sb.run('cc-changelog-draft', ['--source', 'none', '--no-comments'], { cwd: mc21 });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /\* Fix crash \(#10\), Closes #9\n(?!  Hand-written)/);
  assert.ok(!/^#/m.test(r.out), r.out);
  assert.ok(!r.out.includes('Add feature X'));
  assert.ok(!r.out.includes('AGENTS'));
});

test('leaves out commits ignored in the config', () => {
  const fix = sb.git(mc21, 'log', '-1', '--format=%h', '--grep=Fix 1.21 only bug').trim();
  sb.write(sb.path('ignore.json'), JSON.stringify({ versions: [{ dir: sb.path('mc21-lts'), branch: 'master-1.21-lts' }], ignoreCommits: [fix] }));
  const r = sb.run('cc-changelog-draft', [], { cwd: mc21, env: { CC_HELPERS_CONFIG: sb.path('ignore.json') } });
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!/^\* Fix 1\.21 only bug/m.test(r.out), r.out);
  assert.match(r.out, new RegExp(`^#   ${fix}[0-9a-f]* Fix 1\\.21 only bug \\(ignored in the config\\)$`, 'm'));
});

test('fails clearly when the last release tag is missing', () => {
  const r = sb.run('cc-changelog-draft', ['--since', '1.21.1-9.9.9'], { cwd: mc21 });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /tag 1\.21\.1-9\.9\.9 doesn't exist/);
});

test('cc-changelog writes the draft and cc-changelog-confirm finalizes it', () => {
  let r = sb.run('cc-changelog', ['patch'], { cwd: mc21 });
  assert.strictEqual(r.code, 0, r.out + r.err);
  const file = path.join(mc21, 'resources', 'changelog', '1.21.1-2.0.1.txt');
  assert.match(sb.read(file), /^# from 1\.20\.1-1\.0\.1$/m);
  assert.match(sb.read(path.join(mc21, 'gradle.properties')), /^mod_version=2\.0\.1$/m);

  r = sb.run('cc-changelog-confirm', [], { cwd: mc21 });
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.strictEqual(sb.read(file), `${HEADER21}`
    + 'Additions:\n* Support compat mod Y (#3)\n* Add translations through Crowdin (#5)\n\n'
    + 'Fixes:\n* Fix crash (#10), Closes #9\n  Hand-written detail.\n* Fix 1.21 only bug\n* Fix unreleased thing\n');
  assert.strictEqual(sb.git(mc21, 'log', '-1', '--format=%s').trim(), 'Bump mod version');
  assert.strictEqual(sb.git(mc21, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.match(sb.read(path.join(mc21, 'CHANGELOG-1.21.1.md')), /## \[1\.21\.1-2\.0\.1\]/);
});

test('cc-changelog-confirm refuses a changelog that is not ready', () => {
  const file = path.join(mc21, 'resources', 'changelog', '1.21.1-2.0.2.txt');
  sb.write(path.join(mc21, 'gradle.properties'), `${props('1.21.1', '2.0.2', '1.5.0-60')}compat=2\n`);
  sb.write(file, `${HEADER21}Fixes:\n----- TODO: arrange -----\n* Fix a\n`);
  const before = sb.git(mc21, 'rev-parse', 'HEAD');
  const r = sb.run('cc-changelog-confirm', [], { cwd: mc21 });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /not ready for release:\n  - it still contains the "TODO: arrange" marker/);
  assert.strictEqual(sb.git(mc21, 'rev-parse', 'HEAD'), before);
  assert.match(sb.read(file), /TODO/);
});
