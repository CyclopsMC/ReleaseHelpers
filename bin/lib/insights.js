'use strict';
// Downloads and releases of the mods on CurseForge (through cfwidget, as the official API needs a
// key) and Modrinth, for the cards next to the dashboard table. Each mod names its projects with
// curseforge_project_id and modrinth_project_id in its gradle.properties.

const http = require('http');
const https = require('https');

const TIMEOUT_MS = 20000;
const RECENT_DAYS = 90;
// For "players reached": downloads of the releases of this many days.
const REACHED_DAYS = 30;
// A release this young may still be uploading, so a missing file isn't reported yet.
const PUBLISH_GRACE_MS = 2 * 3600 * 1000;

const cfwidgetApi = () => process.env.CC_HELPERS_CFWIDGET_API || 'https://api.cfwidget.com';
const modrinthApi = () => process.env.CC_HELPERS_MODRINTH_API || 'https://api.modrinth.com/v2';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'User-Agent': 'cc-helpers', Accept: 'application/json' }, timeout: TIMEOUT_MS }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${u.host} answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`${u.host} sent invalid JSON`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${u.host} did not answer in time`)));
    req.on('error', reject);
  });
}

// An image or other small file, following one redirect.
function getBinary(url, redirects = 1) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'User-Agent': 'cc-helpers' }, timeout: TIMEOUT_MS }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getBinary(new URL(res.headers.location, u).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${u.host} answered ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error(`${u.host} did not answer in time`)));
    req.on('error', reject);
  });
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What the cards need of one mod: totals, downloads per MC version of recent files, and whether
// each of `tags` ([{ tag, date }], tags look like <mc>-<version>) is on both platforms.
// `ids`: { curseforge, modrinth }; `mcs`: the MC versions of the maintained branches.
async function fetchPlatforms(ids, mcs, tags, now = Date.now()) {
  const result = { fetchedAt: new Date(now).toISOString(), curseforge: null, modrinth: null, icon: null, recent: {}, released: null, tags: [], errors: [] };
  const files = { curseforge: null, modrinth: null };
  if (ids.curseforge) {
    try {
      const cf = await getJson(`${cfwidgetApi()}/${encodeURIComponent(ids.curseforge)}`);
      result.curseforge = { total: cf.downloads.total, url: (cf.urls && cf.urls.curseforge) || null };
      result.icon = cf.thumbnail || null;
      files.curseforge = cf.files.map(f => ({ name: f.name, mcs: f.versions, downloads: f.downloads, date: f.uploaded_at, release: f.type === 'release' }));
    } catch (e) {
      result.errors.push(`CurseForge: ${e.message}`);
    }
  }
  if (ids.modrinth) {
    try {
      const id = encodeURIComponent(ids.modrinth);
      const [project, versions] = await Promise.all([getJson(`${modrinthApi()}/project/${id}`), getJson(`${modrinthApi()}/project/${id}/version`)]);
      result.modrinth = { total: project.downloads, followers: project.followers, url: `https://modrinth.com/mod/${project.slug}` };
      // Modrinth's icon is the larger one.
      result.icon = project.icon_url || result.icon;
      files.modrinth = versions.map(v => ({ number: v.version_number, mcs: v.game_versions, downloads: v.downloads, date: v.date_published, release: v.version_type === 'release' }));
    } catch (e) {
      result.errors.push(`Modrinth: ${e.message}`);
    }
  }

  // Releases only: CI publishes a beta on every push.
  const all = [...(files.curseforge || []), ...(files.modrinth || [])];
  if (files.curseforge || files.modrinth) {
    const reachedSince = now - REACHED_DAYS * 86400000;
    result.released = all.filter(f => f.release && Date.parse(f.date) >= reachedSince).reduce((n, f) => n + f.downloads, 0);
  }

  const since = now - RECENT_DAYS * 86400000;
  for (const mc of mcs) {
    const recent = [...(files.curseforge || []), ...(files.modrinth || [])].filter(f => f.mcs.includes(mc) && Date.parse(f.date) >= since);
    result.recent[mc] = { downloads: recent.reduce((n, f) => n + f.downloads, 0), files: recent.length };
  }

  // Release files are named <modid>-<mc>-<loader>-<version>.jar on CurseForge; Modrinth uses the tag.
  for (const { tag, date } of tags) {
    const mc = mcs.find(m => tag.startsWith(`${m}-`));
    if (!mc) continue;
    const version = tag.slice(mc.length + 1);
    const onCurseforge = files.curseforge && files.curseforge.some(f => f.mcs.includes(mc) && new RegExp(`-${escape(version)}\\.jar$`).test(f.name));
    const onModrinth = files.modrinth && files.modrinth.some(f => f.number === tag);
    result.tags.push({ tag, date, curseforge: files.curseforge ? onCurseforge : null, modrinth: files.modrinth ? onModrinth : null });
  }
  return result;
}

// Whether a release is on both platforms: 'yes', 'no', 'pending' (young and not there yet), or
// 'unknown' (a platform didn't answer, or the release is newer than the data).
function publishState(entry, date, now = Date.now()) {
  if (!entry || entry.curseforge === null || entry.modrinth === null) return 'unknown';
  if (entry.curseforge && entry.modrinth) return 'yes';
  return now - Date.parse(date) < PUBLISH_GRACE_MS ? 'pending' : 'no';
}

// The data of the cards, from the per-mod platform data and the dashboard state.
// mods: [{ name, platforms, github: { issues, prs } | null, lastReleases: [tag] }]
// versions: [{ name, mc }]
function summarize(mods, versions, now = Date.now()) {
  const withPlatforms = mods.filter(m => m.platforms);
  const downloads = withPlatforms.map(m => ({
    name: m.name,
    curseforge: m.platforms.curseforge ? m.platforms.curseforge.total : null,
    modrinth: m.platforms.modrinth ? m.platforms.modrinth.total : null,
    followers: m.platforms.modrinth ? m.platforms.modrinth.followers : null,
    urls: { curseforge: m.platforms.curseforge && m.platforms.curseforge.url, modrinth: m.platforms.modrinth && m.platforms.modrinth.url },
  }));
  const sum = key => downloads.reduce((n, d) => n + (d[key] || 0), 0);
  const perVersion = versions.filter(v => v.mc).map(v => ({
    name: v.name,
    mc: v.mc,
    downloads: withPlatforms.reduce((n, m) => n + ((m.platforms.recent[v.mc] || {}).downloads || 0), 0),
    files: withPlatforms.reduce((n, m) => n + ((m.platforms.recent[v.mc] || {}).files || 0), 0),
  }));
  const withGithub = mods.filter(m => m.github);
  const github = withGithub.length ? {
    mods: withGithub.map(m => ({ name: m.name, issues: m.github.issues, prs: m.github.prs })),
    issues: withGithub.reduce((n, m) => n + m.github.issues, 0),
    prs: withGithub.reduce((n, m) => n + m.github.prs, 0),
  } : null;
  const releases = withPlatforms.flatMap(m => m.platforms.tags.map(t => ({ mod: m.name, tag: t.tag, date: t.date, published: publishState(t, t.date, now) })))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, 8);
  // The last release of every mod on every maintained version.
  const latest = withPlatforms.flatMap(m => m.lastReleases.map(tag => {
    const entry = m.platforms.tags.find(t => t.tag === tag);
    return { mod: m.name, tag, published: publishState(entry, entry && entry.date, now) };
  }));
  const released = withPlatforms.map(m => m.platforms.released).filter(n => n !== null && n !== undefined);
  const fetched = withPlatforms.map(m => m.platforms.fetchedAt).sort();
  return {
    fetchedAt: fetched[0] || null,
    downloads: { curseforge: sum('curseforge'), modrinth: sum('modrinth'), mods: downloads },
    perVersion,
    recentDays: RECENT_DAYS,
    // Downloads of the releases of the last REACHED_DAYS days; null when no platform answered.
    reached: released.length ? { downloads: released.reduce((a, b) => a + b, 0), days: REACHED_DAYS } : null,
    github,
    releases,
    latest: {
      total: latest.length,
      missing: latest.filter(l => l.published === 'no'),
      pending: latest.filter(l => l.published === 'pending').length,
      unknown: latest.filter(l => l.published === 'unknown').length,
    },
    errors: withPlatforms.flatMap(m => m.platforms.errors.map(e => `${m.name}: ${e}`)),
  };
}

module.exports = { fetchPlatforms, summarize, publishState, getBinary, RECENT_DAYS, REACHED_DAYS };
