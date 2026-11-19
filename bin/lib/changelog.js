'use strict';
// Changelog files: parsing, drafting from commits, and finalizing before release.

const { git, gitOrNull, readBlobs } = require('./git');
const { listCommits, classify, withBranch } = require('./commits');
const { readPropsAt } = require('./props');

const SECTIONS = ['Additions', 'Changes', 'Fixes'];
const SECTION_LINE = /^(Additions|Changes|Fixes):\s*$/;
const TRAILER = /^(Closes|Fixes|Required for|Related to|Requires|Part of|Refs)\b/i;
const TRAILER_IN_ENTRY = /,\s*(Closes|Fixes|Required for|Related to|Requires|Part of|Refs)\b.*$/i;
const IGNORED_BODY_LINE = /^(Co-authored-by|Signed-off-by):/i;
const TRANSLATIONS_ENTRY = 'Add translations through Crowdin';

// Section per first word, based on the published changelogs of the Cyclops mods.
const FIX_WORDS = new Set(['fix', 'fixed', 'fixes', 'validate', 'revert', 'remove', "don't", 'only', 'make']);
const ADD_WORDS = new Set(['add', 'allow', 'show', 'expose', 'let']);

function sectionFor(subject) {
  const word = (subject.split(/\s+/)[0] || '').toLowerCase();
  if (FIX_WORDS.has(word)) return 'Fixes';
  if (ADD_WORDS.has(word)) return 'Additions';
  return 'Changes';
}

const normalize = s => s.replace(/\(#\d+\)/g, '').replace(/\s+/g, '').toLowerCase();

// Identity of an entry, ignoring PR numbers and trailers like ", Closes #1".
function entryKey(text) {
  return normalize(text.split('\n')[0].replace(/^\*\s*/, '').replace(TRAILER_IN_ENTRY, ''));
}

const subjectKey = subject => normalize(subject);
const isTranslationsKey = key => key.startsWith(normalize(TRANSLATIONS_ENTRY));

// Section headers as written in changelogs and in compat bump commit messages.
const SECTION_NAMES = { additions: 'Additions', added: 'Additions', changes: 'Changes', changed: 'Changes', fixes: 'Fixes', fixed: 'Fixes' };
const ANY_SECTION_LINE = /^(Additions|Added|Changes|Changed|Fixes|Fixed):\s*$/i;

// Entries ({ section, text }) of a changelog; text may span several lines.
function parseEntries(text) {
  const entries = [];
  let section = null;
  let current = null;
  let blanks = 0;
  for (const line of (text || '').split(/\r?\n/)) {
    const m = ANY_SECTION_LINE.exec(line);
    if (m) {
      section = SECTION_NAMES[m[1].toLowerCase()];
      current = null;
    } else if (section && line.startsWith('* ')) {
      current = { section, text: line.replace(/\s+$/, '') };
      entries.push(current);
    } else if (!line.trim()) {
      blanks++;
      continue;
    } else if (current && !line.startsWith('#')) {
      // Keep blank lines inside an entry, but not the ones after it.
      current.text += `${'\n'.repeat(blanks)}\n${line.replace(/\s+$/, '')}`;
    }
    blanks = 0;
  }
  return entries;
}

// Changelog entry for a regular commit: subject, trailers folded in, body indented.
function entryText(commit) {
  const lines = commit.body.split('\n');
  // GitHub squash merges list the squashed commits as bullets, ended by a line of dashes.
  const sep = lines.findIndex(l => /^-{5,}$/.test(l.trim()));
  const trailers = [];
  const body = [];
  lines.forEach((l, i) => {
    const s = l.trim();
    if (!s || IGNORED_BODY_LINE.test(s)) return;
    if (sep >= 0 && i <= sep && (i === sep || s.startsWith('* '))) return;
    if (TRAILER.test(s)) trailers.push(s);
    else body.push(`  ${s}`);
  });
  return [`* ${[commit.subject].concat(trailers).join(', ')}`].concat(body).join('\n');
}

function entriesFromCommit(commit, kind) {
  if (kind === 'compat') {
    const entries = parseEntries(commit.body);
    return entries.length ? entries : parseEntries(`Changes:\n${commit.body}`);
  }
  if (kind === 'translations') {
    const pr = /\(#\d+\)/.exec(commit.subject);
    return [{ section: 'Additions', text: `* ${TRANSLATIONS_ENTRY}${pr ? ` ${pr[0]}` : ''}` }];
  }
  return [{ section: sectionFor(commit.subject), text: entryText(commit) }];
}

const versionParts = tag => (tag.match(/\d+/g) || []).map(Number);
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}
const sortTags = tags => tags.filter(Boolean).sort(compareVersions);
const lines = out => out.split('\n').filter(Boolean);

// Released entries of an MC version (key -> release), from the changelog files at `rev`.
async function releasedEntries(cwd, rev, mc) {
  const names = lines(await gitOrNull(cwd, ['ls-tree', '--name-only', `${rev}:resources/changelog/`]) || '')
    .filter(n => n.startsWith(`${mc}-`) && n.endsWith('.txt'))
    .sort(compareVersions);
  const texts = await readBlobs(cwd, names.map(n => `${rev}:resources/changelog/${n}`));
  const released = new Map();
  names.forEach((n, i) => {
    for (const e of parseEntries(texts[i])) {
      const k = entryKey(e.text);
      if (!isTranslationsKey(k) && !released.has(k)) released.set(k, n.replace(/\.txt$/, ''));
    }
  });
  return released;
}

// Subjects of the commits in a source release, i.e. since the source release before it.
async function releaseSubjects(cwd, tag, srcTags) {
  const i = srcTags.indexOf(tag);
  const range = i > 0 ? [`refs/tags/${srcTags[i - 1]}..refs/tags/${tag}`] : ['-n', '500', `refs/tags/${tag}`];
  return new Set(lines(await git(cwd, ['log', '--no-merges', '--format=%s', ...range])).map(subjectKey));
}

// Whether some commits of a source release were already upmerged before `since`.
async function mergedBeforeSince(cwd, tag, srcTags, since) {
  const i = srcTags.indexOf(tag);
  if (i <= 0) return false;
  const range = [`refs/tags/${tag}`, `^refs/tags/${srcTags[i - 1]}`];
  const all = Number(await git(cwd, ['rev-list', '--count', ...range]));
  const notMerged = Number(await git(cwd, ['rev-list', '--count', ...range, `^refs/tags/${since}`]));
  return notMerged < all;
}

// Drafts the changelog of the next release: commits since `since` up to `head`.
// Commits upmerged from `srcBranch` reuse the entries of the source release that contains them,
// so manual edits made there carry over. Entries already released on this MC version are left out.
// `filter` is the commit filter from the config (devOnlyPaths, marks); marks for `branch` apply.
async function draftChangelog({ cwd, mc, since, head = 'HEAD', srcBranch = null, branch = 'this branch', header = [], filter: configFilter = {}, comments = true }) {
  const filter = withBranch(configFilter, branch);
  const commits = await listCommits(cwd, [`refs/tags/${since}..${head}`]);
  const srcRef = srcBranch ? `refs/remotes/origin/${srcBranch}` : null;
  const notes = [];

  // Upmerged commit -> first source release containing it (null if not released there yet).
  const fromSrc = new Map();
  let srcTags = [];
  if (srcRef && (await gitOrNull(cwd, ['rev-parse', '-q', '--verify', `${srcRef}^{commit}`]))) {
    const srcMc = (await readPropsAt(cwd, srcRef)).minecraft_version;
    const inSrc = new Set(lines(await git(cwd, ['rev-list', srcRef, `^refs/tags/${since}`])));
    if (srcMc) srcTags = sortTags(lines(await git(cwd, ['tag', '-l', `${srcMc}-*`])));
    for (const c of commits) {
      if (!inSrc.has(c.hash)) continue;
      const containing = srcMc ? sortTags(lines(await git(cwd, ['tag', '--contains', c.hash, '-l', `${srcMc}-*`]))) : [];
      fromSrc.set(c.hash, containing[0] || null);
    }
  } else if (srcBranch) {
    notes.push(`origin/${srcBranch} not found, so nothing was carried over from it`);
  }

  const released = await releasedEntries(cwd, head, mc);
  const keys = new Set();
  const entries = [];
  const skipped = [];
  const add = (e, origin) => {
    const k = entryKey(e.text);
    if (keys.has(k)) return;
    keys.add(k);
    if (released.has(k)) skipped.push({ text: e.text, release: released.get(k) });
    else entries.push({ ...e, origin });
  };

  // Entries of the source releases, as published there.
  const upmergedSubjects = new Set(commits.filter(c => fromSrc.get(c.hash)).map(c => subjectKey(c.subject)));
  for (const tag of sortTags([...new Set(fromSrc.values())])) {
    const subjects = await releaseSubjects(cwd, tag, srcTags);
    const mergedBefore = await mergedBeforeSince(cwd, tag, srcTags, since);
    const [text] = await readBlobs(cwd, [`refs/tags/${tag}:resources/changelog/${tag}.txt`]);
    for (const e of parseEntries(text)) {
      const k = entryKey(e.text);
      // Entries for commits outside this range came with an earlier upmerge. Entries matching
      // no commit (rewritten by hand) come along the first time this source release is upmerged.
      if (subjects.has(k) ? !upmergedSubjects.has(k) : mergedBefore) continue;
      add(e, `from ${tag}`);
    }
  }

  // Everything else is drafted from the commits.
  const dropped = [];
  for (const c of commits) {
    if (fromSrc.get(c.hash)) continue;
    const r = classify(c, filter);
    if (!r.userFacing) {
      dropped.push({ commit: c, reason: r.reason });
      continue;
    }
    const origin = fromSrc.has(c.hash) ? `from ${srcBranch}, not released there yet` : `only on ${branch}`;
    for (const e of entriesFromCommit(c, r.kind)) add(e, origin);
  }

  return renderDraft({ header, entries, skipped, dropped, notes, comments, since });
}

function renderDraft({ header, entries, skipped, dropped, notes, comments, since }) {
  const out = [...header, ''];
  if (comments) {
    out.push('# Draft made by cc-changelog-draft: review every entry. Lines starting with # are removed on release.');
    for (const n of notes) out.push(`# Note: ${n}.`);
    if (!entries.length) out.push(`# No user-facing commits found since ${since}.`);
  }
  for (const s of SECTIONS) {
    out.push(`${s}:`);
    let origin = null;
    for (const e of entries.filter(x => x.section === s)) {
      if (comments && e.origin !== origin) out.push(`# ${e.origin}`);
      origin = e.origin;
      out.push(e.text);
    }
    out.push('');
  }
  if (comments && (skipped.length || dropped.length)) {
    out.push('# Left out:');
    for (const s of skipped) out.push(`#   ${s.text.split('\n')[0]} (already in ${s.release})`);
    for (const d of dropped) out.push(`#   ${d.commit.hash.slice(0, 9)} ${d.commit.subject} (${d.reason})`);
  }
  while (out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

// Removes # comments and empty sections; returns { text, errors }.
function finalizeChangelog(input) {
  const kept = input.split(/\r?\n/).filter(l => !l.startsWith('#')).map(l => l.replace(/\s+$/, ''));
  const withoutEmpty = kept.filter((l, i) => {
    if (!SECTION_LINE.test(l)) return true;
    const next = kept.slice(i + 1).find(x => x !== '');
    return next !== undefined && !SECTION_LINE.test(next);
  });
  const result = [];
  for (const l of withoutEmpty) {
    if (l === '' && (result.length === 0 || result[result.length - 1] === '')) continue;
    result.push(l);
  }
  while (result.length && result[result.length - 1] === '') result.pop();

  const errors = [];
  if (result.some(l => /^-+\s*TODO/i.test(l))) errors.push('it still contains the "TODO: arrange" marker');
  if (result.some(l => /^\* Bump (mod|compat) version\b/i.test(l))) errors.push('it contains a "Bump ... version" entry');
  if (result.some(l => /^(<<<<<<<|>>>>>>>)( |$)/.test(l))) errors.push('it contains merge conflict markers');
  const blank = result.indexOf('');
  if (blank < 0 || !result.slice(blank + 1).some(l => l !== '')) errors.push('it has no entries');
  return { text: `${result.join('\n')}\n`, errors };
}

// Releases with Additions are usually minor ones.
function suggestBump(text) {
  return parseEntries(text).some(e => e.section === 'Additions') ? 'minor' : 'patch';
}

module.exports = {
  SECTIONS,
  parseEntries,
  entryKey,
  entryText,
  entriesFromCommit,
  sectionFor,
  draftChangelog,
  finalizeChangelog,
  suggestBump,
  compareVersions,
};
