'use strict';
// What the dashboard's buttons do: mark commits, and start release chains or tools in a terminal.

const path = require('path');
const { gitOrNull } = require('./git');
const { setMark, clearMark } = require('./marks');
const { terminalCommand, ideCommand, launch, shellQuote } = require('./terminal');

const HASH = /^[0-9a-f]{7,40}$/;
const CHAIN_BIN = path.join(__dirname, '..', 'cc-release-chain');

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function createActions(monitor, { launcher = launch } = {}) {
  const knownMod = mod => {
    if (!monitor.found.mods.includes(mod)) throw badRequest(`Unknown mod ${mod}`);
    return mod;
  };
  // The checkout of a mod for a version name, or its first one.
  const checkoutDir = (mod, version) => {
    const dirs = monitor.modDirs(knownMod(mod));
    if (!version) return dirs[0];
    const v = monitor.config.versions.find(x => x.name === version);
    const dir = v && dirs.find(d => path.dirname(d) === v.dir);
    if (!dir) throw badRequest(`${mod} has no checkout for ${version}`);
    return dir;
  };

  return {
    // { mod, hash, release: true | false | null }; null clears the mark.
    async mark({ mod, hash, release }) {
      if (!HASH.test(String(hash))) throw badRequest('Bad commit hash');
      let commit = null;
      for (const dir of monitor.modDirs(knownMod(mod))) {
        const out = await gitOrNull(dir, ['show', '-s', '--format=%H%x1f%s', `${hash}^{commit}`]);
        if (out) {
          const [full, subject] = out.split('\x1f');
          commit = { full, subject };
          break;
        }
      }
      if (!commit) throw badRequest(`Commit ${hash} not found in ${mod}`);
      if (release === null || release === undefined) clearMark(commit.full);
      else setMark(commit.full, { release: !!release, subject: commit.subject, mod, reason: 'marked in cc-dashboard' });
      monitor.reload();
      await monitor.request('local');
      return { ok: true, hash: commit.full };
    },

    // { mod, rehearse, confirm }: runs cc-release-chain in a new terminal.
    async chain({ mod, rehearse = false, confirm = false }) {
      const snap = monitor.snapshot().mods.find(m => m.name === knownMod(mod));
      const start = snap && snap.start >= 0 ? monitor.config.versions[snap.start].name : null;
      const flags = [rehearse ? '--rehearse' : null, confirm ? '--confirm' : null].filter(Boolean);
      const command = [shellQuote(CHAIN_BIN), ...flags, shellQuote(mod)].join(' ');
      await launcher(terminalCommand(monitor.config, checkoutDir(mod, start), command));
      return { ok: true };
    },

    // { mod, version }: a terminal in that checkout.
    async terminal({ mod, version }) {
      await launcher(terminalCommand(monitor.config, checkoutDir(mod, version), null));
      return { ok: true };
    },

    // { mod, version }: the checkout in your IDE.
    async ide({ mod, version }) {
      const argv = ideCommand(monitor.config, checkoutDir(mod, version));
      if (!argv) throw badRequest('Set "dashboard": { "ide": [...] } in the config, e.g. ["idea", "{dir}"]');
      await launcher(argv);
      return { ok: true };
    },
  };
}

module.exports = { createActions };
