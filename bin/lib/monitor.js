'use strict';
// Keeps the status of all mods up to date, for cc-dashboard: a mod is recomputed when its
// checkouts change on disk, GitHub is asked what changed every few minutes, and only those
// checkouts are fetched. All work goes through one queue, so git commands never overlap.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { loadConfig, configPath } = require('./config');
const { marksPath } = require('./marks');
const { modLockOwner } = require('./lock');
const { githubRepo } = require('./github');
const {
  discoverMods, checkVersionDirs, checkouts, computeStatus, planFetches, isUpmergeOnly, modWork, cellText, originUrl,
} = require('./status');

// Seconds.
const DEFAULTS = {
  localInterval: 60,
  remoteInterval: 120,
  // Even when GitHub says nothing changed, fetch everything now and then (e.g. for older tags).
  fetchAllInterval: 3600,
  // Without a GitHub token, fetching everything is the only way to see new commits.
  fetchAllWithoutGitHub: 600,
};

// Files in .git that change without affecting the status, or while git is still busy.
const IGNORED_GIT_FILES = /(\.lock$|^FETCH_HEAD$|^COMMIT_EDITMSG$|^logs|^objects|^gc\.|\.tmp$)/;

const DEBOUNCE_MS = 500;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

const slimCommit = c => ({
  hash: c.hash,
  subject: c.subject,
  ...(c.kind ? { kind: c.kind } : {}),
  ...(c.reason ? { reason: c.reason } : {}),
  // The scope of your mark: a branch, or '*' for all versions.
  ...(c.marked ? { marked: c.marked } : {}),
  fileCount: c.files ? c.files.length : 0,
});
const slimList = l => l && { userFacing: l.userFacing.map(slimCommit), dropped: l.dropped.map(slimCommit) };

function cellJson(cell, upmergeOnly) {
  if (cell.missing || cell.error) return cell;
  return {
    mc: cell.mc,
    modVersion: cell.modVersion,
    lastRelease: cell.lastRelease,
    unreleased: slimList(cell.unreleased),
    pending: slimList(cell.pending),
    local: cell.local,
    otherDifferingTags: cell.otherDifferingTags,
    text: cellText(cell, upmergeOnly),
  };
}

class Monitor extends EventEmitter {
  constructor({ log = () => {}, options = {} } = {}) {
    super();
    this.log = log;
    this.options = options;
    this.config = null;
    this.configError = null;
    this.found = { mods: [], byVersion: [], skipped: [] };
    this.status = {};
    this.github = new Map();
    this.watchers = new Map();
    this.fileWatchers = [];
    this.timers = [];
    this.debounce = new Map();
    this.pending = [];
    this.busy = null;
    this.info = { lastLocal: null, lastGitHubCheck: null, lastFetchAll: null, github: null, fetched: null };
  }

  opt(name) {
    const fromConfig = this.config && this.config.dashboard ? this.config.dashboard[name] : undefined;
    return this.options[name] ?? fromConfig ?? DEFAULTS[name];
  }

  async start() {
    this.reload();
    this.watchFiles();
    await this.request('local');
    this.request('remote');
    const every = (seconds, fn) => {
      const t = setInterval(fn, seconds * 1000);
      t.unref();
      this.timers.push(t);
    };
    every(this.opt('localInterval'), () => this.request('local'));
    every(this.opt('remoteInterval'), () => this.request('remote'));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.debounce.forEach(clearTimeout);
    for (const ws of this.watchers.values()) ws.forEach(w => w.close());
    this.fileWatchers.forEach(w => w.close());
    this.watchers.clear();
  }

  // (Re)reads the config and your marks, and finds the checkouts.
  reload() {
    try {
      this.config = loadConfig();
      this.configError = null;
    } catch (e) {
      // Keep going with the last good config, if any.
      this.configError = e.message;
    }
    this.found = this.config ? discoverMods(this.config) : { mods: [], byVersion: [], skipped: [] };
    for (const mod of Object.keys(this.status)) {
      if (!this.found.mods.includes(mod)) delete this.status[mod];
    }
    this.github.clear();
    this.syncWatchers();
    this.changed();
  }

  // Resolves when the work is done. Requests that arrive while busy are merged into one batch.
  request(kind, mods = null) {
    return new Promise(resolve => {
      this.pending.push({ kind, mods, resolve });
      if (!this.busy) this.work();
    });
  }

  async work() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      const kinds = new Set(batch.map(b => b.kind));
      const kind = kinds.has('full') ? 'full' : (kinds.has('remote') ? 'remote' : 'local');
      this.busy = kind;
      this.changed();
      try {
        const done = kind === 'local' ? new Set() : await this.remote(kind === 'full');
        const all = batch.some(b => b.kind !== 'local' || !b.mods);
        const wanted = all ? this.found.mods : [...new Set(batch.flatMap(b => b.mods))];
        await this.compute(wanted.filter(m => !done.has(m) && this.found.mods.includes(m)), false);
        if (all) this.info.lastLocal = new Date().toISOString();
      } catch (e) {
        this.log(`Refresh failed: ${e.stack || e.message}`);
      }
      this.busy = null;
      batch.forEach(b => b.resolve());
      this.changed();
    }
  }

  async compute(mods, fetch) {
    if (!this.config || !mods.length) return;
    const status = await computeStatus(this.config, { mods, byVersion: this.found.byVersion }, { fetch, jobs: this.config.jobs || 8 });
    Object.assign(this.status, status);
  }

  // Fetches what changed on origin and recomputes those mods; returns the mods it recomputed.
  async remote(fetchAll) {
    const now = () => new Date().toISOString();
    const age = t => (t ? (Date.now() - Date.parse(t)) / 1000 : Infinity);
    // A running release chain fetches by itself; fetching at the same time could make it fail.
    const canFetch = dir => !modLockOwner(path.basename(dir));
    const useGitHub = this.config && this.config.github !== false && this.info.github !== 'no token';
    const due = age(this.info.lastFetchAll) >= this.opt(useGitHub ? 'fetchAllInterval' : 'fetchAllWithoutGitHub');
    if (!fetchAll && !due && useGitHub) {
      const plan = await planFetches(this.config, this.found);
      this.info.lastGitHubCheck = now();
      this.info.github = plan ? (plan.error ? `error: ${plan.error}` : 'ok') : 'no token';
      if (plan && !plan.error) {
        const dirs = [...plan.toFetch].filter(canFetch);
        const mods = [...new Set(dirs.map(d => path.basename(d)))];
        await this.compute(mods, dir => plan.toFetch.has(dir) && canFetch(dir));
        this.info.fetched = { count: dirs.length, total: plan.total, at: now() };
        if (dirs.length) this.log(`Fetched ${dirs.length} of ${plan.total} checkouts (${mods.join(', ')})`);
        return new Set(mods);
      }
      if (plan) this.log(`Couldn't ask GitHub what changed: ${plan.error}`);
      if (!plan || !this.info.lastFetchAll) return this.remote(true);
      return new Set();
    }
    if (!fetchAll && !due) return new Set();
    await this.compute(this.found.mods, canFetch);
    const total = checkouts(this.config, this.found).length;
    this.info.lastFetchAll = now();
    this.info.fetched = { count: total, total, at: this.info.lastFetchAll };
    this.log(`Fetched all ${total} checkouts`);
    return new Set(this.found.mods);
  }

  syncWatchers() {
    const dirs = new Set(this.config ? checkouts(this.config, this.found).map(c => c.repoDir) : []);
    for (const [dir, ws] of this.watchers) {
      if (!dirs.has(dir)) {
        ws.forEach(w => w.close());
        this.watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (!this.watchers.has(dir)) this.watchers.set(dir, this.watchRepo(dir));
    }
  }

  // Watches refs, HEAD and the index. Edits in the working tree are caught by the periodic refresh.
  watchRepo(dir) {
    const gitDir = path.join(dir, '.git');
    const mod = path.basename(dir);
    const watchers = [];
    const onEvent = (event, file) => {
      if (file && IGNORED_GIT_FILES.test(String(file).split(path.sep).pop())) return;
      this.touched(mod);
    };
    const add = (p, options) => {
      try {
        const w = fs.watch(p, options, onEvent);
        w.on('error', () => {});
        watchers.push(w);
        return true;
      } catch (e) {
        return false;
      }
    };
    // Worktrees have a .git file; the periodic refresh covers those.
    if (!isDir(gitDir)) return watchers;
    add(gitDir, {});
    if (!add(path.join(gitDir, 'refs'), { recursive: true })) {
      for (const sub of ['heads', path.join('remotes', 'origin'), 'tags']) add(path.join(gitDir, 'refs', sub), {});
    }
    return watchers;
  }

  touched(mod) {
    clearTimeout(this.debounce.get(mod));
    this.debounce.set(mod, setTimeout(() => {
      this.debounce.delete(mod);
      this.request('local', [mod]);
    }, DEBOUNCE_MS));
  }

  // The config and the marks file: written by your editor or cc-mark, often by renaming a temp file.
  watchFiles() {
    let timer;
    const reloadSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.reload();
        this.request('local');
      }, 300);
    };
    for (const file of [configPath(), marksPath()]) {
      const dir = path.dirname(file);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, (event, name) => {
          if (!name || name === path.basename(file)) reloadSoon();
        });
        w.on('error', () => {});
        this.fileWatchers.push(w);
      } catch (e) {
        this.log(`Can't watch ${file}: ${e.message}`);
      }
    }
  }

  changed() {
    this.emit('change');
  }

  githubOf(mod) {
    if (!this.github.has(mod)) {
      const c = checkouts(this.config, { mods: [mod], byVersion: this.found.byVersion })[0];
      const r = c && githubRepo(originUrl(c.repoDir));
      this.github.set(mod, r ? `${r.owner}/${r.name}` : null);
    }
    return this.github.get(mod);
  }

  // Checkout dirs of a mod, lowest version first.
  modDirs(mod) {
    if (!this.config || !this.found.mods.includes(mod)) return [];
    return checkouts(this.config, { mods: [mod], byVersion: this.found.byVersion }).map(c => c.repoDir);
  }

  snapshot() {
    const config = this.config;
    const versions = config ? config.versions.map(v => ({ name: v.name, branch: v.branch })) : [];
    const mods = this.found.mods.map(name => {
      const cells = this.status[name];
      const base = { name, github: this.githubOf(name) };
      if (!cells) return { ...base, loading: true, start: -1, group: null, cells: versions.map(() => ({ loading: true })) };
      const upmergeOnly = isUpmergeOnly(cells);
      return { ...base, upmergeOnly, ...modWork(cells), cells: cells.map(c => cellJson(c, upmergeOnly)) };
    });
    return {
      configFile: config ? config.file : configPath(),
      versions,
      mods,
      skipped: this.found.skipped,
      warnings: (this.configError ? [this.configError] : []).concat(config ? checkVersionDirs(config) : []),
      refresh: { running: this.busy, ...this.info },
    };
  }
}

module.exports = { Monitor, DEFAULTS };
