'use strict';
// Replays real release rounds of Cyclops mods with `cc-release-chain --rehearse`, starting from
// the commits just before each round. Only Gradle, Claude, the editor and GPG are stand-ins.
// Needs network access (clones from GitHub). Run with: node --test test/real/*.test.js
// After an intended change to drafts or cc-status: UPDATE_SNAPSHOTS=1 node --test test/real/*.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSandbox } = require('../helpers');

// Each version: the branch head just before the round, and the release that was made from it.
const ROUNDS = [
  {
    // A fix released on 1.20, 1.21 and 26.1.2 on 2026-09-05.
    mod: 'IntegratedScripting',
    versions: [
      { dir: 'mc20-lts', branch: 'master-1.20-lts', head: '4f864d52d73b2d97fef291beea4cbbe1aaba9e6f', release: '1.20.1-1.0.19' },
      { dir: 'mc21-lts', branch: 'master-1.21-lts', head: '79ac86d67f944fd15a0cfb5cff6b7e262ff9a41f', release: '1.21.1-1.0.27' },
      { dir: 'mc26-lts', branch: 'master-26-lts', head: '88d8224fbe3d913f5e659d38a6840cdb9cd02f05', release: '26.1.2-1.0.28' },
    ],
  },
  {
    // Released on 1.21 and 26.1.2 on 2026-06-14; compiles the CommonCapabilitiesAPI submodule.
    mod: 'CommonCapabilities',
    submodule: 'src/main/java/org/cyclops/commoncapabilities/api',
    versions: [
      { dir: 'mc21-lts', branch: 'master-1.21-lts', head: '939b39ff1813fc8359a1655d3ada77807dc8a710', release: '1.21.1-2.11.5' },
      { dir: 'mc26-lts', branch: 'master-26-lts', head: 'ca3972f3b078bd7b4493aca0d72cd83b74683d1d', release: '26.1.2-2.11.8' },
    ],
  },
];

const TOOLS = {
  build: '#!/bin/sh\nexit 0\n',
  review: '#!/bin/sh\necho "Verdict: fine"\n',
  upmerge: '#!/bin/sh\ngit diff --name-only --diff-filter=U | xargs git checkout --theirs --\ngit add -A\ngit commit -q --no-edit\n',
  fix: '#!/bin/sh\nexit 0\n',
  // Keeps the draft for comparison, then "edits" it into what was published for that MC version.
  editor: '#!/bin/sh\nrepo=$(dirname "$(dirname "$(dirname "$1")")")\n'
    + 'mc=$(grep "^minecraft_version=" "$repo/gradle.properties" | cut -d= -f2)\n'
    + 'cp "$1" "$CC_DRAFTS/$mc.txt"\ncp "$CC_PUBLISHED/$mc.txt" "$1"\n',
};

const SNAPSHOTS = path.join(__dirname, 'snapshots');
const cacheDir = process.env.CC_REAL_REPOS_DIR || path.join(os.tmpdir(), 'cc-helpers-real-repos');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lines = out => out.split('\n').filter(Boolean);

// A full clone of the mod, cached between runs.
function source(mod, heads) {
  const dir = path.join(cacheDir, mod);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    git(cacheDir, 'clone', '--quiet', '--no-checkout', `https://github.com/CyclopsMC/${mod}`, dir);
  }
  if (heads.some(h => { try { git(dir, 'cat-file', '-e', `${h}^{commit}`); return false; } catch (e) { return true; } })) {
    git(dir, 'fetch', '--quiet', '--tags', 'origin');
  }
  return dir;
}

function versionPart(a, b) {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  return x[0] !== y[0] ? 'j' : x[1] !== y[1] ? 'm' : 'p';
}

function checkSnapshot(name, actual) {
  const file = path.join(SNAPSHOTS, name);
  if (process.env.UPDATE_SNAPSHOTS) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  assert.ok(fs.existsSync(file), `missing snapshot ${file}; create it with UPDATE_SNAPSHOTS=1`);
  assert.strictEqual(actual, fs.readFileSync(file, 'utf8'), `${name} changed; if intended, update with UPDATE_SNAPSHOTS=1`);
}

let sb;
afterEach(() => sb && sb.cleanup());

for (const round of ROUNDS) {
  test(`replays the ${round.versions.map(v => v.release).join(', ')} releases of ${round.mod}`, () => {
    sb = createSandbox(`cc-real-${round.mod}-`);
    const { mod, versions } = round;
    const src = source(mod, versions.map(v => v.head));
    const props = (rev, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(git(src, 'show', `${rev}:gradle.properties`))[1].trim();

    // Stand-in for GitHub at the time: the pinned branch heads and the tags they contain.
    const github = sb.path('github', `${mod}.git`);
    sb.git(sb.dir, 'init', '--quiet', '--bare', github);
    const tags = new Set(versions.flatMap(v => lines(git(src, 'tag', '--merged', v.head))));
    git(src, 'push', '--quiet', github, ...versions.map(v => `${v.head}:refs/heads/${v.branch}`));
    git(src, 'push', '--quiet', github, ...[...tags].map(t => `refs/tags/${t}:refs/tags/${t}`));
    sb.git(github, 'symbolic-ref', 'HEAD', `refs/heads/${versions[0].branch}`);

    // Checkouts like the real ones, with submodules from GitHub.
    versions.forEach((v, i) => {
      const repo = sb.path(v.dir, mod);
      sb.git(sb.dir, 'clone', '--quiet', '-b', v.branch, github, repo);
      sb.git(repo, 'submodule', '--quiet', 'update', '--init', '--recursive');
      if (i > 0) sb.write(sb.path(v.dir, '.upmerge-src-branch'), `${versions[i - 1].branch}\n`);
    });
    const tool = name => {
      const file = sb.path('tools', name);
      sb.write(file, TOOLS[name]);
      fs.chmodSync(file, 0o755);
      return file;
    };
    sb.write(sb.path('cc-helpers.json'), JSON.stringify({
      versions: versions.map(v => ({ dir: sb.path(v.dir), branch: v.branch })),
      build: [tool('build')],
      editor: tool('editor'),
      notify: false,
      claude: { review: [tool('review')], upmerge: [tool('upmerge')], fix: [tool('fix')] },
    }));
    fs.mkdirSync(sb.path('drafts'));
    for (const v of versions) {
      sb.write(sb.path('published', `${props(v.release, 'minecraft_version')}.txt`),
        git(src, 'show', `${v.release}:resources/changelog/${v.release}.txt`));
    }
    const env = {
      CC_HELPERS_CONFIG: sb.path('cc-helpers.json'),
      CC_HELPERS_STATE_DIR: sb.path('state'),
      CC_DRAFTS: sb.path('drafts'),
      CC_PUBLISHED: sb.path('published'),
    };

    const status = sb.run('cc-status', [], { env });
    assert.strictEqual(status.code, 0, status.out + status.err);
    checkSnapshot(`${mod}/cc-status.txt`, status.out);

    const before = sb.git(github, 'for-each-ref');
    const heads = versions.map(v => sb.git(sb.path(v.dir, mod), 'rev-parse', 'HEAD'));
    // Start, then the bump that was really chosen for each version.
    const answers = ['y', ...versions.map(v => versionPart(props(v.head, 'mod_version'), props(v.release, 'mod_version')))];
    const r = sb.run('cc-release-chain', ['--rehearse', mod], { env, input: `${answers.join('\n')}\n` });
    assert.strictEqual(r.code, 0, r.out + r.err);

    // Nothing reached "GitHub" or the checkouts.
    assert.strictEqual(sb.git(github, 'for-each-ref'), before);
    assert.deepStrictEqual(versions.map(v => sb.git(sb.path(v.dir, mod), 'rev-parse', 'HEAD')), heads);

    // The rehearsal made the same releases as were really made.
    const [rehearsal] = fs.readdirSync(sb.path('state', 'rehearsals'));
    const root = sb.path('state', 'rehearsals', rehearsal);
    const standIn = path.join(root, 'origin', `${mod}.git`);
    for (const v of versions) {
      const mc = props(v.release, 'minecraft_version');
      assert.strictEqual(sb.git(standIn, 'show', `refs/tags/${v.release}:resources/changelog/${v.release}.txt`),
        sb.read(sb.path('published', `${mc}.txt`)), `changelog of ${v.release}`);
      assert.match(sb.git(standIn, 'show', `refs/tags/${v.release}:gradle.properties`), new RegExp(`^mod_version=${props(v.release, 'mod_version')}$`, 'm'));
      checkSnapshot(`${mod}/draft-${mc}.txt`, sb.read(sb.path('drafts', `${mc}.txt`)));
    }
    versions.slice(1).forEach((v, i) => {
      assert.match(sb.git(standIn, 'log', '--format=%s', `refs/tags/${v.release}`, '-3'),
        new RegExp(`^Merge remote-tracking branch 'origin/${versions[i].branch}' into ${v.branch}$`, 'm'), `upmerge into ${v.branch}`);
    });
    if (round.submodule) {
      for (const v of versions) {
        assert.ok(fs.readdirSync(path.join(root, v.dir, mod, round.submodule)).length > 0, `submodule in the ${v.dir} copy`);
      }
    }
  });
}
