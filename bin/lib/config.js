'use strict';
// Loads the cc-helpers config: $CC_HELPERS_CONFIG or ~/.config/cc-helpers.json.

const fs = require('fs');
const os = require('os');
const path = require('path');

function configPath() {
  return process.env.CC_HELPERS_CONFIG || path.join(os.homedir(), '.config', 'cc-helpers.json');
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadConfig() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Can't read ${file}. Copy cc-helpers.example.json from ReleaseHelpers to get started.`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
  if (!Array.isArray(json.versions) || json.versions.length === 0) {
    throw new Error(`${file}: "versions" must be a non-empty list, ordered from lowest to highest MC version`);
  }
  const versions = json.versions.map((v, i) => {
    if (!v || typeof v.dir !== 'string' || typeof v.branch !== 'string') {
      throw new Error(`${file}: versions[${i}] needs a "dir" and a "branch"`);
    }
    return {
      ...v,
      index: i,
      dir: path.resolve(expandHome(v.dir)),
      name: v.name || v.branch.replace(/^master-/, ''),
    };
  });
  const names = versions.map(v => v.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`${file}: version name "${dup}" is used twice`);
  const devOnlyPaths = (json.devOnlyPaths || []).map(r => {
    try {
      return new RegExp(r);
    } catch (e) {
      throw new Error(`${file}: invalid regex in "devOnlyPaths": ${r}`);
    }
  });
  const ignoreCommits = (json.ignoreCommits || []).map(h => String(h).trim().toLowerCase());
  const bad = ignoreCommits.find(h => !/^[0-9a-f]{7,40}$/.test(h));
  if (bad !== undefined) throw new Error(`${file}: "ignoreCommits" needs commit hashes of at least 7 characters, not "${bad}"`);
  return { ...json, file, versions, devOnlyPaths, ignoreCommits, commitFilter: { devOnlyPaths, ignoreCommits } };
}

module.exports = { loadConfig, configPath };
