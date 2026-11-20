'use strict';
// Commits you marked as needing a release or not, overriding the commit filter. A mark applies to
// one maintained branch (MC version), or to all of them ('*'); one for a branch wins.
// Written by cc-mark and cc-dashboard; you never edit the file yourself.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALL = '*';

function marksPath() {
  if (process.env.CC_HELPERS_MARKS) return process.env.CC_HELPERS_MARKS;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'cc-helpers', 'marks.json');
}

// An entry of the first format had one mark for all versions at the top level.
function normalize(entry) {
  if (!entry || entry.marks) return entry;
  const { release, reason, date, ...rest } = entry;
  return { ...rest, marks: { [ALL]: { release, ...(reason ? { reason } : {}), date } } };
}

// { file, commits: { <full hash>: { subject, mod, marks: { <branch> | '*': { release, reason, date } } } } }
function loadMarks(file = marksPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { file, commits: {} };
    throw e;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
  const commits = {};
  for (const [hash, entry] of Object.entries((json && json.commits) || {})) commits[hash] = normalize(entry);
  return { file, commits };
}

function saveMarks(marks) {
  fs.mkdirSync(path.dirname(marks.file), { recursive: true });
  const tmp = `${marks.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ commits: marks.commits }, null, 2)}\n`);
  fs.renameSync(tmp, marks.file);
}

// Re-reads the file right before writing, so concurrent writers only race on the same commit.
function updateMarks(change, file = marksPath()) {
  const marks = loadMarks(file);
  change(marks.commits);
  saveMarks(marks);
  return marks;
}

// The mark that applies on a branch, as { release, reason, date, scope }, or null.
function markFor(commits, hash, branch) {
  const entry = commits && commits[hash];
  if (!entry || !entry.marks) return null;
  const scope = branch && entry.marks[branch] ? branch : (entry.marks[ALL] ? ALL : null);
  return scope ? { ...entry.marks[scope], scope } : null;
}

// scope: a branch, or '*' for all versions.
function setMark(hash, { release, subject, mod, reason, scope = ALL }, file) {
  return updateMarks(commits => {
    const entry = commits[hash] || { subject, mod, marks: {} };
    entry.subject = subject || entry.subject;
    entry.mod = mod || entry.mod;
    entry.marks[scope] = { release: !!release, ...(reason ? { reason } : {}), date: new Date().toISOString() };
    commits[hash] = entry;
  }, file);
}

// Removes the mark for one scope, or with scope null every mark of the commit.
function clearMark(hash, scope = null, file) {
  return updateMarks(commits => {
    const entry = commits[hash];
    if (!entry) return;
    if (scope) delete entry.marks[scope];
    if (!scope || !Object.keys(entry.marks).length) delete commits[hash];
  }, file);
}

module.exports = { ALL, marksPath, loadMarks, saveMarks, setMark, clearMark, markFor };
