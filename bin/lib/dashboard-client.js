'use strict';
// Finds a running cc-dashboard, so a second one doesn't start and `cc-dashboard open` finds it.

const fs = require('fs');
const path = require('path');
const { stateDir, isAlive } = require('./lock');

const infoFile = () => path.join(stateDir(), 'dashboard.json');

function readInfo() {
  try {
    return JSON.parse(fs.readFileSync(infoFile(), 'utf8'));
  } catch (e) {
    return null;
  }
}

// Only readable by you, as it holds the token.
function writeInfo(info) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${infoFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, infoFile());
}

function removeInfo(pid) {
  const info = readInfo();
  if (info && info.pid === pid) fs.rmSync(infoFile(), { force: true });
}

// { pid, port, token, configFile } of the running dashboard (for this config, if given), or null.
function runningDashboard(configFile) {
  const info = readInfo();
  if (!info || !info.pid || !isAlive(info.pid)) return null;
  if (configFile && info.configFile !== configFile) return null;
  return info;
}

module.exports = { readInfo, writeInfo, removeInfo, runningDashboard, infoFile };
