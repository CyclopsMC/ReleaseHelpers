'use strict';
// Where running release chains are, for cc-dashboard: one small JSON file per chain.

const fs = require('fs');
const path = require('path');
const { stateDir, isAlive } = require('./lock');

const chainsDir = () => path.join(stateDir(), 'chains');

class ChainProgress {
  constructor(mod, { rehearsal = false, versions = [] } = {}) {
    this.file = path.join(chainsDir(), `${mod}${rehearsal ? '.rehearsal' : ''}.json`);
    const now = new Date().toISOString();
    this.data = { pid: process.pid, mod, rehearsal, versions, version: null, step: 'starting', waiting: null, startedAt: now, updatedAt: now };
    this.write();
    process.on('exit', () => this.remove());
  }

  update(changes) {
    Object.assign(this.data, changes, { updatedAt: new Date().toISOString() });
    this.write();
  }

  step(version, step) {
    this.update({ version, step, waiting: null });
  }

  // What the chain waits for you for (a question, your editor, Claude), or null.
  waiting(what) {
    this.update({ waiting: what || null });
  }

  write() {
    try {
      fs.mkdirSync(chainsDir(), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Progress is only informative.
    }
  }

  remove() {
    try {
      if (JSON.parse(fs.readFileSync(this.file, 'utf8')).pid === process.pid) fs.rmSync(this.file, { force: true });
    } catch (e) {
      // Already gone.
    }
  }
}

// The running chains, { [mod]: [progress] }; files of chains that died are removed.
function readChains() {
  const chains = {};
  let names = [];
  try {
    names = fs.readdirSync(chainsDir()).filter(n => n.endsWith('.json'));
  } catch (e) {
    return chains;
  }
  for (const name of names) {
    const file = path.join(chainsDir(), name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isAlive(data.pid)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      (chains[data.mod] = chains[data.mod] || []).push(data);
    } catch (e) {
      // Being written.
    }
  }
  return chains;
}

module.exports = { ChainProgress, readChains, chainsDir };
