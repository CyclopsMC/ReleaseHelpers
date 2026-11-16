'use strict';
// Finds a running cc-dashboard and talks to it (used by cc-status and cc-dashboard itself).

const fs = require('fs');
const http = require('http');
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

function call(info, method, pathname, body, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: info.port,
      method,
      path: pathname,
      headers: { 'Content-Type': 'application/json', 'X-CC-Token': info.token, Host: `127.0.0.1:${info.port}` },
      timeout: timeoutMs,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          // Not JSON.
        }
        if (res.statusCode >= 400) reject(new Error((json && json.error) || `HTTP ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('the dashboard did not answer in time')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

module.exports = { readInfo, writeInfo, removeInfo, runningDashboard, call, infoFile };
