'use strict';
// Commits you marked as needing a release or not, overriding the commit filter.
// Written by cc-mark (and the dashboard); you never edit the file yourself.

const fs = require('fs');
const os = require('os');
const path = require('path');

function marksPath() {
  if (process.env.CC_HELPERS_MARKS) return process.env.CC_HELPERS_MARKS;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'cc-helpers', 'marks.json');
}

// { file, commits: { <full hash>: { release, subject, mod, reason, date } } }
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
  return { file, commits: (json && json.commits) || {} };
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

function setMark(hash, { release, subject, mod, reason }, file) {
  return updateMarks(commits => {
    commits[hash] = { release: !!release, subject, mod, ...(reason ? { reason } : {}), date: new Date().toISOString() };
  }, file);
}

function clearMark(hash, file) {
  return updateMarks(commits => { delete commits[hash]; }, file);
}

module.exports = { marksPath, loadMarks, saveMarks, setMark, clearMark };
