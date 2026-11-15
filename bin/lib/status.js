'use strict';
// Release status of mods across the maintained MC versions.

const fs = require('fs');
const path = require('path');
const { git, gitOrNull, runPool } = require('./git');
const { listCommits, partition } = require('./commits');
const { readPropsAt } = require('./props');

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

// Mod names (sorted), and per version index the set of mods checked out there.
function discoverMods(config) {
  const byVersion = config.versions.map(v => {
    let names = [];
    try {
      names = fs.readdirSync(v.dir);
    } catch (e) {
      // Missing version dir is reported by checkVersionDirs.
    }
    return new Set(names.filter(n => !n.startsWith('.') && isDir(path.join(v.dir, n)) && isModRepo(path.join(v.dir, n))));
  });
  const mods = [...new Set(byVersion.flatMap(s => [...s]))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { mods, byVersion };
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

async function fetchRefspecs(repoDir, refspecs) {
  const args = ['fetch', '--quiet', '--tags', 'origin', ...refspecs];
  try {
    await git(repoDir, args, { timeout: FETCH_TIMEOUT_MS });
  } catch (e) {
    // Another process (IDE, other chain) may hold a ref lock briefly.
    if (!/lock/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 1000));
    await git(repoDir, args, { timeout: FETCH_TIMEOUT_MS });
  }
}

// Fetches the branch and the lower branches; lower ones may not exist remotely.
async function fetchBranches(repoDir, branch, lowerBranches) {
  const spec = b => `+refs/heads/${b}:refs/remotes/origin/${b}`;
  try {
    await fetchRefspecs(repoDir, [branch, ...lowerBranches].map(spec));
  } catch (e) {
    if (lowerBranches.length === 0) throw e;
    await fetchRefspecs(repoDir, [spec(branch)]);
    for (const b of lowerBranches) {
      try {
        await fetchRefspecs(repoDir, [spec(b)]);
      } catch (e2) {
        // Not on the remote.
      }
    }
  }
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
async function cellStatus({ repoDir, version, lowerBranches, fetch, devOnlyPaths }) {
  if (fetch) await fetchBranches(repoDir, version.branch, lowerBranches);
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
    ? partition(await listCommits(repoDir, [`refs/tags/${lastRelease}..${ref}`]), devOnlyPaths)
    : null;
  const pending = lowerRefs.length
    ? partition(await listCommits(repoDir, [...lowerRefs, `^${ref}`]), devOnlyPaths)
    : partition([], devOnlyPaths);
  const local = await localIssues(repoDir, version.branch, ref);
  return { mc, modVersion, lastRelease, unreleased, pending, local };
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
          status[mod][i] = await cellStatus({ repoDir, version, lowerBranches, fetch, devOnlyPaths: config.devOnlyPaths });
        } catch (error) {
          status[mod][i] = { error: error.message };
        }
      });
    });
  }
  await runPool(tasks, jobs, onProgress);
  return status;
}

// Index of the lowest version a release chain for this mod should start at, or -1.
function chainStart(cells) {
  return cells.findIndex(c => cellUserFacing(c).length > 0);
}

module.exports = { discoverMods, checkVersionDirs, computeStatus, cellStatus, chainStart, cellUserFacing };
