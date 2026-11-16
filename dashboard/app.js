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
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
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

function cellTitle(mod, cell, version) {
  if (cell.error) return cell.error;
  const parts = [];
  if (cell.unreleased && cell.unreleased.userFacing.length) parts.push(`${cell.unreleased.userFacing.length} unreleased`);
  if (cell.pending.userFacing.length) parts.push(`${cell.pending.userFacing.length} to upmerge`);
  if (!parts.length) parts.push('nothing to release');
  parts.push(cell.lastRelease ? `last release ${cell.lastRelease}` : (mod.upmergeOnly ? 'upmerge only' : `no ${cell.mc} release yet`));
  if (cell.local.length) parts.push(cell.local.join(', '));
  return `${mod.name} ${version.name}: ${parts.join(' · ')}`;
}

const GROUPS = [
  { key: 'todo', tone: 'release', title: 'To release', chip: n => `${n} to release` },
  { key: 'translations', tone: 'translations', title: 'Only translations', chip: n => `${n} only translations` },
  { key: 'upmerge', tone: 'upmerge', title: 'Upmerge only', chip: n => `${n} upmerge only` },
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
  renderGrid();
  renderGroups();
  renderProblems();
  renderPanel();
}

function renderBar() {
  const summary = $('#summary');
  const sync = $('#sync');
  summary.replaceChildren();
  sync.replaceChildren();
  if (!state) {
    sync.append(h('span.spinner'), 'Connecting…');
    return;
  }
  const counts = {};
  for (const m of state.mods) if (m.group) counts[m.group] = (counts[m.group] || 0) + 1;
  for (const g of GROUPS) if (counts[g.key]) summary.append(h(`span.chip.${g.tone}`, null, g.chip(counts[g.key])));
  const loading = state.mods.some(m => m.loading);
  if (!loading && !Object.keys(counts).length && state.mods.length) summary.append(h('span.chip.ok', null, 'Nothing to release'));
  const errors = state.mods.reduce((n, m) => n + m.cells.filter(c => c.error).length, 0);
  if (errors) summary.append(h('span.chip.danger', null, `${errors} error${errors === 1 ? '' : 's'}`));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) CC status` : 'CC status';

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
      mod.name,
      mod.github ? h('a.mod-link', { href: `https://github.com/${mod.github}`, target: '_blank', rel: 'noopener', title: 'Open on GitHub' }, '↗') : null);
    const cells = mod.cells.map((cell, i) => {
      const version = state.versions[i];
      if (cell.loading) return h('td', null, h('span.cell.loading', null, '…'));
      if (cell.missing) return h('td', null, h('span.cell.missing', { title: `No ${version.name} checkout` }, '-'));
      const isSelected = selected && selected.mod === mod.name && selected.version === version.name;
      const cls = ['cell', tone(mod, cell)];
      if (cell.local && cell.local.length) cls.push('attention');
      if (mod.start === i) cls.push('start');
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
  for (const g of GROUPS) {
    const byVersion = state.versions.map(() => []);
    for (const m of state.mods) if (m.group === g.key) byVersion[m.start].push(m);
    if (!byVersion.some(l => l.length)) continue;
    any = true;
    box.append(h(`div.card.${g.tone}`, null,
      h('h3', null, h('span.dot'), g.title, h('span.hint', null, 'by lowest version')),
      byVersion.map((mods, i) => (mods.length ? h('div.group-row', null,
        h('span.ver', null, state.versions[i].name),
        h('div.mods', null, mods.map(m => h('button.mod-chip', { onclick: () => select(m.name, state.versions[i].name) }, m.name)))) : null))));
  }
  if (!any && state.mods.length) box.append(h('div.card.done', null, h('h3', null, 'Nothing to release or upmerge.')));
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

function commitRow(mod, c, dropped) {
  const key = commitKey(mod, c);
  const open = expanded.has(key);
  const badges = [];
  if (c.kind === 'translations') badges.push(h('span.badge.translations', null, 'translations'));
  if (c.kind === 'compat') badges.push(h('span.badge.compat', null, 'compat'));
  if (dropped) badges.push(h(c.marked ? 'span.badge.marked' : 'span.badge', null, c.reason));
  else if (c.marked) badges.push(h('span.badge.marked', null, 'marked as release'));
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
  if (!open) return h(dropped ? 'li.commit.dropped' : 'li.commit', null, head);

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
  return h(dropped ? 'li.commit.dropped' : 'li.commit', null, head, body);
}

function section(mod, title, hint, commits, { dropped = false, collapsible = false } = {}) {
  const list = commits.length
    ? h('ul.commits', null, commits.map(c => commitRow(mod, c, dropped)))
    : h('div.empty', null, 'None');
  if (collapsible) {
    const det = h('details.section', null, h('summary', null, `${title} · ${commits.length}`, h('span.hint', null, hint)), list);
    det.open = commits.some(c => expanded.has(commitKey(mod, c)));
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
    h('div', null, h('h2', null, mod.name), h('div.sub', null, `${version.name} · ${version.branch}`)),
    h('button.btn.small.close', { onclick: () => select(null), title: 'Close (Esc)' }, 'Close'))];

  if (cell.error) {
    content.push(h('div.alert', null, cell.error));
  } else {
    const tagLink = tag => (mod.github ? h('a', { href: `https://github.com/${mod.github}/releases/tag/${encodeURIComponent(tag)}`, target: '_blank', rel: 'noopener' }, tag) : h('code', null, tag));
    content.push(h('div.meta', null, cell.lastRelease
      ? ['Last release ', tagLink(cell.lastRelease)]
      : (mod.upmergeOnly ? 'This mod has no releases: it is only upmerged.' : `No ${cell.mc} release yet.`)));
    if (cell.local.length) content.push(h('div.alert', null, 'This checkout needs attention:', h('ul', null, cell.local.map(l => h('li', null, l)))));
    if (cell.unreleased) content.push(section(mod, 'Unreleased', `since ${cell.lastRelease}`, cell.unreleased.userFacing));
    const lower = state.versions.slice(0, vi).map(v => v.name).join(', ');
    if (vi > 0) content.push(section(mod, 'To upmerge', lower ? `from ${lower}` : '', cell.pending.userFacing));
    const dropped = (cell.unreleased ? cell.unreleased.dropped : []).concat(cell.pending.dropped);
    content.push(section(mod, 'Left out by the filter', 'no release needed', dropped, { dropped: true, collapsible: true }));
    if (cell.otherDifferingTags.length) {
      content.push(h('div.note', null, `Older tags that differ from origin, which doesn't affect this status: ${cell.otherDifferingTags.join(', ')}.`));
    }
  }
  panel.replaceChildren(...content);
  panel.hidden = false;
  panel.scrollTop = scroll;
}

function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('state', e => {
    state = JSON.parse(e.data);
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
