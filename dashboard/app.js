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
      h('div.mod-name', null,
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
  for (const g of GROUPS) {
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
        }, m.name, m.chains.length ? ' ▸' : '')))) : null))));
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

// The mark button of a commit: what clicking it would do.
function markButton(mod, c, dropped) {
  let label;
  let release;
  let title;
  if (c.marked) {
    label = 'Unmark';
    release = null;
    title = dropped ? 'You marked this as needing no release. Click to undo.' : 'You marked this as needing a release. Click to undo.';
  } else if (dropped) {
    label = 'Needs release';
    release = true;
    title = 'The filter left this out. Mark it as needing a release anyway.';
  } else {
    label = 'No release';
    release = false;
    title = "Mark this as needing no release, e.g. a build change that touched a source file. Applies to all MC versions.";
  }
  const key = `mark/${c.hash}`;
  return h(c.marked ? 'button.btn.small.mark.marked' : 'button.btn.small.mark', {
    title,
    disabled: busy.has(key),
    onclick: () => act(key, '/api/mark', { mod: mod.name, hash: c.hash, release }),
  }, busy.has(key) ? '…' : label);
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
  const line = h('div.commit-line', null, head, markButton(mod, c, dropped));
  const cls = dropped ? 'li.commit.dropped' : 'li.commit';
  if (!open) return h(cls, null, line);

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
  return h(cls, null, line, body);
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

function section(mod, title, hint, commits, { dropped = false, collapsible = false, key = title } = {}) {
  const list = commits.length
    ? h('ul.commits', null, commits.map(c => commitRow(mod, c, dropped)))
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
    h('div', null, h('h2', null, mod.name), mod.github ? h('div.sub', null, h('a', { href: `https://github.com/${mod.github}`, target: '_blank', rel: 'noopener' }, mod.github)) : null),
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
    if (cell.unreleased) content.push(section(mod, 'Unreleased', `since ${cell.lastRelease}`, cell.unreleased.userFacing));
    const lower = state.versions.slice(0, vi).map(v => v.name).join(', ');
    if (vi > 0) content.push(section(mod, 'To upmerge', lower ? `from ${lower}` : '', cell.pending.userFacing));
    const dropped = (cell.unreleased ? cell.unreleased.dropped : []).concat(cell.pending.dropped);
    content.push(section(mod, 'Left out by the filter', 'no release needed', dropped,
      { dropped: true, collapsible: true, key: `${mod.name}/${version.name}/dropped` }));
    if (cell.otherDifferingTags.length) {
      content.push(h('div.note', null, `Older tags that differ from origin, which doesn't affect this status: ${cell.otherDifferingTags.join(', ')}.`));
    }
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
