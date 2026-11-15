'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseEntries, entryText, sectionFor, finalizeChangelog, suggestBump, entriesFromCommit } = require('../bin/lib/changelog');

const HEADER = "As always, don't forget to backup your world before updating!\nRequires CyclopsCore version 1.0.0 or higher.\n\n";

test('parses entries with their section, keeping blank lines inside entries', () => {
  const entries = parseEntries(`${HEADER}Additions:\n* Add a\n  more about a\n\n  even more\n\n* Add b\n\nFixes:\n* Fix c\n\n`);
  assert.deepStrictEqual(entries, [
    { section: 'Additions', text: '* Add a\n  more about a\n\n  even more' },
    { section: 'Additions', text: '* Add b' },
    { section: 'Fixes', text: '* Fix c' },
  ]);
});

test('accepts Added/Changed/Fixed headers, as used in compat bump commits', () => {
  assert.deepStrictEqual(parseEntries('Added:\n* Support Y (#3)\nFixed:\n* Fix Z'), [
    { section: 'Additions', text: '* Support Y (#3)' },
    { section: 'Fixes', text: '* Fix Z' },
  ]);
});

test('ignores comment lines and text outside sections', () => {
  assert.deepStrictEqual(parseEntries('* not in a section\nFixes:\n# from x\n* Fix a\n# note'), [
    { section: 'Fixes', text: '* Fix a' },
  ]);
});

test('drafts an entry from a commit: trailers folded, body indented', () => {
  const text = entryText({ subject: 'Fix crash (#10)', body: 'Happens when X.\n\nCloses #9\nCo-authored-by: A <a@b>' });
  assert.strictEqual(text, '* Fix crash (#10), Closes #9\n  Happens when X.');
});

test('drops the squashed commit list of GitHub squash merges', () => {
  const text = entryText({ subject: 'Add fuzzing (#1607)', body: 'Context line.\n\n* Initial plan\n* Add test\n\n---------\n\nCo-authored-by: Bot <b@c>' });
  assert.strictEqual(text, '* Add fuzzing (#1607)\n  Context line.');
});

test('picks a section from the first word', () => {
  assert.strictEqual(sectionFor('Fix crash'), 'Fixes');
  assert.strictEqual(sectionFor('Validate packets'), 'Fixes');
  assert.strictEqual(sectionFor('Add thing'), 'Additions');
  assert.strictEqual(sectionFor('Allow thing'), 'Additions');
  assert.strictEqual(sectionFor('Improve performance'), 'Changes');
});

test('turns compat bumps and translations into entries', () => {
  assert.deepStrictEqual(entriesFromCommit({ subject: 'Bump compat version', body: 'Changes:\n* Restore REI support' }, 'compat'),
    [{ section: 'Changes', text: '* Restore REI support' }]);
  assert.deepStrictEqual(entriesFromCommit({ subject: 'Bump compat version', body: '* Restore REI support' }, 'compat'),
    [{ section: 'Changes', text: '* Restore REI support' }]);
  assert.deepStrictEqual(entriesFromCommit({ subject: 'New Translations (#1672)', body: '' }, 'translations'),
    [{ section: 'Additions', text: '* Add translations through Crowdin (#1672)' }]);
});

test('finalizing removes comments and empty sections', () => {
  const { text, errors } = finalizeChangelog(`${HEADER}# Draft\nAdditions:\n# from x\n* Add a\n\nChanges:\n\nFixes:\n\n# Left out:\n#   foo\n`);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(text, `${HEADER}Additions:\n* Add a\n`);
});

test('finalizing keeps free text, like an initial release', () => {
  const input = `${HEADER}Initial 1.21.1 release\n`;
  assert.deepStrictEqual(finalizeChangelog(input), { text: input, errors: [] });
});

test('finalizing reports what is not ready', () => {
  const errors = text => finalizeChangelog(text).errors;
  assert.deepStrictEqual(errors(`${HEADER}Additions:\n\nChanges:\n\nFixes:\n`), ['it has no entries']);
  assert.match(errors(`${HEADER}Fixes:\n----- TODO: arrange -----\n* Fix a\n`)[0], /TODO/);
  assert.match(errors(`${HEADER}Fixes:\n* Bump mod version\n* Fix a\n`)[0], /Bump/);
  assert.match(errors(`${HEADER}Fixes:\n<<<<<<< HEAD\n* Fix a\n>>>>>>> other\n`)[0], /conflict/);
});

test('suggests minor for releases with additions', () => {
  assert.strictEqual(suggestBump(`${HEADER}Additions:\n* Add a\n`), 'minor');
  assert.strictEqual(suggestBump(`${HEADER}Fixes:\n* Fix a\n`), 'patch');
});
