'use strict';
// What the dashboard's strip says was shipped: releases per week, and their changelog entries.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { createSandbox } = require('./helpers');
const { shipped } = require('../bin/lib/momentum');

const DAY = 86400000;
const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\n`;
let sb;
after(() => sb && sb.cleanup());

test('counts releases per week, and the changelog entries of the last 30 days once', async () => {
  sb = createSandbox('cc-momentum-test-');
  const w = sb.newMod('ModM');
  const release = (mc, version, changelog, date) => {
    const tag = `${mc}-${version}`;
    sb.commit(w, `Release ${tag}`, { 'gradle.properties': props(mc, version), [`resources/changelog/${tag}.txt`]: changelog });
    const time = `${Math.floor(date / 1000)} +0000`;
    execFileSync('git', ['tag', '-a', '-m', 'Release', tag], { cwd: w, env: { ...sb.env, GIT_COMMITTER_DATE: time, GIT_AUTHOR_DATE: time } });
  };
  const now = Date.parse('2026-11-21T12:00:00Z');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  // 40 days ago: in the weekly chart, not in the last 30 days.
  release('1.21.1', '1.0.0', 'Fixes:\n* Fix an old crash\n', now - 40 * DAY);
  release('1.21.1', '1.0.1', 'Fixes:\n* Fix a crash\n* Fix a dupe\n\nAdditions:\n* Add a mode\n', now - 2 * DAY);
  // The same fix released on another MC version counts once; translations on their own.
  release('1.20.1', '0.9.1', 'Fixes:\n* Fix a crash\n\nChanges:\n* Add translations through Crowdin\n* Speed up loading\n', now - 1 * DAY);
  // Not a maintained MC version.
  release('1.19.2', '0.5.0', 'Fixes:\n* Fix something else\n', now - 1 * DAY);

  const r = await shipped([{ name: 'ModM', dirs: [w] }], ['1.20.1', '1.21.1'], now);
  assert.strictEqual(r.releases, 2);
  assert.deepStrictEqual(r.counts, { Fixes: 2, Additions: 1, Changes: 1, translations: 1 });
  assert.deepStrictEqual(r.weeks, [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2]);
  assert.strictEqual(r.streak, 1);
});

test('a week without a release yet does not break the streak', async () => {
  const w = sb.path('work', 'ModM');
  const now = Date.parse('2026-11-21T12:00:00Z');
  // A week later, with no release since: last week still counts.
  const r = await shipped([{ name: 'ModM', dirs: [w] }], ['1.20.1', '1.21.1'], now + 7 * DAY);
  assert.strictEqual(r.weeks[11], 0);
  assert.strictEqual(r.weeks[10], 2);
  assert.strictEqual(r.streak, 1);
  assert.strictEqual(r.releases, 2);
});
