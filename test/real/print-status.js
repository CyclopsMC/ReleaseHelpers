'use strict';
// Prints the status of all mods, as cc-dashboard computes it, for the replay of real release rounds.

const { loadConfig } = require('../../bin/lib/config');
const { discoverMods, computeStatus, isUpmergeOnly, modWork, cellText } = require('../../bin/lib/status');

(async () => {
  const config = loadConfig();
  const found = discoverMods(config);
  const status = await computeStatus(config, found, { fetch: true });
  const header = ['', ...config.versions.map(v => v.name)];
  const rows = found.mods.map(m => [m, ...status[m].map(c => cellText(c, isUpmergeOnly(status[m])))]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = r => r.map((x, i) => (i ? x.padStart(widths[i] + 2) : x.padEnd(widths[0]))).join('');
  console.log(line(header));
  rows.forEach(r => console.log(line(r)));
  for (const m of found.mods) {
    const { start, group } = modWork(status[m]);
    if (group) console.log(`\n${m}: ${group}, starting at ${config.versions[start].name}`);
  }
  const errors = found.mods.flatMap(m => status[m].filter(c => c.error).map(c => `${m}: ${c.error}`));
  if (errors.length) {
    console.log(`\nErrors:\n${errors.join('\n')}`);
    process.exitCode = 1;
  }
})();
