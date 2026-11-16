'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classify } = require('../bin/lib/commits');

const c = (subject, files, body = '') => ({ hash: 'x', subject, body, files });

test('release commits are dropped', () => {
  assert.deepStrictEqual(classify(c('Bump mod version', ['gradle.properties', 'resources/changelog/1.20.1-1.0.1.txt'])),
    { userFacing: false, reason: 'release commit' });
});

test('compat bumps count only when they carry changelog entries', () => {
  assert.strictEqual(classify(c('Bump compat version', ['gradle.properties'], 'Fixes:\n* Fix a compat crash')).userFacing, true);
  assert.strictEqual(classify(c('Bump compat version', ['gradle.properties'])).userFacing, false);
});

test('translations are recognized by subject or by files', () => {
  assert.strictEqual(classify(c('New Translations (#12)', ['crowdin.yml'])).kind, 'translations');
  assert.strictEqual(classify(c('Update German', ['src/main/resources/assets/mod/lang/de_de.json'])).kind, 'translations');
  assert.strictEqual(classify(c('Add translations through Crowdin (#239)', ['src/main/resources/assets/mod/lang/fr_fr.json'])).kind, 'translations');
});

test('commits touching only dev files are dropped', () => {
  for (const files of [
    ['AGENTS.md'],
    ['.github/workflows/ci.yml', 'build.gradle'],
    ['src/test/java/FooTest.java'],
    ['loader-common/src/test/java/FooTest.java'],
    ['src/main/java/org/cyclops/mod/gametest/GameTestsFoo.java'],
    ['loader-neoforge/build.gradle', 'gradle/wrapper/gradle-wrapper.properties', 'gradlew'],
    ['CLAUDE.md'],
    ['buildSrc/src/main/groovy/multiloader-common.gradle', 'loader-neoforge/build.gradle'],
    ['build.gradle', 'buildSrc/src/main/groovy/multiloader-common.gradle', 'gradle.properties'],
  ]) {
    assert.deepStrictEqual(classify(c('Some change', files)), { userFacing: false, reason: 'only dev files' }, files.join(','));
  }
});

test('a single shipped file makes a commit user-facing', () => {
  assert.deepStrictEqual(classify(c('Fix crash', ['src/main/java/Foo.java', 'src/test/java/FooTest.java'])),
    { userFacing: true, kind: 'change' });
});

test('extra dev-only paths from the config are honored', () => {
  assert.strictEqual(classify(c('Tweak', ['docs/x.txt']), [/^docs\//]).userFacing, false);
  assert.strictEqual(classify(c('Tweak', ['docs/x.txt'])).userFacing, true);
});

test('commits without file changes are dropped', () => {
  assert.strictEqual(classify(c('Empty', [])).userFacing, false);
});
