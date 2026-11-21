'use strict';
// The dashboard's insights against stand-ins for cfwidget (CurseForge) and Modrinth.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { createSandbox } = require('./helpers');
const { publishState, summarize } = require('../bin/lib/insights');

const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\ncurseforge_project_id=111\nmodrinth_project_id=abc\n`;
const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();
let sb;
let server;
let modrinthUp = true;

before(async () => {
  sb = createSandbox('cc-insights-test-');
  const w = sb.newMod('ModA');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  sb.commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/A.java': 'a' });
  sb.git(w, 'tag', '-a', '-m', 'Release', '1.20.1-1.0.0');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '2.0.0') });
  sb.git(w, 'tag', '-a', '-m', 'Release', '1.21.1-2.0.0');
  sb.git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');
  sb.checkout('mc20-lts', 'ModA', 'master-1.20-lts');
  sb.checkout('mc21-lts', 'ModA', 'master-1.21-lts');
  sb.write(sb.path('mc21-lts', '.upmerge-src-branch'), 'master-1.20-lts\n');
  sb.write(sb.path('cc-helpers.json'), JSON.stringify({ versions: [
    { dir: sb.path('mc20-lts'), branch: 'master-1.20-lts' },
    { dir: sb.path('mc21-lts'), branch: 'master-1.21-lts' },
  ], github: false }));

  // 2.0.0 is on CurseForge but not on Modrinth; one old file is outside the 90 days.
  const routes = {
    '/cf/111': {
      downloads: { total: 1000, monthly: 0 },
      urls: { curseforge: 'https://www.curseforge.com/minecraft/mc-mods/moda' },
      files: [
        { name: 'moda-1.21.1-neoforge-2.0.0.jar', type: 'release', versions: ['1.21.1', 'NeoForge'], downloads: 500, uploaded_at: daysAgo(3) },
        { name: 'moda-1.20.1-neoforge-1.0.0.jar', type: 'release', versions: ['1.20.1', 'NeoForge'], downloads: 300, uploaded_at: daysAgo(10) },
        { name: 'moda-1.20.1-neoforge-1.0.0-12.jar', type: 'beta', versions: ['1.20.1'], downloads: 7, uploaded_at: daysAgo(11) },
        { name: 'moda-1.20.1-neoforge-0.9.0.jar', type: 'release', versions: ['1.20.1'], downloads: 200, uploaded_at: daysAgo(200) },
      ],
    },
    '/mr/project/abc': { downloads: 50, followers: 3, slug: 'moda' },
    '/mr/project/abc/version': [
      { version_number: '1.20.1-1.0.0', version_type: 'release', game_versions: ['1.20.1'], downloads: 20, date_published: daysAgo(10) },
    ],
  };
  const ICON = Buffer.from('not really a png');
  server = http.createServer((req, res) => {
    if (req.url === '/mr/icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(ICON);
    }
    const body = routes[req.url];
    const down = req.url.startsWith('/mr/') && !modrinthUp;
    res.writeHead(body && !down ? 200 : (down ? 500 : 404), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body && !down ? body : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  routes['/mr/project/abc'].icon_url = `http://127.0.0.1:${server.address().port}/mr/icon.png`;
  Object.assign(process.env, sb.env, {
    CC_HELPERS_CONFIG: sb.path('cc-helpers.json'),
    CC_HELPERS_CFWIDGET_API: `http://127.0.0.1:${server.address().port}/cf`,
    CC_HELPERS_MODRINTH_API: `http://127.0.0.1:${server.address().port}/mr`,
  });
});

after(() => {
  server.close();
  sb.cleanup();
});

async function insights(options = {}) {
  const { Monitor } = require('../bin/lib/monitor');
  const monitor = new Monitor({ options });
  try {
    monitor.reload();
    await monitor.request('local');
    await monitor.refreshInsights();
    return monitor.snapshot().insights;
  } finally {
    monitor.stop();
  }
}

test('counts downloads, per MC version of the last 90 days, and checks the releases on both platforms', async () => {
  const ins = await insights();
  assert.deepStrictEqual(ins.errors, []);
  assert.deepStrictEqual(ins.downloads, {
    curseforge: 1000,
    modrinth: 50,
    mods: [{
      name: 'ModA',
      curseforge: 1000,
      modrinth: 50,
      followers: 3,
      urls: { curseforge: 'https://www.curseforge.com/minecraft/mc-mods/moda', modrinth: 'https://modrinth.com/mod/moda' },
    }],
  });
  // The 200-day-old file doesn't count; the beta does.
  assert.deepStrictEqual(ins.perVersion, [
    { name: '1.20-lts', mc: '1.20.1', downloads: 300 + 7 + 20, files: 3 },
    { name: '1.21-lts', mc: '1.21.1', downloads: 500, files: 1 },
  ]);
  assert.deepStrictEqual(ins.releases.map(r => [r.tag, r.published]), [['1.21.1-2.0.0', 'no'], ['1.20.1-1.0.0', 'yes']]);
  assert.deepStrictEqual(ins.latest, { total: 2, missing: [{ mod: 'ModA', tag: '1.21.1-2.0.0', published: 'no' }], pending: 0, unknown: 0 });
  assert.strictEqual(ins.github, null);
  // Releases of the last 30 days: not the beta, not the 200 days old one.
  assert.deepStrictEqual(ins.reached, { downloads: 500 + 300 + 20, days: 30 });
  // Kept for the next start.
  const saved = JSON.parse(fs.readFileSync(sb.path('state', 'insights.json'), 'utf8'));
  assert.strictEqual(saved.mods.ModA.curseforge.total, 1000);
});

test('a platform that fails leaves its numbers out and says so', async () => {
  modrinthUp = false;
  try {
    const ins = await insights();
    assert.strictEqual(ins.downloads.mods[0].modrinth, null);
    assert.strictEqual(ins.downloads.curseforge, 1000);
    assert.match(ins.errors[0], /^ModA: Modrinth: 127\.0\.0\.1:\d+ answered 500$/);
    assert.deepStrictEqual(ins.releases.map(r => r.published), ['unknown', 'unknown']);
    assert.strictEqual(ins.latest.unknown, 2);
  } finally {
    modrinthUp = true;
  }
});

test('can be turned off', async () => {
  const file = process.env.CC_HELPERS_CONFIG;
  const off = sb.path('off.json');
  sb.write(off, JSON.stringify({ ...JSON.parse(sb.read(file)), dashboard: { insights: false } }));
  process.env.CC_HELPERS_CONFIG = off;
  try {
    assert.strictEqual(await insights(), null);
  } finally {
    process.env.CC_HELPERS_CONFIG = file;
  }
});

test('a young release that is not on both platforms yet is pending, not missing', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const entry = { curseforge: true, modrinth: false };
  assert.strictEqual(publishState(entry, '2026-11-20T11:00:00Z', now), 'pending');
  assert.strictEqual(publishState(entry, '2026-11-20T08:00:00Z', now), 'no');
  assert.strictEqual(publishState(undefined, null, now), 'unknown');
  const ins = summarize([{ name: 'M', github: { issues: 2, prs: 1 }, lastReleases: ['1.21.1-1.0.1'], platforms: {
    fetchedAt: '2026-11-20T11:30:00Z', curseforge: { total: 5, url: null }, modrinth: null, recent: {},
    tags: [{ tag: '1.21.1-1.0.1', date: '2026-11-20T11:00:00Z', curseforge: true, modrinth: false }], errors: [],
  } }], [{ name: '1.21-lts', mc: '1.21.1' }], now);
  // Uploading, so neither on both nor missing.
  assert.deepStrictEqual(ins.latest, { total: 1, missing: [], pending: 1, unknown: 0 });
  assert.deepStrictEqual(ins.github, { mods: [{ name: 'M', issues: 2, prs: 1 }], issues: 2, prs: 1 });
});

test('orders releases by time, also across UTC offsets', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const tag = (t, date) => ({ tag: t, date, curseforge: true, modrinth: true });
  const ins = summarize([{ name: 'M', github: null, lastReleases: [], platforms: {
    fetchedAt: '2026-11-21T11:00:00Z', curseforge: { total: 1, url: null }, modrinth: null, recent: {}, errors: [],
    // 06:40 UTC in winter time comes after 06:37 UTC in summer time.
    tags: [tag('1.21.1-1.0.0', '2026-10-10T08:37:00+02:00'), tag('26.1.2-1.0.0', '2026-10-10T07:40:00+01:00')],
  } }], [], now);
  assert.deepStrictEqual(ins.releases.map(r => r.tag), ['26.1.2-1.0.0', '1.21.1-1.0.0']);
});

test('looks up new releases at once, and again while they may still be uploading', async () => {
  const { Monitor } = require('../bin/lib/monitor');
  const monitor = new Monitor({ options: {} });
  try {
    monitor.reload();
    await monitor.request('local');
    const asked = [];
    monitor.refreshInsights = mods => asked.push(mods);
    const now = Date.parse('2026-11-21T12:00:00Z');
    const data = (minutesAgo, tags) => ({ fetchedAt: new Date(now - minutesAgo * 60000).toISOString(), tags });
    const released = (tag, minutesAgo, curseforge) => ({ tag, date: new Date(now - minutesAgo * 60000).toISOString(), curseforge, modrinth: true });
    const known = [released('1.20.1-1.0.0', 900, true), released('1.21.1-2.0.0', 900, true)];

    // A release the data doesn't know yet: at once, but not twice within a minute.
    monitor.platforms.set('ModA', data(0.5, known.slice(0, 1)));
    monitor.recheckNewReleases(now);
    monitor.platforms.set('ModA', data(2, known.slice(0, 1)));
    monitor.recheckNewReleases(now);
    assert.deepStrictEqual(asked, [['ModA']]);

    // On Modrinth but not yet on CurseForge: every 10 minutes, until 2 hours after the release.
    asked.length = 0;
    for (const [fetched, age] of [[5, 30], [11, 30], [11, 150]]) {
      monitor.platforms.set('ModA', data(fetched, [known[0], released('1.21.1-2.0.0', age, false)]));
      monitor.recheckNewReleases(now);
    }
    assert.deepStrictEqual(asked, [['ModA']]);

    // Everything known and published: nothing to look up.
    monitor.platforms.set('ModA', data(30, known));
    monitor.recheckNewReleases(now);
    assert.strictEqual(asked.length, 1);
  } finally {
    monitor.stop();
  }
});

test('finds tags in every checkout of a mod', async () => {
  // A tag only the 1.21 checkout has, like one a release chain just pushed from there.
  sb.git(sb.path('mc21-lts', 'ModA'), 'tag', '-a', '-m', 'Release', '1.21.1-2.0.1');
  const { Monitor } = require('../bin/lib/monitor');
  const monitor = new Monitor({ options: {} });
  try {
    monitor.reload();
    await monitor.request('local');
    await monitor.refreshInsights();
    assert.ok(monitor.platforms.get('ModA').tags.some(t => t.tag === '1.21.1-2.0.1'));
  } finally {
    monitor.stop();
  }
});

test('caches the icon of a mod, and serves only that', async () => {
  const { Monitor } = require('../bin/lib/monitor');
  const monitor = new Monitor({ options: {} });
  try {
    monitor.reload();
    await monitor.request('local');
    await monitor.refreshInsights();
    const icon = monitor.iconFile('ModA');
    assert.strictEqual(icon.type, 'image/png');
    assert.strictEqual(fs.readFileSync(icon.file, 'utf8'), 'not really a png');
    assert.deepStrictEqual(monitor.snapshot().icons, ['ModA']);
    assert.strictEqual(monitor.iconFile('../ModA'), null);
    // The next start knows it without fetching it again.
    const again = new Monitor({ options: {} });
    try {
      again.reload();
      again.loadInsights();
      assert.strictEqual(again.iconFile('ModA').file, icon.file);
    } finally {
      again.stop();
    }
  } finally {
    monitor.stop();
  }
});
