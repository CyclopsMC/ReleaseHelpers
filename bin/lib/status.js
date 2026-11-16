'use strict';
// Release status of mods across the maintained MC versions.

const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { git, gitOrNull, runPool } = require('./git');
const { listCommits, partition } = require('./commits');

const FETCH_TIMEOUT_MS = 120000;

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function isModRepo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  return ['gradle.properties', 'build.properties']
    .some(f => /^mod_version\s*=/m.test(readFileOrNull(path.join(dir, f)) || ''));
}

// Repository name of origin, e.g. "EvilCraft" for git@github.com:CyclopsMC/EvilCraft.git.
function originName(dir) {
  let url = null;
  const config = readFileOrNull(path.join(dir, '.git', 'config'));
  if (config !== null) {
    const section = /\[remote "origin"\]([^[]*)/.exec(config);
    const m = section && /^\s*url\s*=\s*(.+?)\s*$/m.exec(section[1]);
    url = m ? m[1] : null;
  } else {
    // A worktree or submodule-style .git file.
    try {
      url = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      url = null;
    }
  }
  return url ? url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:\\]/).pop() : null;
}

// Mod names (sorted), per version index the set of mods checked out there, and the checkouts
// that were skipped because they aren't named after their origin repository (e.g. temporary copies).
function discoverMods(config) {
  const skipped = [];
  const byVersion = config.versions.map(v => {
    let names = [];
    try {
      names = fs.readdirSync(v.dir);
    } catch (e) {
      // Missing version dir is reported by checkVersionDirs.
    }
    return new Set(names.filter(n => {
      const dir = path.join(v.dir, n);
      if (n.startsWith('.') || !isDir(dir) || !isModRepo(dir)) return false;
      const origin = originName(dir);
      if (origin && origin.toLowerCase() === n.toLowerCase()) return true;
      skipped.push({ version: v.name, name: n, origin });
      return false;
    }));
  });
  const mods = [...new Set(byVersion.flatMap(s => [...s]))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { mods, byVersion, skipped };
}

// Problems with the version dirs that cc-upmerge would trip over.
function checkVersionDirs(config) {
  const warnings = [];
  config.versions.forEach((v, i) => {
    if (!isDir(v.dir)) {
      warnings.push(`${v.dir} does not exist`);
      return;
    }
    if (i === 0) return;
    const file = path.join(v.dir, '.upmerge-src-branch');
    const src = readFileOrNull(file);
    const expected = config.versions[i - 1].branch;
    if (src === null) warnings.push(`${file} is missing (cc-upmerge needs it)`);
    else if (src.trim() !== expected) warnings.push(`${file} says ${src.trim()}, but the version before it in the config is ${expected}`);
  });
  return warnings;
}

function parseProps(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^#!\s=:][^=:\s]*)\s*[=:]\s*(.*)$/.exec(line);
    if (m) props[m[1]] = m[2].trim();
  }
  return props;
}

async function readPropsAt(repoDir, ref) {
  for (const f of ['gradle.properties', 'build.properties']) {
    const text = await gitOrNull(repoDir, ['show', `${ref}:${f}`]);
    if (text !== null && /^mod_version\s*=/m.test(text)) return parseProps(text);
  }
  return {};
}

const CLOBBERED_TAG = /^! \[rejected\]\s+(\S+)\s+->\s+\S+\s+\(would clobber existing tag\)$/;

// Fetches the refspecs and tags. Returns the local tags that differ from origin: git refuses to
// overwrite those (e.g. after a tag was recreated on GitHub), but still updates the branches.
async function fetchRefspecs(repoDir, refspecs) {
  const args = ['fetch', '--tags', 'origin', ...refspecs];
  for (let attempt = 0; ; attempt++) {
    try {
      await git(repoDir, args, { timeout: FETCH_TIMEOUT_MS });
      return [];
    } catch (e) {
      const problems = e.stderr ? e.stderr.split('\n').map(l => l.trim()).filter(l => /^(fatal|error|!)/.test(l)) : [];
      const clobbered = problems.map(l => CLOBBERED_TAG.exec(l)).filter(Boolean).map(m => m[1]);
      if (problems.length && clobbered.length === problems.length) return clobbered;
      // Another process (IDE, other chain) may hold a ref lock briefly.
      if (attempt > 0 || !/lock/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Fetches the branch and the lower branches; lower ones may not exist remotely.
// Returns the local tags that differ from origin.
async function fetchBranches(repoDir, branch, lowerBranches) {
  const spec = b => `+refs/heads/${b}:refs/remotes/origin/${b}`;
  try {
    return await fetchRefspecs(repoDir, [branch, ...lowerBranches].map(spec));
  } catch (e) {
    if (lowerBranches.length === 0) throw e;
    const clobbered = await fetchRefspecs(repoDir, [spec(branch)]);
    for (const b of lowerBranches) {
      try {
        await fetchRefspecs(repoDir, [spec(b)]);
      } catch (e2) {
        // Not on the remote.
      }
    }
    return clobbered;
  }
}

function describeClobbered(tags) {
  const names = tags.slice(0, 3).join(', ') + (tags.length > 3 ? `, and ${tags.length - 3} more` : '');
  return `${tags.length === 1 ? 'tag' : 'tags'} ${names} ${tags.length === 1 ? 'differs' : 'differ'} from origin `
    + '(to use the ones from origin: git fetch --tags --force origin)';
}

async function refExists(repoDir, ref) {
  return (await gitOrNull(repoDir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])) !== null;
}

async function localIssues(repoDir, branch, remoteRef) {
  const issues = [];
  const head = await gitOrNull(repoDir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (head !== branch) issues.push(head ? `on branch ${head}, expected ${branch}` : `detached HEAD, expected ${branch}`);
  if (await gitOrNull(repoDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) issues.push('merge in progress');
  if (await gitOrNull(repoDir, ['status', '--porcelain', '--untracked-files=no'])) issues.push('uncommitted changes');
  if (head === branch) {
    const ahead = await gitOrNull(repoDir, ['rev-list', '--count', `${remoteRef}..HEAD`]);
    if (ahead && ahead !== '0') issues.push(`${ahead} unpushed commit${ahead === '1' ? '' : 's'}`);
  }
  return issues;
}

// Status of one mod checkout for one MC version.
//   lastRelease: tag of the last release on this MC version, or null if there is none yet
//   unreleased:  commits since lastRelease (null if no release yet)
//   pending:     commits on lower maintained branches that this branch lacks
async function cellStatus({ repoDir, version, lowerBranches, fetch, filter }) {
  const clobbered = fetch ? await fetchBranches(repoDir, version.branch, lowerBranches) : [];
  const ref = `refs/remotes/origin/${version.branch}`;
  if (!(await refExists(repoDir, ref))) throw new Error(`origin/${version.branch} not found`);
  const props = await readPropsAt(repoDir, ref);
  const mc = props.minecraft_version;
  const modVersion = props.mod_version;
  if (!mc || !modVersion) throw new Error(`no minecraft_version or mod_version on origin/${version.branch}`);

  let lastRelease = `${mc}-${modVersion}`;
  if (!(await refExists(repoDir, `refs/tags/${lastRelease}`))) {
    lastRelease = await gitOrNull(repoDir, ['describe', '--tags', '--abbrev=0', '--match', `${mc}-*`, ref]);
  }
  const lowerRefs = [];
  for (const b of lowerBranches) {
    if (await refExists(repoDir, `refs/remotes/origin/${b}`)) lowerRefs.push(`refs/remotes/origin/${b}`);
  }
  const unreleased = lastRelease
    ? partition(await listCommits(repoDir, [`refs/tags/${lastRelease}..${ref}`]), filter)
    : null;
  const pending = lowerRefs.length
    ? partition(await listCommits(repoDir, [...lowerRefs, `^${ref}`]), filter)
    : partition([], filter);
  const local = await localIssues(repoDir, version.branch, ref);
  // The last release decides what counts as unreleased; other differing tags don't matter here.
  if (lastRelease && clobbered.includes(lastRelease)) local.push(describeClobbered([lastRelease]));
  const otherDifferingTags = clobbered.filter(t => t !== lastRelease);
  return { mc, modVersion, lastRelease, unreleased, pending, local, otherDifferingTags };
}

// User-facing commits that a release chain starting here would pick up.
function cellUserFacing(cell) {
  if (!cell || cell.missing || cell.error) return [];
  return (cell.unreleased ? cell.unreleased.userFacing : []).concat(cell.pending.userFacing);
}

// Computes status[mod][versionIndex] for the given mods.
async function computeStatus(config, { mods, byVersion }, { fetch = true, jobs = 8, onProgress } = {}) {
  const status = {};
  const tasks = [];
  for (const mod of mods) {
    status[mod] = config.versions.map(() => ({ missing: true }));
    config.versions.forEach((version, i) => {
      if (!byVersion[i].has(mod)) return;
      const lowerBranches = config.versions.slice(0, i).filter((_, j) => byVersion[j].has(mod)).map(v => v.branch);
      const repoDir = path.join(version.dir, mod);
      tasks.push(async () => {
        try {
          status[mod][i] = await cellStatus({ repoDir, version, lowerBranches, fetch, filter: config.commitFilter });
        } catch (error) {
          status[mod][i] = { error: error.message };
        }
      });
    });
  }
  await runPool(tasks, jobs, onProgress);
  return status;
}

// Mods without a release on any of their versions (like the compat mods) are only upmerged.
function isUpmergeOnly(cells) {
  const present = cells.filter(c => !c.missing);
  return present.length > 0 && present.every(c => !c.error && !c.lastRelease);
}

// Index of the lowest version a release chain for this mod should start at, or -1.
function chainStart(cells) {
  return cells.findIndex(c => cellUserFacing(c).length > 0);
}

module.exports = { discoverMods, checkVersionDirs, computeStatus, chainStart, cellUserFacing, isUpmergeOnly, parseProps };
