'use strict';
// What was shipped lately, for the strip at the top of the dashboard: releases per week, and the
// changelog entries of the releases of the last 30 days.

const { gitOrNull } = require('./git');
const { parseEntries, entryKey } = require('./changelog');

const DAY = 86400000;
const WEEK = 7 * DAY;
const WEEKS = 12;
const RECENT_DAYS = 30;

// mods: [{ name, dirs: [checkout] }]; mcs: the MC versions of the maintained branches.
// Returns { weeks: [count, oldest first], releases, counts: { Fixes, Additions, Changes, translations }, streak }.
async function shipped(mods, mcs, now = Date.now()) {
  const weeks = Array(WEEKS).fill(0);
  const counts = { Fixes: 0, Additions: 0, Changes: 0, translations: 0 };
  let releases = 0;
  for (const mod of mods) {
    // From every checkout: a chain pushes each tag from the checkout of its own version.
    const tags = new Map();
    for (const dir of mod.dirs) {
      const out = await gitOrNull(dir, ['for-each-ref', '--format=%(refname:strip=2)%09%(creatordate:unix)', 'refs/tags']) || '';
      for (const line of out.split('\n').filter(Boolean)) {
        const [tag, unix] = line.split('\t');
        if (!tags.has(tag) && mcs.some(mc => tag.startsWith(`${mc}-`))) tags.set(tag, Number(unix) * 1000);
      }
    }
    // An entry released on several MC versions counts once.
    const seen = new Set();
    for (const [tag, date] of tags) {
      const age = now - date;
      if (age < 0 || age >= WEEKS * WEEK) continue;
      weeks[WEEKS - 1 - Math.floor(age / WEEK)]++;
      if (age >= RECENT_DAYS * DAY) continue;
      releases++;
      let text = null;
      for (const dir of mod.dirs) {
        text = await gitOrNull(dir, ['show', `${tag}:resources/changelog/${tag}.txt`]);
        if (text) break;
      }
      for (const entry of parseEntries(text)) {
        const key = entryKey(entry.text);
        if (seen.has(key)) continue;
        seen.add(key);
        if (/\btranslations?\b/i.test(entry.text)) counts.translations++;
        else counts[entry.section]++;
      }
    }
  }
  // Weeks in a row with a release, up to now; this week doesn't break it before it is over.
  let end = WEEKS - 1;
  if (!weeks[end]) end--;
  let streak = 0;
  while (end - streak >= 0 && weeks[end - streak]) streak++;
  return { weeks, releases, counts, streak, recentDays: RECENT_DAYS };
}

module.exports = { shipped, WEEKS, RECENT_DAYS };
