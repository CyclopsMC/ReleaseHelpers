'use strict';
// Replays real release rounds of Cyclops mods with `cc-release-chain --rehearse`, starting from
// the commits just before each round. Only Gradle, Claude, the editor and GPG are stand-ins.
// Needs network access (clones from GitHub). Prints a transcript of the commands and their output.
// Run with: node --test --test-reporter=spec test/real/*.test.js
// After an intended change to drafts or cc-status: UPDATE_SNAPSHOTS=1 node --test --test-reporter=spec test/real/*.test.js
// Set CC_REAL_REPOS_DIR to keep the clones between runs.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSandbox } = require('../helpers');

// Each version: the branch head just before the round, the release that was made from it, and
// for higher versions the real upmerge commit of the round.
const ROUNDS = [
  {
    // A fix released on 1.20, 1.21 and 26.1.2.
    mod: 'IntegratedScripting',
    date: '2026-09-05',
    versions: [
      { dir: 'mc20-lts', branch: 'master-1.20-lts', head: '4f864d52d73b2d97fef291beea4cbbe1aaba9e6f', release: '1.20.1-1.0.19' },
      { dir: 'mc21-lts', branch: 'master-1.21-lts', head: '79ac86d67f944fd15a0cfb5cff6b7e262ff9a41f', release: '1.21.1-1.0.27',
        upmerge: 'af84db7dcd17bca38832203910c25b5653789da6' },
      { dir: 'mc26-lts', branch: 'master-26-lts', head: '88d8224fbe3d913f5e659d38a6840cdb9cd02f05', release: '26.1.2-1.0.28',
        upmerge: 'b27118481f98fd778e5cca0fbf47615b75d5c9a7' },
    ],
  },
  {
    // Released on 1.21 and 26.1.2; compiles the CommonCapabilitiesAPI submodule.
    mod: 'CommonCapabilities',
    date: '2026-06-14',
    submodule: 'src/main/java/org/cyclops/commoncapabilities/api',
    versions: [
      { dir: 'mc21-lts', branch: 'master-1.21-lts', head: '939b39ff1813fc8359a1655d3ada77807dc8a710', release: '1.21.1-2.11.5' },
      { dir: 'mc26-lts', branch: 'master-26-lts', head: 'ca3972f3b078bd7b4493aca0d72cd83b74683d1d', release: '26.1.2-2.11.8',
        upmerge: 'bf93d38be9169e5cb1ad3d3c43d34b9c9180e1ae' },
    ],
  },
];

// The stand-ins say what they stand in for, so the transcript is clear about it.
const TOOLS = {
  build: '#!/bin/sh\necho "[stand-in for the Gradle build, GRADLE_OPTS=$GRADLE_OPTS]"\n',
  review: '#!/bin/sh\necho "[stand-in for the Claude review: no changes]"\n',
  // Finishes the upmerge as it was really done: conflicts resolved, plus any other fixes made in the
  // real upmerge commit. Generated CHANGELOG*.md files are left as merged.
  upmerge: '#!/bin/sh\nbranch=$(git symbolic-ref --short HEAD)\n'
    + 'echo "[stand-in for claude upmerge: finishing the upmerge into $branch as it was really done]"\n'
    + 'git fetch -q "$CC_GITHUB" "refs/replay/upmerge-$branch"\n'
    + 'conflicts=$(git diff --name-only --diff-filter=U)\n'
    + 'for f in $(git diff --name-only FETCH_HEAD -- . ":(exclude)CHANGELOG*.md") $conflicts; do\n'
    + '  case " $done " in *" $f "*) continue ;; esac\n  done="$done $f"\n'
    + '  case " $(echo $conflicts) " in *" $f "*) why="conflict" ;; *) why="also changed in the real upmerge" ;; esac\n'
    + '  if git cat-file -e "FETCH_HEAD:$f" 2>/dev/null; then git checkout FETCH_HEAD -- "$f"; else git rm -q -- "$f"; fi\n'
    + '  echo "    $f: taken from the real upmerge commit ($why)"\n'
    + 'done\ngit commit -q --no-edit\n',
  fix: '#!/bin/sh\necho "[stand-in for Claude fixing the build: no changes]"\n',
  // Keeps the draft for comparison, then "edits" it into what was published for that MC version.
  editor: '#!/bin/sh\nrepo=$(dirname "$(dirname "$(dirname "$1")")")\n'
    + 'mc=$(grep "^minecraft_version=" "$repo/gradle.properties" | cut -d= -f2)\n'
    + 'echo "[stand-in editor] received this draft for $mc:"\nsed "s/^/    | /" "$1"\n'
    + 'cp "$1" "$CC_DRAFTS/$mc.txt"\ncp "$CC_PUBLISHED/$mc.txt" "$1"\n'
    + 'echo "[stand-in editor] replaced it with the changelog that was published for $mc"\n',
};

const SNAPSHOTS = path.join(__dirname, 'snapshots');
const cacheDir = process.env.CC_REAL_REPOS_DIR || path.join(os.tmpdir(), 'cc-helpers-real-repos');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lines = out => out.split('\n').filter(Boolean);

// --- Transcript: the commands, their output and the checks, in GitHub Actions as collapsible groups.

const inActions = process.env.GITHUB_ACTIONS === 'true';
let shorten = text => text;
const print = text => process.stdout.write(`${text}\n`);

function group(title, body) {
  const text = shorten(body).replace(/\s+$/, '') || '(no output)';
  print(inActions ? `::group::${shorten(title)}\n${text}\n::endgroup::` : `\n--- ${shorten(title)}\n${text}`);
}

const shellWord = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
function commandLine(cmd, args) {
  const shown = args.length > 8 ? [...args.slice(0, 4), `... (${args.length - 4} more)`] : args;
  return [cmd, ...shown].map(shellWord).join(' ');
}

// Runs a command in the sandbox and records it with its output.
function sh(log, cwd, cmd, args, opts = {}) {
  const r = sb.run(cmd, args, { cwd, ...opts });
  log.push(`$ cd ${cwd} && ${commandLine(cmd, args)}`);
  const out = `${r.out || ''}${r.err || ''}`.trimEnd();
  if (out) log.push(out);
  if (r.code !== 0) log.push(`(exit code ${r.code})`);
  return r;
}

// Runs a cc-* command with stderr merged into stdout, so the transcript keeps the real order.
function runMerged(cmd, args, opts) {
  return sb.run('sh', ['-c', 'exec "$0" "$@" 2>&1', cmd, ...args], opts);
}

function check(description, fn) {
  try {
    fn();
  } catch (e) {
    print(`  FAILED  ${description}`);
    throw e;
  }
  print(`  ok  ${description}`);
}

// A full clone of the mod, cached between runs.
function source(log, mod, heads) {
  const dir = path.join(cacheDir, mod);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    assert.strictEqual(sh(log, cacheDir, 'git', ['clone', '--quiet', '--no-checkout', `https://github.com/CyclopsMC/${mod}`, dir]).code, 0);
  } else {
    log.push(`(using the cached clone in ${dir})`);
  }
  if (heads.some(h => { try { git(dir, 'cat-file', '-e', `${h}^{commit}`); return false; } catch (e) { return true; } })) {
    assert.strictEqual(sh(log, dir, 'git', ['fetch', '--quiet', '--tags', 'origin']).code, 0);
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
  const releases = round.versions.map(v => v.release).join(', ');
  test(`replays the ${releases} releases of ${round.mod}`, () => {
    sb = createSandbox(`cc-real-${round.mod}-`);
    const real = fs.realpathSync(sb.dir);
    shorten = text => text.split(real).join('<sandbox>').split(sb.dir).join('<sandbox>').split(cacheDir).join('<cache>');
    const { mod, versions } = round;
    print(`\n=== Replaying the ${round.date} release round of ${mod}: ${releases}`);

    const setup = [];
    const src = source(setup, mod, versions.map(v => v.head));
    const props = (rev, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(git(src, 'show', `${rev}:gradle.properties`))[1].trim();
    const ok = r => assert.strictEqual(r.code, 0, setup.join('\n'));

    // Stand-in for GitHub at the time: the pinned branch heads and the tags they contain.
    const github = sb.path('github', `${mod}.git`);
    ok(sh(setup, sb.dir, 'git', ['init', '--quiet', '--bare', github]));
    const tags = [...new Set(versions.flatMap(v => lines(git(src, 'tag', '--merged', v.head))))];
    ok(sh(setup, src, 'git', ['push', '--quiet', github, ...versions.map(v => `${v.head}:refs/heads/${v.branch}`)]));
    ok(sh(setup, src, 'git', ['push', '--quiet', github, ...tags.map(t => `refs/tags/${t}:refs/tags/${t}`)]));
    ok(sh(setup, github, 'git', ['symbolic-ref', 'HEAD', `refs/heads/${versions[0].branch}`]));
    // The real upmerge commits, under refs the checkouts don't fetch, for the upmerge stand-in.
    const upmerges = versions.filter(v => v.upmerge);
    ok(sh(setup, src, 'git', ['push', '--quiet', github, ...upmerges.map(v => `${v.upmerge}:refs/replay/upmerge-${v.branch}`)]));

    // Checkouts like the real ones, with submodules from GitHub.
    versions.forEach((v, i) => {
      const repo = sb.path(v.dir, mod);
      ok(sh(setup, sb.dir, 'git', ['clone', '--quiet', '-b', v.branch, github, repo]));
      ok(sh(setup, repo, 'git', ['submodule', '--quiet', 'update', '--init', '--recursive']));
      if (i > 0) {
        sb.write(sb.path(v.dir, '.upmerge-src-branch'), `${versions[i - 1].branch}\n`);
        setup.push(`(wrote ${sb.path(v.dir, '.upmerge-src-branch')}: ${versions[i - 1].branch})`);
      }
    });
    const tool = name => {
      const file = sb.path('tools', name);
      sb.write(file, TOOLS[name]);
      fs.chmodSync(file, 0o755);
      return file;
    };
    const config = {
      versions: versions.map(v => ({ dir: sb.path(v.dir), branch: v.branch })),
      build: [tool('build')],
      editor: tool('editor'),
      notify: false,
      claude: { review: [tool('review')], upmerge: [tool('upmerge')], fix: [tool('fix')] },
    };
    sb.write(sb.path('cc-helpers.json'), JSON.stringify(config));
    setup.push(`(wrote the config ${sb.path('cc-helpers.json')}:)`, JSON.stringify(config, null, 2));
    fs.mkdirSync(sb.path('drafts'));
    for (const v of versions) {
      sb.write(sb.path('published', `${props(v.release, 'minecraft_version')}.txt`),
        git(src, 'show', `${v.release}:resources/changelog/${v.release}.txt`));
    }
    setup.push(`(saved the published changelogs of ${releases} for the editor stand-in)`);
    group(`Setup: a stand-in for GitHub as of ${round.date} (${versions.length} branches, ${tags.length} tags), and checkouts from it`, setup.join('\n'));

    const env = {
      CC_HELPERS_CONFIG: sb.path('cc-helpers.json'),
      CC_HELPERS_STATE_DIR: sb.path('state'),
      CC_DRAFTS: sb.path('drafts'),
      CC_PUBLISHED: sb.path('published'),
      CC_GITHUB: github,
    };
    const status = runMerged('cc-status', [], { env });
    group('$ cc-status', status.out);

    const before = sb.git(github, 'for-each-ref');
    const heads = versions.map(v => sb.git(sb.path(v.dir, mod), 'rev-parse', 'HEAD'));
    // Start, then the bump that was really chosen for each version.
    const answers = ['y', ...versions.map(v => versionPart(props(v.head, 'mod_version'), props(v.release, 'mod_version')))];
    const r = runMerged('cc-release-chain', ['--rehearse', mod], { env, input: `${answers.join('\n')}\n` });
    group(`$ cc-release-chain --rehearse ${mod}   (answers typed: ${answers.join(', ')})`, r.out);

    print('Checks:');
    check('cc-status exits successfully', () => assert.strictEqual(status.code, 0));
    check('cc-status output matches the snapshot', () => checkSnapshot(`${mod}/cc-status.txt`, status.out));
    check('cc-release-chain --rehearse exits successfully', () => assert.strictEqual(r.code, 0));
    check('nothing was pushed to the stand-in for GitHub', () => assert.strictEqual(sb.git(github, 'for-each-ref'), before));
    check('the checkouts were not changed', () => {
      assert.deepStrictEqual(versions.map(v => sb.git(sb.path(v.dir, mod), 'rev-parse', 'HEAD')), heads);
    });

    // The rehearsal made the same releases as were really made.
    const [rehearsal] = fs.readdirSync(sb.path('state', 'rehearsals'));
    const root = sb.path('state', 'rehearsals', rehearsal);
    const standIn = path.join(root, 'origin', `${mod}.git`);
    for (const v of versions) {
      const mc = props(v.release, 'minecraft_version');
      check(`the rehearsal tagged ${v.release} with the published changelog`, () => {
        assert.strictEqual(sb.git(standIn, 'show', `refs/tags/${v.release}:resources/changelog/${v.release}.txt`),
          sb.read(sb.path('published', `${mc}.txt`)));
      });
      check(`${v.release} has mod_version ${props(v.release, 'mod_version')}`, () => {
        assert.match(sb.git(standIn, 'show', `refs/tags/${v.release}:gradle.properties`), new RegExp(`^mod_version=${props(v.release, 'mod_version')}$`, 'm'));
      });
      check(`the ${mc} draft matches the snapshot`, () => checkSnapshot(`${mod}/draft-${mc}.txt`, sb.read(sb.path('drafts', `${mc}.txt`))));
    }
    versions.slice(1).forEach((v, i) => {
      const copy = path.join(root, v.dir, mod);
      check(`${versions[i].branch} was upmerged into ${v.branch}`, () => {
        assert.match(sb.git(copy, 'log', '--format=%s', `refs/tags/${v.release}`, '-3'),
          new RegExp(`^Merge remote-tracking branch 'origin/${versions[i].branch}' into ${v.branch}$`, 'm'));
      });
      check(`the upmerge into ${v.branch} gives the same files as the real one (apart from generated CHANGELOG-*.md)`, () => {
        const merge = sb.git(copy, 'log', '--merges', '-1', '--format=%H', `refs/tags/${v.release}`).trim();
        sb.git(copy, 'fetch', '-q', github, `refs/replay/upmerge-${v.branch}`);
        assert.strictEqual(sb.git(copy, 'diff', '--name-only', 'FETCH_HEAD', merge, '--', '.', ':(exclude)CHANGELOG-*.md'), '');
      });
    });
    if (round.submodule) {
      for (const v of versions) {
        check(`the ${v.dir} copy has the ${round.submodule} submodule`, () => {
          assert.ok(fs.readdirSync(path.join(root, v.dir, mod, round.submodule)).length > 0);
        });
      }
    }
  });
}
