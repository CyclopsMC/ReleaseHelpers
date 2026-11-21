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
const { readChains, chainsDir } = require('./progress');
const { stateDir } = require('./lock');
const { gitOrNull, runPool } = require('./git');
const { readPropsAt } = require('./props');
const { fetchPlatforms, summarize, publishState } = require('./insights');
const { parseProject, fetchProject, summarizeProjects } = require('./projects');
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
  // Downloads and releases on CurseForge and Modrinth.
  insightsInterval: 3600,
  // GitHub project boards.
  projectsInterval: 600,
};

// A release the platform data doesn't know yet is looked up at once, but at most once a minute
// per mod; a release that may still be uploading is looked up again every 10 minutes.
const NEW_RELEASE_RECHECK_MS = 60 * 1000;
const UPLOADING_RECHECK_MS = 10 * 60 * 1000;
const insightsFile = () => path.join(stateDir(), 'insights.json');

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
    // mod -> { heads: Map branch -> CI state, releases: Map tag -> CI state }, from the GitHub check.
    this.health = new Map();
    this.chains = {};
    // mod -> what CurseForge and Modrinth have, see insights.js.
    this.platforms = new Map();
    this.insightsRunning = false;
    // [{ spec, data | null, error | null }] of the project boards in the config.
    this.boards = [];
    this.projectsRunning = false;
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
    every(this.opt('localInterval'), () => {
      this.readChains();
      this.request('local');
    });
    every(this.opt('remoteInterval'), () => this.request('remote'));
    if (this.insightsEnabled()) {
      this.loadInsights();
      this.refreshInsights();
      every(this.opt('insightsInterval'), () => this.refreshInsights());
    }
    if (this.projectSpecs().length) {
      this.refreshProjects();
      every(this.opt('projectsInterval'), () => this.refreshProjects());
    }
  }

  // The boards under dashboard.projects, as URLs or "owner/number".
  projectSpecs() {
    const specs = this.opt('projects');
    return Array.isArray(specs) ? specs : [];
  }

  async refreshProjects() {
    const specs = this.projectSpecs();
    if (!specs.length || !this.config || this.config.github === false || this.projectsRunning) return;
    this.projectsRunning = true;
    this.changed();
    const boards = [];
    for (const spec of specs) {
      const project = parseProject(spec);
      if (!project) {
        boards.push({ spec, data: null, error: `Not a project board: ${spec}` });
        continue;
      }
      try {
        boards.push({ spec, data: await fetchProject(project), error: null });
      } catch (e) {
        boards.push({ spec, data: null, error: e.message });
      }
    }
    this.boards = boards;
    this.projectsRunning = false;
    this.changed();
  }

  projectsSnapshot() {
    if (!this.projectSpecs().length || !this.config || this.config.github === false) return null;
    const versions = this.config.versions;
    const mods = this.found.mods.map(name => ({
      name,
      repo: this.githubOf(name),
      unreleased: (this.status[name] || []).map((c, i) => ({
        version: versions[i] ? versions[i].name : String(i),
        commits: [...(c && c.unreleased ? c.unreleased.userFacing : []), ...(c && c.pending ? c.pending.userFacing : [])],
      })),
    }));
    return { running: this.projectsRunning, ...summarizeProjects(this.boards, mods) };
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
      this.recheckNewReleases();
    }
  }

  async compute(mods, fetch) {
    if (!this.config || !mods.length) return;
    const status = await computeStatus(this.config, { mods, byVersion: this.found.byVersion }, { fetch, jobs: this.config.jobs || 8 });
    Object.assign(this.status, status);
  }

  // Fetches what changed on origin and recomputes those mods; returns the mods it recomputed.
  // With GitHub, it also updates the CI states.
  async remote(fetchAll) {
    const now = () => new Date().toISOString();
    const age = t => (t ? (Date.now() - Date.parse(t)) / 1000 : Infinity);
    // A running release chain fetches by itself; fetching at the same time could make it fail.
    const canFetch = dir => !modLockOwner(path.basename(dir));
    let plan = null;
    if (this.config && this.config.github !== false && this.info.github !== 'no token') {
      plan = await planFetches(this.config, this.found, { health: true, releases: this.releaseTags() });
      this.info.lastGitHubCheck = now();
      this.info.github = plan ? (plan.error ? `error: ${plan.error}` : 'ok') : 'no token';
      if (plan && plan.error) this.log(`Couldn't ask GitHub what changed: ${plan.error}`);
      if (plan && !plan.error) {
        for (const [mod, refs] of plan.refsByMod) {
          this.health.set(mod, { heads: refs.headStates, releases: refs.releaseStates, openIssues: refs.openIssues, openPullRequests: refs.openPullRequests });
        }
      }
    }
    const planned = plan && !plan.error;
    const due = age(this.info.lastFetchAll) >= this.opt(planned ? 'fetchAllInterval' : 'fetchAllWithoutGitHub');
    if (!fetchAll && !due) {
      if (!planned) return new Set();
      const dirs = [...plan.toFetch].filter(canFetch);
      const mods = [...new Set(dirs.map(d => path.basename(d)))];
      await this.compute(mods, dir => plan.toFetch.has(dir) && canFetch(dir));
      this.info.fetched = { count: dirs.length, total: plan.total, at: now() };
      if (dirs.length) this.log(`Fetched ${dirs.length} of ${plan.total} checkouts (${mods.join(', ')})`);
      return new Set(mods);
    }
    await this.compute(this.found.mods, canFetch);
    const total = checkouts(this.config, this.found).length;
    this.info.lastFetchAll = now();
    this.info.fetched = { count: total, total, at: this.info.lastFetchAll };
    this.log(`Fetched all ${total} checkouts`);
    return new Set(this.found.mods);
  }

  // The last release tag of each mod per version, to ask GitHub for their CI state.
  releaseTags() {
    const tags = {};
    for (const [mod, cells] of Object.entries(this.status)) {
      tags[mod] = [...new Set(cells.map(c => c.lastRelease).filter(Boolean))];
    }
    return tags;
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
    // Running release chains write their progress here.
    try {
      fs.mkdirSync(chainsDir(), { recursive: true });
      let chainTimer;
      const w = fs.watch(chainsDir(), () => {
        clearTimeout(chainTimer);
        chainTimer = setTimeout(() => this.readChains(), 100);
      });
      w.on('error', () => {});
      this.fileWatchers.push(w);
    } catch (e) {
      this.log(`Can't watch ${chainsDir()}: ${e.message}`);
    }
    this.readChains();
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

  readChains() {
    this.chains = readChains();
    this.changed();
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

  insightsEnabled() {
    return !(this.config && this.config.dashboard && this.config.dashboard.insights === false);
  }

  loadInsights() {
    try {
      const saved = JSON.parse(fs.readFileSync(insightsFile(), 'utf8'));
      for (const [mod, data] of Object.entries(saved.mods || {})) this.platforms.set(mod, data);
    } catch (e) {
      // Fetched below.
    }
  }

  saveInsights() {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      const tmp = `${insightsFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ mods: Object.fromEntries(this.platforms) }));
      fs.renameSync(tmp, insightsFile());
    } catch (e) {
      this.log(`Can't save ${insightsFile()}: ${e.message}`);
    }
  }

  // The MC version of each maintained version, as its checkouts say.
  versionMcs() {
    return (this.config ? this.config.versions : []).map((v, i) => {
      const cell = Object.values(this.status).map(cells => cells[i]).find(c => c && c.mc);
      return { name: v.name, mc: cell ? cell.mc : null };
    });
  }

  // Fetches what CurseForge and Modrinth have of the mods (all of them, or `mods`). Only reads
  // from the checkouts, so it can run next to the queue.
  async refreshInsights(mods = null) {
    if (!this.config || !this.insightsEnabled() || this.insightsRunning) return;
    this.insightsRunning = true;
    this.changed();
    try {
      const mcs = this.versionMcs().map(v => v.mc).filter(Boolean);
      await runPool((mods || this.found.mods).map(mod => async () => {
        const list = checkouts(this.config, { mods: [mod], byVersion: this.found.byVersion });
        if (!list.length) return;
        let props = {};
        for (const c of list) {
          props = await readPropsAt(c.repoDir, `refs/remotes/origin/${c.version.branch}`);
          if (props.curseforge_project_id || props.modrinth_project_id) break;
        }
        const ids = { curseforge: props.curseforge_project_id, modrinth: props.modrinth_project_id };
        if (!ids.curseforge && !ids.modrinth) {
          this.platforms.delete(mod);
          return;
        }
        // The recent tags, and the last release of every version.
        const last = (this.status[mod] || []).map(c => c.lastRelease).filter(Boolean).map(t => `refs/tags/${t}`);
        // From every checkout: a chain pushes each tag from the checkout of its own version.
        const byTag = new Map();
        for (const c of list) {
          const out = await gitOrNull(c.repoDir, ['for-each-ref', '--format=%(refname:strip=2)%09%(creatordate:iso-strict)', 'refs/tags']) || '';
          for (const l of out.split('\n').filter(Boolean)) {
            const [tag, date] = l.split('\t');
            if (!byTag.has(tag)) byTag.set(tag, { tag, date });
          }
        }
        const all = [...byTag.values()].filter(t => mcs.some(mc => t.tag.startsWith(`${mc}-`)))
          .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        const tags = all.filter((t, i) => i < 10 || last.includes(`refs/tags/${t.tag}`));
        this.platforms.set(mod, await fetchPlatforms(ids, mcs, tags));
      }), 4);
      this.saveInsights();
    } catch (e) {
      this.log(`Insights failed: ${e.stack || e.message}`);
    }
    this.insightsRunning = false;
    this.changed();
  }

  // Looks up new releases, and again those that may still be uploading.
  recheckNewReleases(now = Date.now()) {
    if (!this.insightsEnabled() || this.insightsRunning) return;
    const due = [];
    for (const [mod, data] of this.platforms) {
      const age = now - Date.parse(data.fetchedAt);
      const known = new Set(data.tags.map(t => t.tag));
      const unseen = (this.status[mod] || []).some(c => c.lastRelease && !known.has(c.lastRelease));
      const uploading = data.tags.some(t => publishState(t, t.date, now) === 'pending');
      if ((unseen && age >= NEW_RELEASE_RECHECK_MS) || (uploading && age >= UPLOADING_RECHECK_MS)) due.push(mod);
    }
    if (due.length) this.refreshInsights(due);
  }

  insightsSnapshot() {
    if (!this.insightsEnabled()) return null;
    const mods = this.found.mods.map(name => {
      const health = this.health.get(name);
      return {
        name,
        platforms: this.platforms.get(name) || null,
        github: health && health.openIssues !== null && health.openIssues !== undefined
          ? { issues: health.openIssues, prs: health.openPullRequests || 0 } : null,
        lastReleases: (this.status[name] || []).map(c => c.lastRelease).filter(Boolean),
      };
    });
    return { running: this.insightsRunning, ...summarize(mods, this.versionMcs()) };
  }

  snapshot() {
    const config = this.config;
    const versions = config ? config.versions.map(v => ({ name: v.name, branch: v.branch })) : [];
    let mods = this.found.mods.map(name => {
      const cells = this.status[name];
      const base = { name, github: this.githubOf(name), chains: this.chains[name] || [] };
      if (!cells) return { ...base, loading: true, start: -1, group: null, deps: [], cells: versions.map(() => ({ loading: true })) };
      const upmergeOnly = isUpmergeOnly(cells);
      const health = this.health.get(name);
      return {
        ...base,
        upmergeOnly,
        ...modWork(cells),
        deps: this.depsOf(name, cells),
        cells: cells.map((c, i) => {
          const json = cellJson(c, upmergeOnly);
          if (health && !c.missing && !c.error) {
            json.ci = health.heads ? health.heads.get(versions[i].branch) || null : null;
            json.releaseCi = health.releases && c.lastRelease ? health.releases.get(c.lastRelease) || null : null;
          }
          return json;
        }),
      };
    });
    mods = orderByDependencies(mods);
    const byName = new Map(mods.map(m => [m.name, m]));
    for (const m of mods) {
      // Dependencies to release first: with changes to release, or a release chain running.
      m.blockedBy = m.deps.filter(d => byName.get(d).group === 'todo' || byName.get(d).chains.some(ch => !ch.rehearsal));
    }
    const dashboard = (config && config.dashboard) || {};
    return {
      configFile: config ? config.file : configPath(),
      versions,
      mods,
      skipped: this.found.skipped,
      warnings: (this.configError ? [this.configError] : []).concat(config ? checkVersionDirs(config) : []),
      refresh: { running: this.busy, ...this.info },
      features: { terminal: !!dashboard.terminal || process.platform === 'darwin', ide: Array.isArray(dashboard.ide) },
      insights: this.insightsSnapshot(),
      projects: this.projectsSnapshot(),
    };
  }

  // Other mods this one depends on (by <mod>_version properties), by name.
  depsOf(name, cells) {
    const keys = new Set(cells.flatMap(c => c.depKeys || []));
    return this.found.mods.filter(m => m !== name && keys.has(m.toLowerCase()));
  }
}

// Dependencies first; mods at the same depth by name.
function orderByDependencies(mods) {
  const byName = new Map(mods.map(m => [m.name, m]));
  const depth = new Map();
  const visit = (name, seen) => {
    if (depth.has(name)) return depth.get(name);
    if (seen.has(name)) return 0;
    seen.add(name);
    const deps = byName.get(name).deps.filter(d => byName.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(x => visit(x, seen))) : 0;
    depth.set(name, d);
    return d;
  };
  mods.forEach(m => visit(m.name, new Set()));
  return mods.slice().sort((a, b) => depth.get(a.name) - depth.get(b.name) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

module.exports = { Monitor, DEFAULTS };
