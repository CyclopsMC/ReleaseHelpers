'use strict';
// Throwaway git repos for end-to-end tests, isolated from the user's git config.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');

const hasCommand = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

function createSandbox(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // cc-release signs tags (git tag -s); a fake gpg makes that work without keys.
  const fakeGpg = path.join(dir, 'fake-gpg');
  fs.writeFileSync(fakeGpg, '#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED D 22 8 00 0 X" >&2\n'
    + 'printf -- "-----BEGIN PGP SIGNATURE-----\\nfake\\n-----END PGP SIGNATURE-----\\n"\n', { mode: 0o755 });
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n'
    + '[commit]\n\tgpgSign = false\n[tag]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n'
    + `[merge "ours"]\n\tdriver = true\n[gpg]\n\tprogram = ${fakeGpg}\n`);

  // Stand-ins: `open` must not launch apps; GNU sed is called gsed on macOS.
  const shims = path.join(dir, 'shims');
  fs.mkdirSync(shims);
  fs.writeFileSync(path.join(shims, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (!hasCommand('gsed') && spawnSync('sed', ['--version']).status === 0) {
    fs.writeFileSync(path.join(shims, 'gsed'), '#!/bin/sh\nexec sed "$@"\n', { mode: 0o755 });
  }

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${shims}${path.delimiter}${BIN}${path.delimiter}${process.env.PATH}`,
    NO_COLOR: '1',
    // Never your own marks.
    CC_HELPERS_MARKS: path.join(dir, 'marks.json'),
  };
  // Distinct, increasing commit dates keep `git log` order deterministic.
  let time = 1700000000;
  const dated = () => {
    time += 60;
    return { ...env, GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
  };

  const sb = {
    dir,
    env,
    path: (...p) => path.join(dir, ...p),
    git(cwd, ...args) {
      return execFileSync('git', args, { cwd, env: dated(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
    write(file, content) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    read: file => fs.readFileSync(file, 'utf8'),
    commit(cwd, message, files = {}) {
      for (const [f, content] of Object.entries(files)) sb.write(path.join(cwd, f), content);
      sb.git(cwd, 'add', '-A');
      sb.git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
    },
    // Bare origin plus a scratch clone to build history in.
    newMod(mod) {
      const origin = sb.path('origin', `${mod}.git`);
      const work = sb.path('work', mod);
      sb.git(dir, 'init', '-q', '--bare', origin);
      sb.git(dir, 'init', '-q', work);
      sb.git(work, 'remote', 'add', 'origin', origin);
      return work;
    },
    checkout(versionDir, mod, branch) {
      const target = sb.path(versionDir, mod);
      sb.git(dir, 'clone', '-q', '-b', branch, sb.path('origin', `${mod}.git`), target);
      return target;
    },
    // Runs a command, returning { code, out, err }.
    run(cmd, args, { cwd = dir, env: extra = {}, input } = {}) {
      const r = spawnSync(cmd, args, { cwd, env: { ...dated(), ...extra }, encoding: 'utf8', input });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return sb;
}

module.exports = { createSandbox, BIN };
