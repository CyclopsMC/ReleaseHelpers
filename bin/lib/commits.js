'use strict';
// Decides which commits matter to players, i.e. warrant a release and a changelog entry.

const { git } = require('./git');

// Files that don't change what players get.
const DEV_ONLY_PATHS = [
  /^\.github\//,
  /^\.git(ignore|attributes|modules)$/,
  /\.md$/i,
  /(^|\/)src\/test\//,
  /gametest/i,
  /^scripts\//,
  /^gradle\//,
  /(^|\/)gradlew(\.bat)?$/,
  /(^|\/)(build|settings)\.gradle(\.kts)?$/,
  /(^|\/)gradle\.properties$/,
  /^resources\/changelog\//,
  /^CHANGELOG/,
  /^crowdin\.yml$/,
  /^LICENSE/i,
  /^secrets\.properties_template$/,
  /\.jks(\.enc)?$/,
];

const TRANSLATION_FILE = /(^|\/)lang\/[^/]+$/;

// Returns { userFacing: true, kind } or { userFacing: false, reason }.
function classify(commit, extraDevOnlyPaths = []) {
  const { subject, body, files } = commit;
  if (/^Bump mod version\b/i.test(subject)) {
    return { userFacing: false, reason: 'release commit' };
  }
  // Compat bumps list their changelog entries in the commit body.
  if (/^Bump compat version\b/i.test(subject)) {
    return /^\* /m.test(body)
      ? { userFacing: true, kind: 'compat' }
      : { userFacing: false, reason: 'compat bump without changelog entries' };
  }
  if (files.length === 0) {
    return { userFacing: false, reason: 'no file changes' };
  }
  if (/^(New translations|Add translations through Crowdin)\b/i.test(subject) || files.every(f => TRANSLATION_FILE.test(f))) {
    return { userFacing: true, kind: 'translations' };
  }
  const devOnly = DEV_ONLY_PATHS.concat(extraDevOnlyPaths);
  if (files.every(f => devOnly.some(re => re.test(f)))) {
    return { userFacing: false, reason: 'only dev files' };
  }
  return { userFacing: true, kind: 'change' };
}

// Non-merge commits for the given revision arguments, newest first.
async function listCommits(cwd, revArgs) {
  const out = await git(cwd, ['log', '--no-merges', '--format=%x1e%H%x1f%s%x1f%b%x1f', '--name-only', ...revArgs, '--']);
  return out.split('\x1e').slice(1).map(chunk => {
    const [hash, subject, body, files] = chunk.split('\x1f');
    return {
      hash,
      subject,
      body: body.trim(),
      files: files.split('\n').map(f => f.trim()).filter(Boolean),
    };
  });
}

// Splits commits into user-facing ones and dropped ones (with the reason).
function partition(commits, extraDevOnlyPaths) {
  const userFacing = [];
  const dropped = [];
  for (const c of commits) {
    const r = classify(c, extraDevOnlyPaths);
    if (r.userFacing) userFacing.push({ ...c, kind: r.kind });
    else dropped.push({ ...c, reason: r.reason });
  }
  return { userFacing, dropped };
}

module.exports = { classify, listCommits, partition, DEV_ONLY_PATHS };
