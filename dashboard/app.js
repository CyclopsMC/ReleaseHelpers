'use strict';
// The cc-dashboard page: renders the state the server pushes, and shows commit details on demand.
// Commit messages are text from contributors, so they are only ever set as text, never as HTML.

const TOKEN = document.querySelector('meta[name="cc-token"]').content;
const $ = sel => document.querySelector(sel);

let state = null;
let connected = false;
let selected = null; // { mod, version } (names)
const expanded = new Set(); // "mod/hash"
const details = new Map(); // "mod/hash" -> details | { error }
const diffs = new Map(); // "mod/hash" -> text | null while loading
const busy = new Set(); // actions in flight, e.g. "mark/<hash>"
const openSections = new Set(); // collapsible sections you opened, kept across updates

function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) {
    // Private windows may not have storage.
  }
  return null;
}

// Tiny DOM builder: h('a.cls', { href }, 'text', child).
function h(spec, attrs, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += ` ${v}`;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// An SVG element, for small icons.
function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  el.append(...children.filter(c => c !== null && c !== undefined));
  return el;
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-Token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

// Runs a button's action, keeping the button disabled until it is done.
async function act(key, url, body) {
  busy.add(key);
  render();
  try {
    return await post(url, body);
  } catch (e) {
    alert(e.message);
    return null;
  } finally {
    busy.delete(key);
    render();
  }
}

function ago(iso) {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const hours = Math.round(s / 3600);
  return `${hours} h ago`;
}

const userFacing = cell => (cell && cell.pending ? (cell.unreleased ? cell.unreleased.userFacing : []).concat(cell.pending.userFacing) : []);

function tone(mod, cell) {
  if (cell.error) return 'error';
  const commits = userFacing(cell);
  if (!commits.length) return cell.lastRelease || mod.upmergeOnly ? 'clean' : 'new';
  if (mod.upmergeOnly) return 'upmerge';
  if (commits.every(c => c.kind === 'translations')) return 'translations';
  return 'release';
}

const CI = {
  SUCCESS: ['ok', 'passed'],
  FAILURE: ['bad', 'failed'],
  ERROR: ['bad', 'failed'],
  PENDING: ['run', 'running'],
  EXPECTED: ['run', 'waiting'],
};
const ciFailed = state => state === 'FAILURE' || state === 'ERROR';

function cellTitle(mod, cell, version) {
  if (cell.error) return cell.error;
  const parts = [];
  if (cell.unreleased && cell.unreleased.userFacing.length) parts.push(`${cell.unreleased.userFacing.length} unreleased`);
  if (cell.pending.userFacing.length) parts.push(`${cell.pending.userFacing.length} to upmerge`);
  if (!parts.length) parts.push('nothing to release');
  parts.push(cell.lastRelease ? `last release ${cell.lastRelease}` : (mod.upmergeOnly ? 'upmerge only' : `no ${cell.mc} release yet`));
  if (cell.local.length) parts.push(cell.local.join(', '));
  if (ciFailed(cell.ci)) parts.push(`CI failed on ${version.branch}`);
  if (ciFailed(cell.releaseCi)) parts.push(`CI failed for ${cell.lastRelease}`);
  return `${mod.name} ${version.name}: ${parts.join(' · ')}`;
}

// Most urgent first: translations alone can wait.
const GROUPS = [
  { key: 'todo', tone: 'release', title: 'To release', chip: n => `${n} to release` },
  { key: 'upmerge', tone: 'upmerge', title: 'Upmerge only', chip: n => `${n} upmerge only` },
  { key: 'translations', tone: 'translations', title: 'Only translations', chip: n => `${n} only translations` },
];

function select(mod, version) {
  selected = mod ? { mod, version } : null;
  const hash = selected ? `#${encodeURIComponent(mod)}/${encodeURIComponent(version)}` : ' ';
  history.replaceState(null, '', hash === ' ' ? location.pathname : hash);
  render();
}

function readHash() {
  const m = /^#([^/]+)\/(.+)$/.exec(location.hash);
  selected = m ? { mod: decodeURIComponent(m[1]), version: decodeURIComponent(m[2]) } : null;
}

function render() {
  renderBar();
  renderBanner();
  if (!state) return;
  renderStrip();
  renderGrid();
  renderGroups();
  renderProblems();
  renderInsights();
  renderPanel();
}

function renderBar() {
  const summary = $('#summary');
  const sync = $('#sync');
  summary.replaceChildren();
  sync.replaceChildren();
  if (!state) {
    sync.append(h('span.spinner'), 'Connecting…');
    setFavicon('loading');
    return;
  }
  const counts = {};
  for (const m of state.mods) if (m.group) counts[m.group] = (counts[m.group] || 0) + 1;
  for (const g of GROUPS) if (counts[g.key]) summary.append(h(`span.chip.${g.tone}`, null, g.chip(counts[g.key])));
  const loading = state.mods.some(m => m.loading);
  if (!loading && !Object.keys(counts).length && state.mods.length) summary.append(h('span.chip.ok', null, 'Nothing to release'));
  const errors = state.mods.reduce((n, m) => n + m.cells.filter(c => c.error).length, 0);
  if (errors) summary.append(h('span.chip.danger', null, `${errors} error${errors === 1 ? '' : 's'}`));
  const failing = state.mods.reduce((n, m) => n + m.cells.filter(c => ciFailed(c.ci) || ciFailed(c.releaseCi)).length, 0);
  if (failing) summary.append(h('span.chip.danger', null, `${failing} CI failure${failing === 1 ? '' : 's'}`));
  const running = state.mods.flatMap(m => m.chains);
  if (running.length) {
    const waiting = running.filter(ch => ch.waiting).length;
    summary.append(h(waiting ? 'span.chip.waiting' : 'span.chip.running', null,
      `${running.length} chain${running.length === 1 ? '' : 's'} running${waiting ? `, ${waiting} waiting for you` : ''}`));
  }
  const bell = $('#notify');
  bell.classList.toggle('on', notifyOn());
  bell.title = notifyOn() ? 'Notifications are on: new work, CI failures and chains that wait for you. Click to turn off.' : 'Turn on notifications';
  // Only translations can wait, so they don't count as work here.
  const work = (counts.todo || 0) + (counts.upmerge || 0);
  document.title = work ? `(${work}) CC status` : 'CC status';
  setFavicon(loading ? 'loading' : (errors || failing ? 'problem' : (work ? 'work' : 'ok')));

  const r = state.refresh;
  $('#progress').classList.toggle('on', !!r.running);
  $('#refresh').disabled = r.running === 'full';
  if (r.running) {
    const label = { local: 'Checking checkouts…', remote: 'Checking GitHub…', full: 'Fetching every checkout…' }[r.running];
    sync.append(h('span.spinner'), label);
    return;
  }
  const parts = [];
  if (r.github && r.github.startsWith('error')) parts.push(h('span.warn', { title: r.github }, 'GitHub check failed'));
  else if (r.github === 'no token') parts.push(h('span', { title: 'Without a GitHub token, every checkout is fetched every 10 minutes. Run gh auth login, or set GH_TOKEN.' }, 'No GitHub token'));
  if (r.lastGitHubCheck) parts.push(`GitHub checked ${ago(r.lastGitHubCheck)}`);
  if (r.lastFetchAll) parts.push(`all fetched ${ago(r.lastFetchAll)}`);
  if (r.fetched && r.fetched.count && r.fetched.count < r.fetched.total) parts.push(`last fetch: ${r.fetched.count} of ${r.fetched.total}`);
  parts.forEach((p, i) => sync.append(i ? ' · ' : '', p));
}

function renderBanner() {
  const banner = $('#banner');
  banner.replaceChildren();
  if (state && !connected) {
    banner.append(h('div.banner', null, 'Lost the connection to cc-dashboard. Is it still running? Reconnecting…'));
  }
  if (state) for (const w of state.warnings) banner.append(h('div.banner', null, w));
  if (state && !state.mods.length && !state.warnings.length) {
    banner.append(h('div.banner.info', null, `No mod checkouts found in the version dirs of ${state.configFile}.`));
  }
}

function renderGrid() {
  const table = $('#grid');
  const head = h('tr', null, h('th', null), state.versions.map(v => h('th', { title: v.branch }, v.name)));
  const rows = state.mods.map(mod => {
    const header = h('th', null,
      h('div.mod-name', null,
        modIcon(mod.name),
        h('span', null, mod.name),
        mod.github ? h('a.mod-link', { href: `https://github.com/${mod.github}`, target: '_blank', rel: 'noopener', title: 'Open on GitHub' }, '↗') : null,
        mod.chains.map(chainPill)),
      mod.group && mod.blockedBy && mod.blockedBy.length ? h('div.waits', { title: 'Release these first: this mod depends on them' }, `waits for ${mod.blockedBy.join(', ')}`) : null);
    const cells = mod.cells.map((cell, i) => {
      const version = state.versions[i];
      if (cell.loading) return h('td', null, h('span.cell.loading', null, '…'));
      if (cell.missing) return h('td', null, h('span.cell.missing', { title: `No ${version.name} checkout` }, '-'));
      const isSelected = selected && selected.mod === mod.name && selected.version === version.name;
      const cls = ['cell', tone(mod, cell)];
      if (cell.local && cell.local.length) cls.push('attention');
      if (mod.start === i) cls.push('start');
      if (ciFailed(cell.ci) || ciFailed(cell.releaseCi)) cls.push('ci-failed');
      if (isSelected) cls.push('selected');
      return h('td', null, h('button', {
        class: cls.join(' '),
        title: cellTitle(mod, cell, version),
        'aria-pressed': isSelected ? 'true' : 'false',
        onclick: () => select(mod.name, version.name),
      }, cell.error ? '?' : cell.text));
    });
    return h(mod.group ? 'tr' : 'tr.quiet', null, header, cells);
  });
  table.replaceChildren(h('thead', null, head), h('tbody', null, rows));
}

function renderGroups() {
  const box = $('#groups');
  box.replaceChildren();
  if (state.mods.some(m => m.loading)) return;
  let any = false;
  // What to release is in the strip at the top.
  for (const g of GROUPS.filter(x => x.key !== 'todo')) {
    const byVersion = state.versions.map(() => []);
    for (const m of state.mods) if (m.group === g.key) byVersion[m.start].push(m);
    if (!byVersion.some(l => l.length)) continue;
    any = true;
    box.append(h(`div.card.${g.tone}`, null,
      h('h3', null, h('span.dot'), g.title, h('span.hint', null, 'by lowest version')),
      byVersion.map((mods, i) => (mods.length ? h('div.group-row', null,
        h('span.ver', null, state.versions[i].name),
        h('div.mods', null, mods.map(m => h(m.blockedBy && m.blockedBy.length ? 'button.mod-chip.blocked' : 'button.mod-chip', {
          onclick: () => select(m.name, state.versions[i].name),
          title: m.blockedBy && m.blockedBy.length ? `Waits for ${m.blockedBy.join(', ')}` : null,
        }, modIcon(m.name, true), m.name, m.chains.length ? ' ▸' : '')))) : null))));
  }
  if (!any) box.replaceChildren();
}

function renderProblems() {
  const box = $('#problems');
  box.replaceChildren();
  const errors = [];
  for (const m of state.mods) {
    m.cells.forEach((c, i) => { if (c.error) errors.push(`${m.name} ${state.versions[i].name}: ${c.error}`); });
  }
  if (errors.length) {
    box.append(h('div.problems', null, h('h3', null, 'Errors'), h('ul', null, errors.map(e => h('li.err', null, e)))));
  }
  if (state.skipped.length) {
    box.append(h('div.problems', null, h('ul', null, state.skipped.map(s => h('li.skip', null,
      `Skipped ${s.version}/${s.name}: ${s.origin ? `it is a checkout of ${s.origin}` : 'it has no origin remote'}.`)))));
  }
}

function commitKey(mod, c) {
  return `${mod.name}/${c.hash}`;
}

async function loadDetails(mod, c) {
  const key = commitKey(mod, c);
  try {
    const r = await fetch(`/api/commit?mod=${encodeURIComponent(mod.name)}&hash=${c.hash}`);
    details.set(key, r.ok ? await r.json() : { error: (await r.json()).error });
  } catch (e) {
    details.set(key, { error: e.message });
  }
  renderPanel();
}

async function loadDiff(mod, c) {
  const key = commitKey(mod, c);
  diffs.set(key, null);
  renderPanel();
  try {
    const r = await fetch(`/api/diff?mod=${encodeURIComponent(mod.name)}&hash=${c.hash}`);
    diffs.set(key, await r.text());
  } catch (e) {
    diffs.set(key, `Could not load the diff: ${e.message}`);
  }
  renderPanel();
}

function renderDiff(text) {
  return h('pre.diff', null, text.split('\n').map(line => {
    let cls = null;
    if (line.startsWith('diff --git')) cls = 'file';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    return h(cls ? `span.${cls}` : 'span', null, line || ' ');
  }));
}

const versionOf = branch => (state.versions.find(v => v.branch === branch) || { name: branch }).name;
const scopeText = scope => (scope === '*' ? 'all versions' : versionOf(scope));

// Marking a commit asks for which versions; this is the commit that is asking, if any.
let choosing = null; // { key, release }

// The mark button of a commit, for the selected version: what clicking it would do.
function markButton(mod, c, dropped, version) {
  const key = `mark/${mod.name}/${c.hash}/${version.branch}`;
  if (busy.has(key)) return h('span.mark-choice', null, h('span.spinner'));
  if (c.marked) {
    return h('button.btn.small.mark.marked', {
      title: `Removes your mark for ${scopeText(c.marked)}`,
      onclick: () => act(key, '/api/mark', { mod: mod.name, hash: c.hash, release: null, scope: c.marked }),
    }, 'Unmark');
  }
  const release = !!dropped;
  const open = choosing && choosing.key === key;
  return h(open ? 'button.btn.small.mark.marked' : 'button.btn.small.mark', {
    title: release ? 'The filter left this out. Mark it as needing a release anyway.' : 'Mark this as needing no release',
    'aria-expanded': open ? 'true' : 'false',
    onclick: () => {
      choosing = open ? null : { key };
      renderPanel();
    },
  }, release ? 'Needs release' : 'No release');
}

// Below the commit, after clicking its mark button: for which versions.
function markChoice(mod, c, dropped, version) {
  const key = `mark/${mod.name}/${c.hash}/${version.branch}`;
  if (!choosing || choosing.key !== key) return null;
  const release = !!dropped;
  const mark = scope => () => {
    choosing = null;
    act(key, '/api/mark', { mod: mod.name, hash: c.hash, release, scope });
  };
  return h('div.mark-choice', null,
    h('span.hint', null, release ? 'Needs a release on' : 'Needs no release on'),
    h('button.btn.small', { onclick: mark(version.branch), title: `Only for ${version.name}` }, version.name),
    h('button.btn.small', { onclick: mark('*'), title: 'For every MC version, e.g. a build change that touched a source file' }, 'all versions'),
    h('button.btn.small.ghost', { onclick: () => { choosing = null; renderPanel(); } }, 'Cancel'));
}

function commitRow(mod, c, dropped, version) {
  const key = commitKey(mod, c);
  const open = expanded.has(key);
  const badges = [];
  if (c.kind === 'translations') badges.push(h('span.badge.translations', null, 'translations'));
  if (c.kind === 'compat') badges.push(h('span.badge.compat', null, 'compat'));
  if (c.marked) badges.push(h('span.badge.marked', null, `${dropped ? 'no release' : 'release'} on ${scopeText(c.marked)}`));
  else if (dropped) badges.push(h('span.badge', null, c.reason));
  const head = h('button.commit-head', {
    'aria-expanded': open ? 'true' : 'false',
    onclick: () => {
      if (open) expanded.delete(key);
      else {
        expanded.add(key);
        if (!details.has(key)) loadDetails(mod, c);
      }
      renderPanel();
    },
  }, h('code.hash', null, c.hash.slice(0, 9)), h('span.subject', null, c.subject), badges);
  const line = h('div.commit-line', null, head, markButton(mod, c, dropped, version));
  const choice = markChoice(mod, c, dropped, version);
  const cls = dropped ? 'li.commit.dropped' : 'li.commit';
  if (!open) return h(cls, null, line, choice);

  const d = details.get(key);
  let body;
  if (!d) body = h('div.commit-body', null, h('span.spinner'));
  else if (d.error) body = h('div.commit-body', null, h('span.warn', null, d.error));
  else {
    const diff = diffs.get(key);
    body = h('div.commit-body', null,
      h('div.who', null, `${d.author} · ${new Date(d.date).toLocaleString()}`),
      d.body ? h('p.msg', null, d.body) : null,
      h('ul.files', null, d.files.map(f => h('li', null, h('span.st', null, f.status), h('span.path', null, f.path)))),
      h('div.actions', null,
        diffs.has(key) ? null : h('button.btn.small', { onclick: () => loadDiff(mod, c) }, 'Show diff'),
        mod.github ? h('a.btn.small', { href: `https://github.com/${mod.github}/commit/${d.hash}`, target: '_blank', rel: 'noopener' }, 'Open on GitHub') : null),
      diffs.has(key) ? (diff === null ? h('div', { style: 'margin-top: 10px' }, h('span.spinner')) : renderDiff(diff)) : null);
  }
  return h(cls, null, line, choice, body);
}

function chainPill(chain) {
  const where = chain.version ? `${chain.version}: ` : '';
  const text = chain.waiting ? `${where}waiting for you` : `${where}${chain.step}`;
  return h(chain.waiting ? 'span.pill.waiting' : 'span.pill.running', {
    title: `${chain.rehearsal ? 'Rehearsal' : 'Release chain'} (pid ${chain.pid}) since ${new Date(chain.startedAt).toLocaleTimeString()}`
      + `${chain.waiting ? `\nWaiting for: ${chain.waiting}` : ''}`,
  }, h('span.pulse'), chain.rehearsal ? `rehearsal · ${text}` : text);
}

function ciLine(label, state, href) {
  if (!state) return null;
  const [cls, text] = CI[state] || ['run', state.toLowerCase()];
  return h('span.ci', null, `${label} `, href ? h('a', { href, target: '_blank', rel: 'noopener', class: `ci-${cls}` }, text) : h(`span.ci-${cls}`, null, text));
}

function modActions(mod) {
  const running = mod.chains.filter(ch => !ch.rehearsal);
  const startName = mod.start >= 0 ? state.versions[mod.start].name : null;
  const confirm = stored('cc-confirm') === '1';
  const canStart = state.features.terminal && startName && !running.length;
  const why = !state.features.terminal ? 'Set "dashboard": { "terminal" } in the config to start chains from here.'
    : (running.length ? 'A release chain for this mod is running.' : (!startName ? 'Nothing to release.' : null));
  return h('div.mod-actions', null,
    h('div.buttons', null,
      h('button.btn.primary', {
        disabled: !canStart || busy.has(`chain/${mod.name}`),
        title: why || `Opens a terminal with cc-release-chain ${mod.name}`,
        onclick: () => act(`chain/${mod.name}`, '/api/chain', { mod: mod.name, confirm: stored('cc-confirm') === '1' }),
      }, mod.upmergeOnly ? 'Start upmerge chain' : 'Start release chain'),
      h('button.btn', {
        disabled: !state.features.terminal || !startName || busy.has(`rehearse/${mod.name}`),
        title: why && why !== 'A release chain for this mod is running.' ? why : `Opens a terminal with cc-release-chain --rehearse ${mod.name}: nothing gets pushed`,
        onclick: () => act(`rehearse/${mod.name}`, '/api/chain', { mod: mod.name, rehearse: true, confirm: stored('cc-confirm') === '1' }),
      }, 'Rehearse'),
      h('label.check', { title: 'Adds --confirm: the chain asks before pushing each release' },
        h('input', {
          type: 'checkbox',
          checked: confirm,
          onchange: e => stored('cc-confirm', e.target.checked ? '1' : '0'),
        }), 'Ask before each push')),
    startName ? h('div.hint', null, `Starts at ${startName}${mod.blockedBy.length ? `. Release ${mod.blockedBy.join(' and ')} first: ${mod.name} depends on ${mod.blockedBy.length === 1 ? 'it' : 'them'}.` : '.'}`) : null,
    mod.chains.map(ch => h(ch.waiting ? 'div.chain-box.waiting' : 'div.chain-box', null,
      h('b', null, ch.rehearsal ? 'Rehearsal running' : 'Release chain running'),
      ` on ${ch.versions.join(', ')}. Now: ${ch.version ? `${ch.version}, ` : ''}${ch.step}.`,
      ch.waiting ? h('div', null, 'Waiting for you: ', h('b', null, ch.waiting)) : null)));
}

function section(mod, version, title, hint, commits, { dropped = false, collapsible = false, key = title } = {}) {
  const list = commits.length
    ? h('ul.commits', null, commits.map(c => commitRow(mod, c, dropped, version)))
    : h('div.empty', null, 'None');
  if (collapsible) {
    const det = h('details.section', null, h('summary', null, `${title} · ${commits.length}`, h('span.hint', null, hint)), list);
    // Open when you opened it, or when it holds a commit you expanded (e.g. one you just marked).
    det.open = openSections.has(key) || commits.some(c => expanded.has(commitKey(mod, c)));
    det.addEventListener('toggle', () => {
      if (det.open) openSections.add(key);
      else {
        openSections.delete(key);
        commits.forEach(c => expanded.delete(commitKey(mod, c)));
      }
    });
    return det;
  }
  return h('div.section', null, h('h3', null, `${title} · ${commits.length}`, h('span.hint', null, hint)), list);
}

function renderPanel() {
  const panel = $('#panel');
  const mod = selected && state && state.mods.find(m => m.name === selected.mod);
  const vi = mod ? state.versions.findIndex(v => v.name === selected.version) : -1;
  if (!mod || vi < 0 || mod.cells[vi].missing || mod.cells[vi].loading) {
    panel.hidden = true;
    return;
  }
  const scroll = panel.scrollTop;
  const cell = mod.cells[vi];
  const version = state.versions[vi];
  const content = [h('div.panel-head', null,
    h('div', null, h('h2', null, mod.name), h('div.platforms', null,
      mod.github ? h('a', { href: `https://github.com/${mod.github}`, target: '_blank', rel: 'noopener' }, 'GitHub') : null,
      platformLinks(mod.name))),
    h('button.btn.small.close', { onclick: () => select(null), title: 'Close (Esc)' }, 'Close'))];
  content.push(modActions(mod));
  if (mod.deps.length) {
    content.push(h('div.meta', null, 'Depends on ', mod.deps.map((d, i) => [i ? ', ' : '',
      h(mod.blockedBy.includes(d) ? 'b.blocked' : 'span', { title: mod.blockedBy.includes(d) ? 'Has changes to release, or a running chain' : null }, d)])));
  }
  content.push(h('h3.cell-title', null, `${version.name}`, h('span.hint', null, version.branch),
    h('span.cell-buttons', null,
      state.features.terminal ? h('button.btn.small', { onclick: () => act(`terminal/${mod.name}`, '/api/terminal', { mod: mod.name, version: version.name }) }, 'Terminal') : null,
      state.features.ide ? h('button.btn.small', { onclick: () => act(`ide/${mod.name}`, '/api/ide', { mod: mod.name, version: version.name }) }, 'IDE') : null)));

  if (cell.error) {
    content.push(h('div.alert', null, cell.error));
  } else {
    const tagLink = tag => (mod.github ? h('a', { href: `https://github.com/${mod.github}/releases/tag/${encodeURIComponent(tag)}`, target: '_blank', rel: 'noopener' }, tag) : h('code', null, tag));
    const actionsUrl = mod.github ? `https://github.com/${mod.github}/actions?query=${encodeURIComponent(`branch:${version.branch}`)}` : null;
    content.push(h('div.meta', null, cell.lastRelease
      ? ['Last release ', tagLink(cell.lastRelease)]
      : (mod.upmergeOnly ? 'This mod has no releases: it is only upmerged.' : `No ${cell.mc} release yet.`)));
    const ci = [ciLine(`CI on ${version.branch}:`, cell.ci, actionsUrl),
      cell.lastRelease ? ciLine(`${cell.lastRelease}:`, cell.releaseCi, mod.github ? `https://github.com/${mod.github}/releases/tag/${encodeURIComponent(cell.lastRelease)}` : null) : null].filter(Boolean);
    if (ci.length) content.push(h('div.meta.ci-row', null, ci));
    if (cell.local.length) content.push(h('div.alert', null, 'This checkout needs attention:', h('ul', null, cell.local.map(l => h('li', null, l)))));
    if (cell.unreleased) content.push(section(mod, version, 'Unreleased', `since ${cell.lastRelease}`, cell.unreleased.userFacing));
    const lower = state.versions.slice(0, vi).map(v => v.name).join(', ');
    if (vi > 0) content.push(section(mod, version, 'To upmerge', lower ? `from ${lower}` : '', cell.pending.userFacing));
    const dropped = (cell.unreleased ? cell.unreleased.dropped : []).concat(cell.pending.dropped);
    content.push(section(mod, version, 'Left out by the filter', 'no release needed', dropped,
      { dropped: true, collapsible: true, key: `${mod.name}/${version.name}/dropped` }));
    if (cell.otherDifferingTags.length) {
      content.push(h('div.note', null, `Older tags that differ from origin, which doesn't affect this status: ${cell.otherDifferingTags.join(', ')}.`));
    }
  }
  const onBoards = state.projects && state.projects.perMod[mod.name];
  if (onBoards && onBoards.length) {
    content.push(h('div.section', null, h('h3', null, `On the project boards · ${onBoards.length}`, h('span.hint', null, 'all versions')),
      h('ul.board-items', null, onBoards.map(i => boardItem({ ...i, mod: i.project }, { status: true })))));
  }
  panel.replaceChildren(...content);
  panel.hidden = false;
  panel.scrollTop = scroll;
}

// Notifications for new work, CI failures, and chains that start waiting for you.
const notifyOn = () => stored('cc-notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';

function notify(title, body, mod, version) {
  if (!notifyOn()) return;
  const n = new Notification(title, { body, tag: `${title}/${body}` });
  n.onclick = () => {
    window.focus();
    if (mod) select(mod, version);
  };
}

function compareStates(prev, next) {
  if (!prev || prev.mods.some(m => m.loading)) return;
  const before = new Map(prev.mods.map(m => [m.name, m]));
  const names = { todo: 'needs a release', translations: 'has new translations', upmerge: 'needs an upmerge' };
  for (const m of next.mods) {
    const p = before.get(m.name);
    if (!p || p.loading || m.loading) continue;
    const startName = m.start >= 0 ? next.versions[m.start].name : null;
    if (m.group && !p.group) notify(`${m.name} ${names[m.group]}`, `Starting at ${startName}`, m.name, startName);
    m.cells.forEach((c, i) => {
      const was = p.cells[i] || {};
      const v = next.versions[i];
      if (ciFailed(c.ci) && !ciFailed(was.ci)) notify(`CI failed: ${m.name} ${v.name}`, `On ${v.branch}`, m.name, v.name);
      if (ciFailed(c.releaseCi) && !ciFailed(was.releaseCi)) notify(`CI failed: ${m.name} ${c.lastRelease}`, 'The release may not be published', m.name, v.name);
    });
    for (const ch of m.chains) {
      const old = p.chains.find(x => x.pid === ch.pid);
      if (ch.waiting && (!old || !old.waiting)) notify(`${m.name}: the ${ch.rehearsal ? 'rehearsal' : 'release chain'} waits for you`, ch.waiting, m.name, ch.version);
    }
  }
}

$('#notify').addEventListener('click', async () => {
  if (notifyOn()) {
    stored('cc-notify', '0');
  } else if (typeof Notification === 'undefined') {
    alert('This browser has no notifications.');
  } else if ((await Notification.requestPermission()) === 'granted') {
    stored('cc-notify', '1');
  }
  renderBar();
});

// The tab icon: green when there is nothing to release (translations aside), orange when there
// is, red on errors or failing CI. Each has its own mark, so color isn't the only cue.
const CHECK = "<path d='M10 16.5l4 4 8-9' stroke='white' stroke-width='3.2' fill='none' stroke-linecap='round' stroke-linejoin='round'/>";
const FAVICONS = {
  ok: ['#2da44e', CHECK],
  work: ['#d4881c', "<path d='M16 23V10M10.5 15.5L16 10l5.5 5.5' stroke='white' stroke-width='3.2' fill='none' stroke-linecap='round' stroke-linejoin='round'/>"],
  problem: ['#cf222e', "<path d='M16 9v8.5' stroke='white' stroke-width='3.4' stroke-linecap='round'/><circle cx='16' cy='22.6' r='2' fill='white'/>"],
  loading: ['#8c8c93', CHECK],
};
let favicon = null;
function setFavicon(kind) {
  if (kind === favicon) return;
  favicon = kind;
  const [fill, mark] = FAVICONS[kind];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='3' y='3' width='26' height='26' rx='7' fill='${fill}'/>${mark}</svg>`;
  $('link[rel="icon"]').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// --- Mod icons ---

// The cached icon of a mod, or its initials.
function modIcon(name, small = false) {
  const cls = small ? 'mod-icon small' : 'mod-icon';
  if (state && state.icons && state.icons.includes(name)) {
    return h('img', { class: cls, src: `/icons/${encodeURIComponent(name)}`, alt: '', loading: 'lazy' });
  }
  return h('span', { class: cls, 'aria-hidden': 'true' }, name.replace(/[^A-Z]/g, '').slice(0, 2) || name.slice(0, 1));
}

// --- The strip: up to date, shipped, ready to ship ---

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "3 fixes · 1 addition", leaving out what there is none of.
const KINDS = [['Fixes', 'fix', 'fixes'], ['Additions', 'addition', 'additions'], ['Changes', 'change', 'changes']];
function changeParts(counts) {
  return KINDS.filter(([key]) => counts[key]).flatMap(([key, one, many], i) => [i ? ' · ' : '', h('b', null, String(counts[key])), ` ${counts[key] === 1 ? one : many}`]);
}

function renderStrip() {
  const box = $('#strip');
  box.hidden = !state.mods.length || state.mods.some(m => m.loading);
  if (box.hidden) return;
  const count = key => state.mods.filter(m => m.group === key).length;
  const segs = [
    ['ok', state.mods.filter(m => !m.group).length, 'up to date'],
    ['release', count('todo'), 'to release'],
    ['upmerge', count('upmerge'), 'upmerge only'],
    ['translations', count('translations'), 'only translations'],
  ].filter(x => x[1]);
  const upToDate = h('div.strip-block', null,
    h('div.strip-label', null, 'Up to date'),
    h('div.strip-num', null, String(state.mods.filter(m => !m.group).length), h('small', null, `/ ${plural(state.mods.length, 'mod')}`)),
    h('div.segbar', null, segs.map(([k, n, label]) => h('span', { title: `${n} ${label}`, style: `flex: ${n}; background: var(--seg-${k})` }))),
    h('div.seg-legend', null, segs.map(([k, n, label]) => h('span', null, h('i', { style: `background: var(--seg-${k})` }), `${n} ${label}`))));

  const mo = state.momentum;
  const reached = state.insights && state.insights.reached;
  const shipped = h('div.strip-block', null, h('div.strip-label', null, `Shipped, last ${mo ? mo.recentDays : 30} days`),
    mo ? h('div.shipped-row', null,
      h('div', null,
        h('div.strip-num', null, String(mo.releases), h('small', null, mo.releases === 1 ? 'release' : 'releases')),
        h('div.strip-line', null, changeParts(mo.counts)),
        reached ? h('div.strip-sub', null, `downloaded ${compact(reached.downloads)} times so far`) : null),
      h('div.chart-col', null,
        mo.streak > 1 ? h('span.streak', { title: 'Weeks in a row with a release' }, `▲ ${mo.streak}-week streak`) : null,
        weeksChart(mo.weeks),
        h('div.chart-axis', null, h('span', null, `${mo.weeks.length} wk ago`), h('span', null, 'now'))))
      : h('div', null, h('span.spinner'), ' Counting…'));

  const ready = state.mods.filter(m => m.group === 'todo');
  const sum = key => ready.reduce((n, m) => n + m.ready[key], 0);
  const changes = sum('Fixes') + sum('Additions') + sum('Changes');
  const translated = count('translations');
  const readyBlock = h('div.strip-block', null, h('div.strip-label', null, 'Ready to ship'),
    ready.length ? [
      h('div.strip-num', null, String(changes), h('small', null, changes === 1 ? 'change waiting for players' : 'changes waiting for players')),
      h('div.strip-line', null, changeParts({ Fixes: sum('Fixes'), Additions: sum('Additions'), Changes: sum('Changes') }),
        translated ? [changes ? ' · ' : '', 'new translations for ', h('b', null, String(translated)), translated === 1 ? ' mod' : ' mods'] : null),
      h('div.ready-mods', null, ready.map(m => {
        const from = state.versions[m.start].name;
        const n = m.ready.Fixes + m.ready.Additions + m.ready.Changes + m.ready.translations;
        const blocked = m.blockedBy && m.blockedBy.length;
        return h(blocked ? 'button.ready-mod.blocked' : 'button.ready-mod', {
          title: blocked ? `Release ${m.blockedBy.join(', ')} first` : `Open ${m.name}: its release chain starts at ${from}`,
          onclick: () => select(m.name, from),
        }, modIcon(m.name, true), h('span', null, m.name), h('span.from', null, `from ${from}`), h('b', null, String(n)));
      })),
    ] : [
      h('div.strip-num', null, '0', h('small', null, 'changes waiting')),
      h('div.all-clear', null, translated ? `Only new translations for ${plural(translated, 'mod')}.` : 'Everything you made is out there.'),
    ]);
  box.replaceChildren(upToDate, shipped, readyBlock);
}

// Releases per week, oldest first; hover a bar for its count.
function weeksChart(weeks) {
  const bw = 12, gap = 4, height = 50;
  const max = Math.max(1, ...weeks);
  const width = weeks.length * (bw + gap) - gap;
  const bars = weeks.map((n, i) => {
    const x = i * (bw + gap);
    const ago = weeks.length - 1 - i;
    const bh = n ? Math.max(4, Math.round((n / max) * (height - 2))) : 0;
    const mark = n
      ? svg('path', { d: `M${x},${height} v-${bh - 3} q0,-3 3,-3 h${bw - 6} q3,0 3,3 v${bh - 3} z`, fill: 'var(--cable)', opacity: ago === 0 ? '1' : '.55' })
      : svg('rect', { x, y: height - 1, width: bw, height: 1, fill: 'var(--faint)' });
    return svg('g', null,
      svg('title', null, `${ago === 0 ? 'This week' : `${plural(ago, 'week')} ago`}: ${plural(n, 'release')}`),
      svg('rect', { class: 'hit', x: x - gap / 2, y: 0, width: bw + gap, height }),
      mark);
  });
  return svg('svg', { width, height, role: 'img', 'aria-label': `Releases per week, last ${weeks.length} weeks: ${weeks.join(', ')}` }, ...bars);
}

// --- Light and dark ---

// Follows the system, unless you chose light or dark here (remembered in this browser).
const THEMES = [
  { key: null, title: 'Light or dark: as your system (click for light)', icon: 'M8 1.8a6.2 6.2 0 1 0 0 12.4zM8 1.8a6.2 6.2 0 0 1 0 12.4' },
  { key: 'light', title: 'Light (click for dark)', icon: 'M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zM8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3' },
  { key: 'dark', title: 'Dark (click to follow your system)', icon: 'M13.5 10.2A5.8 5.8 0 0 1 5.8 2.5a5.8 5.8 0 1 0 7.7 7.7z' },
];
function storedTheme() {
  try {
    return localStorage.getItem('cc-theme');
  } catch (e) {
    return null;
  }
}
function applyTheme(key) {
  try {
    if (key) localStorage.setItem('cc-theme', key);
    else localStorage.removeItem('cc-theme');
  } catch (e) {
    // Only for this visit, then.
  }
  if (key) document.documentElement.dataset.theme = key;
  else delete document.documentElement.dataset.theme;
  const t = THEMES.find(x => x.key === key) || THEMES[0];
  const button = $('#theme');
  button.title = t.title;
  button.replaceChildren(svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    svg('path', { d: t.icon, fill: key === 'dark' || !key ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'fill-opacity': key ? '1' : '.35' })));
}
$('#theme').addEventListener('click', () => {
  const i = THEMES.findIndex(x => x.key === storedTheme());
  applyTheme(THEMES[(Math.max(0, i) + 1) % THEMES.length].key);
});
applyTheme(storedTheme());

// --- Insights: downloads, releases and GitHub ---

const compact = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : (n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)));
const full = n => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));

function platformLinks(name) {
  const d = state.insights && state.insights.downloads.mods.find(m => m.name === name);
  if (!d) return null;
  return [
    d.urls.curseforge ? h('a', { href: d.urls.curseforge, target: '_blank', rel: 'noopener' }, 'CurseForge') : null,
    d.urls.modrinth ? h('a', { href: d.urls.modrinth, target: '_blank', rel: 'noopener' }, 'Modrinth') : null,
  ];
}

// The column next to the table: what changes often first, the project boards, then the download totals.
function renderInsights() {
  const box = $('#insights');
  const ins = state.insights ? insightCards(state.insights) : {};
  const cards = [ins.perVersion, ins.github, ins.releases, ...(state.projects ? projectCards(state.projects) : []), ins.downloads].filter(Boolean);
  $('#layout').classList.toggle('with-insights', cards.length > 0);
  box.hidden = !cards.length;
  box.replaceChildren(...cards);
}

const external = (href, ...children) => h('a', { href, target: '_blank', rel: 'noopener' }, ...children);
const versionList = names => names.join(', ');

// The color GitHub shows for a status, as a ring before its name.
const statusDot = color => (color ? h('span', { class: `status-dot gh-${String(color).toLowerCase()}`, 'aria-hidden': 'true' }) : null);

// A small thumbs up, in the color of the text.
const thumb = () => svg('svg', { viewBox: '0 0 16 16', class: 'thumb', 'aria-hidden': 'true' },
  svg('path', { d: 'M2 7.2h2.6v6.6H2zM5.6 13.8V7.2l2.8-4.9c1 0 1.7.8 1.5 1.8l-.5 2.4h3.4c.9 0 1.5.8 1.3 1.6l-1.1 4.6c-.2.7-.7 1.1-1.4 1.1z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linejoin': 'round' }));

// One project board item: its title, then the mod, number and whether its fix is released.
function boardItem(i, { status = false } = {}) {
  return h('li', null,
    h('div.title', null, i.url ? external(i.url, i.title) : i.title),
    h('div.meta', null,
      status && i.status ? h('span.status', null, statusDot(i.statusColor), i.status) : null,
      [i.mod, i.number ? `#${i.number}` : null, i.kind === 'pr' ? 'PR' : null, i.kind === 'draft' ? 'draft' : null].filter(Boolean).join(' '),
      i.upvotes ? h('span.upvotes', { title: `${plural(i.upvotes, 'upvote')} (👍) on GitHub` }, thumb(), String(i.upvotes)) : null,
      i.unreleased.length ? h('span.unreleased', { title: 'A commit that closes it is not released on these versions yet' }, `not released on ${versionList(i.unreleased)}`) : null));
}

function projectCards(p) {
  if (!p.projects.length) {
    return p.running ? [h('div.card', null, h('h3', null, 'Project boards'), h('div', null, h('span.spinner'), ' Asking GitHub…'))] : [];
  }
  return p.projects.map(b => {
    if (b.error) {
      return h('div.card', null, h('h3', null, 'Project board', h('span.src', null, b.spec)), h('p.note.warn', null, b.error));
    }
    return h('div.card.board', null,
      h('h3', null, external(b.url, b.title), h('span.src', null, `${b.open} open`)),
      b.columns.map(c => h('div.column', null,
        h('div.colhead', null, h('span', null, statusDot(c.color), c.name || 'No status'), h('span.count', null, String(c.count))),
        h('ul.items', null, c.items.map(i => boardItem(i))),
        c.count > c.items.length ? external(b.url, `${c.count - c.items.length} more on the board`) : null)),
      b.unreleased.length ? h('div.column', null,
        h('div.colhead.release', null, 'Done, not released yet', h('span.count', null, String(b.unreleased.length))),
        h('ul.items', null, b.unreleased.map(i => boardItem(i)))) : null,
      h('p.note', null, `${b.done} done.`));
  });
}

function insightCards(ins) {
  // By name, so the column can put them in its own order.
  const cards = {};
  const dl = ins.downloads;
  if (!dl.mods.length) {
    cards.downloads = (h('div.card', null, h('h3', null, 'Downloads'),
      ins.running ? h('div', null, h('span.spinner'), ' Asking CurseForge and Modrinth…')
        : h('p.note', null, 'No mod names its curseforge_project_id or modrinth_project_id in gradle.properties.')));
  } else {
    const total = m => (m.curseforge || 0) + (m.modrinth || 0);
    const mods = dl.mods.slice().sort((a, b) => total(b) - total(a));
    const max = Math.max(1, ...mods.map(total));
    cards.downloads = (h('div.card', null,
      h('h3', null, 'Downloads', h('span.src', null, 'CurseForge + Modrinth, all time')),
      h('div.kpis', null,
        h('div.kpi', null, h('div.num', null, compact(dl.curseforge)), h('div.lbl', null, 'on CurseForge')),
        h('div.kpi', null, h('div.num', null, compact(dl.modrinth)), h('div.lbl', null, 'on Modrinth'))),
      mods.map(m => h('div.meter.with-links', {
        title: `${m.name}: ${full(m.curseforge)} on CurseForge, ${full(m.modrinth)} on Modrinth${m.followers !== null ? `, ${m.followers} followers on Modrinth` : ''}`,
      },
      h('span.name', null, modIcon(m.name, true), h('span', null, m.name)),
      h('div.track', null, h('div.fill', { style: `width: ${(total(m) / max) * 100}%` })),
      h('span.val', null, compact(total(m))),
      // The projects, as CF and MR, the usual short names, to leave room for the bar.
      h('span.links', null,
        m.urls.curseforge ? h('a', { href: m.urls.curseforge, target: '_blank', rel: 'noopener', title: `${m.name} on CurseForge` }, 'CF') : h('span'),
        m.urls.modrinth ? h('a', { href: m.urls.modrinth, target: '_blank', rel: 'noopener', title: `${m.name} on Modrinth` }, 'MR') : h('span')))),
      ins.errors.length ? h('p.note.warn', { title: ins.errors.join('\n') }, `Some numbers are missing: ${ins.errors.length} request${ins.errors.length === 1 ? '' : 's'} failed (hover for details).`) : null,
      ins.fetchedAt ? h('p.note', null, `Updated ${ago(ins.fetchedAt)}.`) : null));

    const vmax = Math.max(1, ...ins.perVersion.map(v => v.downloads));
    cards.perVersion = (h('div.card', null,
      h('h3', null, 'Downloads per MC version', h('span.src', null, `last ${ins.recentDays} days`)),
      ins.perVersion.map(v => h('div.meter', { title: `${v.name} (${v.mc}): ${full(v.downloads)} downloads of ${v.files} files published in the last ${ins.recentDays} days` },
        h('span.name.mono', null, v.name),
        h('div.track', null, h('div.fill', { style: `width: ${(v.downloads / vmax) * 100}%` })),
        h('span.val', null, compact(v.downloads)))),
      h('p.note', null, `Downloads of the files published in the last ${ins.recentDays} days, all mods. Helps decide which MC versions are still worth maintaining.`)));
  }

  if (ins.github) {
    const mods = ins.github.mods.slice().sort((a, b) => (b.issues + b.prs) - (a.issues + a.prs));
    const link = (m, kind, n) => (n ? h('a', { href: `https://github.com/${(state.mods.find(x => x.name === m.name) || {}).github}/${kind}`, target: '_blank', rel: 'noopener' }, String(n)) : '0');
    cards.github = (h('div.card', null,
      h('h3', null, 'Open on GitHub', h('span.src', null, `${ins.github.issues} issues · ${ins.github.prs} PRs`)),
      h('table.mini', null,
        h('tr', null, h('th', null, ''), h('th.n', null, 'Issues'), h('th.n', null, 'PRs')),
        mods.map(m => h('tr', null,
          h('td', null, m.name),
          h(m.issues ? 'td.n' : 'td.n.zero', null, link(m, 'issues', m.issues)),
          h(m.prs ? 'td.n' : 'td.n.zero', null, link(m, 'pulls', m.prs)))))));
  } else {
    cards.github = (h('div.card', null, h('h3', null, 'Open on GitHub'),
      h('p.note', null, 'Needs a GitHub token: run gh auth login, or set GH_TOKEN.')));
  }

  if (ins.releases.length) {
    const when = iso => {
      const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
      return days === 0 ? 'today' : `${days}d`;
    };
    const clock = () => svg('svg', { viewBox: '0 0 16 16', class: 'clock', 'aria-hidden': 'true' },
      svg('circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
      svg('path', { d: 'M8 4.6V8l2.4 1.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
    const pub = {
      yes: () => h('span.check', { title: 'On CurseForge and Modrinth' }, '✓'),
      no: () => h('span.warn', { title: 'Missing on CurseForge or Modrinth' }, '✗'),
      pending: () => h('span.uploading', { title: 'Not on both platforms yet; it may still be uploading. Checked again every 10 minutes.' }, clock()),
      unknown: () => h('span.unknown', { title: 'Not checked yet' }, '?'),
    };
    const latest = ins.latest;
    const latestNote = () => {
      if (latest.missing.length) return h('p.note.warn', null, `Missing on CurseForge or Modrinth: ${latest.missing.map(m => `${m.mod} ${m.tag}`).join(', ')}.`);
      const onBoth = latest.total - latest.pending - latest.unknown;
      if (onBoth === latest.total) return h('p.note', null, `All ${latest.total} latest releases per version are on both CurseForge and Modrinth.`);
      const rest = [latest.pending ? `${latest.pending} may still be uploading` : null, latest.unknown ? `${latest.unknown} not checked yet` : null];
      return h('p.note', null, `${onBoth} of the ${latest.total} latest releases per version are on both CurseForge and Modrinth; ${rest.filter(Boolean).join(', ')}.`);
    };
    cards.releases = (h('div.card', null,
      h('h3', null, 'Recent releases', h('span.src', null, '✓ on CurseForge and Modrinth')),
      h('table.mini.releases', null, ins.releases.map(r => {
        const repo = (state.mods.find(x => x.name === r.mod) || {}).github;
        return h('tr', null,
          h('td.when', { title: new Date(r.date).toLocaleString() }, when(r.date)),
          h('td', null,
            h('div.mod', null, modIcon(r.mod, true), r.mod),
            h('div.mono.tag', null, repo ? h('a', { href: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tag)}`, target: '_blank', rel: 'noopener' }, r.tag) : r.tag)),
          h('td.n.pub', null, pub[r.published]()));
      })),
      latestNote()));
  }
  return cards;
}

function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('state', e => {
    const next = JSON.parse(e.data);
    compareStates(state, next);
    state = next;
    connected = true;
    render();
  });
  events.onerror = () => {
    connected = false;
    renderBanner();
  };
}

// Looking at the page refreshes it: catches edits in the checkouts, which aren't watched.
let lastFocusRefresh = 0;
function onFocus() {
  if (Date.now() - lastFocusRefresh < 15000) return;
  lastFocusRefresh = Date.now();
  post('/api/refresh', { kind: 'local' }).catch(() => {});
}

$('#refresh').addEventListener('click', e => {
  post('/api/refresh', { kind: e.shiftKey ? 'full' : 'remote' }).catch(err => alert(err.message));
});
window.addEventListener('focus', onFocus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) onFocus(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && selected) select(null); });
window.addEventListener('hashchange', () => { readHash(); render(); });
setInterval(renderBar, 30000);

readHash();
render();
connect();
