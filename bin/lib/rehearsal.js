'use strict';
// Rehearsals: a release chain on copies of the checkouts, pushing to a local stand-in for the
// real origin, so builds, Claude, the editor and signing run for real without publishing anything.

const fs = require('fs');
const path = require('path');
const { git, gitOrNull } = require('./git');
const { stateDir } = require('./lock');

const lines = out => (out || '').split('\n').filter(Boolean);
const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const absoluteGitDir = async repo => (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();

// Local git config that affects merging, signing and identity.
const COPIED_CONFIG = /^(merge|user|gpg|commit|tag)\./;

async function copyLocalConfig(from, to) {
  for (const line of lines(await gitOrNull(from, ['config', '--local', '--list']))) {
    const i = line.indexOf('=');
    const key = line.slice(0, i);
    if (COPIED_CONFIG.test(key)) await git(to, ['config', '--local', '--add', key, line.slice(i + 1)]);
  }
}

// Small top-level files that are ignored by git, such as secrets.properties.
async function copyIgnoredFiles(from, to) {
  const out = await git(from, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']);
  for (const f of lines(out)) {
    if (f.includes('/')) continue;
    const src = path.join(from, f);
    const stat = fs.statSync(src);
    if (stat.isFile() && stat.size <= 1024 * 1024) fs.copyFileSync(src, path.join(to, f));
  }
}

// Submodules (e.g. CommonCapabilitiesAPI) are cloned from the real checkout's submodules,
// or else from their URLs in .gitmodules. Returns a problem description, or null.
async function initSubmodules(real, copy) {
  if (!fs.existsSync(path.join(copy, '.gitmodules'))) return null;
  const paths = lines(await gitOrNull(copy, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']));
  for (const entry of paths) {
    const space = entry.indexOf(' ');
    const name = entry.slice('submodule.'.length, space - '.path'.length);
    const local = path.join(real, entry.slice(space + 1));
    if (fs.existsSync(path.join(local, '.git'))) await git(copy, ['config', `submodule.${name}.url`, local]);
  }
  try {
    await git(copy, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--quiet']);
    return null;
  } catch (e) {
    try {
      await git(copy, ['submodule', 'sync', '--recursive', '--quiet']);
      await git(copy, ['submodule', 'update', '--init', '--recursive', '--quiet']);
      return null;
    } catch (e2) {
      return `the submodules of ${copy} could not be set up, so its build may fail: ${e2.message}`;
    }
  }
}

async function refsOf(repo) {
  const out = await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']);
  return new Map(lines(out).map(l => l.split(' ')));
}

// Creates the rehearsal for a mod; returns its root, the stand-in origin, and a config whose
// version dirs point at the copies (each version keeps its real dir as `realDir`).
async function createRehearsal(config, found, mod, log = console.log) {
  const root = path.join(stateDir(), 'rehearsals', `${mod}-${timestamp()}`);
  const origin = path.join(root, 'origin', `${mod}.git`);
  const present = config.versions.filter(v => found.byVersion[v.index].has(mod));
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  await git(root, ['init', '--quiet', '--bare', origin]);

  // Share objects with the real checkouts instead of copying them.
  const objectDirs = [];
  for (const v of present) objectDirs.push(path.join(await absoluteGitDir(path.join(v.dir, mod)), 'objects'));
  fs.writeFileSync(path.join(origin, 'objects', 'info', 'alternates'), `${objectDirs.join('\n')}\n`);

  // The stand-in origin starts as the real origin, as last fetched by each checkout.
  for (const v of present) {
    const real = path.join(v.dir, mod);
    log(`Fetching ${mod} ${v.name}...`);
    await git(real, ['fetch', '--quiet', '--tags', 'origin', `+refs/heads/${v.branch}:refs/remotes/origin/${v.branch}`]);
    await git(origin, ['fetch', '--quiet', real, `+refs/remotes/origin/${v.branch}:refs/heads/${v.branch}`, '+refs/tags/*:refs/tags/*']);
  }

  const used = new Set();
  const versions = config.versions.map(v => {
    let name = path.basename(v.dir);
    while (used.has(name)) name = `${name}-${v.index}`;
    used.add(name);
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(v.dir, '.upmerge-src-branch');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, '.upmerge-src-branch'));
    return { ...v, dir, realDir: v.dir };
  });

  const notes = [];
  for (const v of present) {
    const real = path.join(v.dir, mod);
    const copy = path.join(versions[v.index].dir, mod);
    // The local branch starts where the real one is, including unpushed commits.
    await git(root, ['clone', '--quiet', '--shared', '--branch', v.branch, real, copy]);
    await git(copy, ['remote', 'set-url', 'origin', origin]);
    await git(copy, ['config', 'remote.origin.pushurl', origin]);
    await git(copy, ['fetch', '--quiet', '--prune', '--tags', 'origin']);
    await copyLocalConfig(real, copy);
    await copyIgnoredFiles(real, copy);
    const problem = await initSubmodules(real, copy);
    if (problem) notes.push(problem);
    if (await gitOrNull(real, ['status', '--porcelain', '--untracked-files=no'])) {
      notes.push(`uncommitted changes in ${real} are not part of the rehearsal`);
    }
    // Nothing in the copy may point at a real remote.
    for (const remote of lines(await git(copy, ['remote', '-v']))) {
      if (!remote.includes(origin)) throw new Error(`rehearsal copy ${copy} has an unexpected remote: ${remote}`);
    }
  }
  return { root, origin, config: { ...config, versions }, before: await refsOf(origin), notes };
}

// What the rehearsal pushed: [{ branch, commits }] and [{ tag, changelog }].
async function rehearsalResults({ origin, before }) {
  const branches = [];
  const tags = [];
  for (const [ref, sha] of await refsOf(origin)) {
    if (before.get(ref) === sha) continue;
    if (ref.startsWith('refs/heads/')) {
      const range = before.has(ref) ? [`${before.get(ref)}..${sha}`] : ['-n', '20', sha];
      branches.push({ branch: ref.slice('refs/heads/'.length), commits: lines(await git(origin, ['log', '--format=%h %s', ...range])) });
    } else {
      const tag = ref.slice('refs/tags/'.length);
      tags.push({ tag, changelog: await gitOrNull(origin, ['show', `refs/tags/${tag}:resources/changelog/${tag}.txt`]) });
    }
  }
  return { branches, tags };
}

module.exports = { createRehearsal, rehearsalResults };
