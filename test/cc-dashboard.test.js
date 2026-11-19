'use strict';
// End-to-end tests of cc-dashboard: a real server on throwaway repos, driven over HTTP.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createSandbox } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin');
let sb;
let daemon;
let daemonOut = '';
let info;

const props = (mc, mod) => `mod_version=${mod}\nminecraft_version=${mc}\n`;

function request(method, pathname, { headers = {}, body, port = info.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const post = (pathname, body, headers = {}) => request('POST', pathname, { body, headers: { 'X-CC-Token': info.token, ...headers } });
const state = async () => (await request('GET', '/api/state')).json();
const texts = (s, mod) => s.mods.find(m => m.name === mod).cells.map(c => c.text || (c.missing ? '-' : '?'));

async function waitFor(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}\n${daemonOut}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const waitForTexts = (mod, expected) => waitFor(async () => {
  const s = await state();
  return !s.mods.some(m => m.loading) && JSON.stringify(texts(s, mod)) === JSON.stringify(expected) && s;
}, `${mod} to show ${expected.join(' ')}`);

function startDaemon(args = []) {
  const child = spawn(process.execPath, [path.join(BIN, 'cc-dashboard'), '--port', '0', ...args], { env: sb.env });
  child.stdout.on('data', d => { daemonOut += d; });
  child.stderr.on('data', d => { daemonOut += d; });
  return child;
}

before(async () => {
  sb = createSandbox('cc-dashboard-test-');
  sb.env.CC_HELPERS_CONFIG = sb.path('cc-helpers.json');
  const w = sb.newMod('ModA');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.20-lts');
  sb.commit(w, 'Initial', { 'gradle.properties': props('1.20.1', '1.0.0'), 'src/main/java/A.java': 'a' });
  sb.git(w, 'tag', '1.20.1-1.0.0');
  sb.git(w, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(w, 'Port to 1.21', { 'gradle.properties': props('1.21.1', '2.0.0') });
  sb.git(w, 'tag', '1.21.1-2.0.0');
  sb.git(w, 'checkout', '-q', 'master-1.20-lts');
  sb.commit(w, 'Fix crash', { 'src/main/java/A.java': 'a2' });
  sb.git(w, 'push', '-q', '--tags', 'origin', 'master-1.20-lts', 'master-1.21-lts');
  const b = sb.newMod('ModB');
  sb.git(b, 'checkout', '-q', '-b', 'master-1.21-lts');
  // ModB depends on ModA, and Addon on ModB.
  sb.commit(b, 'Initial', { 'gradle.properties': `${props('1.21.1', '1.0.0')}moda_version=1.0.0\n`, 'src/main/java/B.java': 'b' });
  sb.git(b, 'tag', '1.21.1-1.0.0');
  sb.git(b, 'push', '-q', '--tags', 'origin', 'master-1.21-lts');
  const addon = sb.newMod('Addon');
  sb.git(addon, 'checkout', '-q', '-b', 'master-1.21-lts');
  sb.commit(addon, 'Initial', { 'gradle.properties': `${props('1.21.1', '1.0.0')}modb_version=1.0.0\n`, 'src/main/java/C.java': 'c' });
  sb.git(addon, 'tag', '1.21.1-1.0.0');
  sb.git(addon, 'push', '-q', '--tags', 'origin', 'master-1.21-lts');
  sb.checkout('mc21-lts', 'Addon', 'master-1.21-lts');
  // Stand-ins for a terminal and an IDE, which log what they were asked to open.
  for (const tool of ['fake-terminal', 'fake-ide']) {
    sb.write(sb.path('shims', tool), `#!/bin/sh\necho "$@" >> '${sb.path(`${tool}.log`)}'\n`);
    fs.chmodSync(sb.path('shims', tool), 0o755);
  }
  sb.checkout('mc20-lts', 'ModA', 'master-1.20-lts');
  sb.checkout('mc21-lts', 'ModA', 'master-1.21-lts');
  sb.checkout('mc21-lts', 'ModB', 'master-1.21-lts');
  sb.write(sb.path('mc21-lts', '.upmerge-src-branch'), 'master-1.20-lts\n');
  // Without GitHub, and without periodic refreshes, so only watchers and requests update it.
  sb.write(sb.env.CC_HELPERS_CONFIG, JSON.stringify({
    versions: [
      { dir: sb.path('mc20-lts'), branch: 'master-1.20-lts' },
      { dir: sb.path('mc21-lts'), branch: 'master-1.21-lts' },
    ],
    github: false,
    dashboard: {
      localInterval: 3600,
      remoteInterval: 3600,
      terminal: [sb.path('shims', 'fake-terminal'), '{cmd}'],
      ide: [sb.path('shims', 'fake-ide'), '{dir}'],
    },
  }));

  daemon = startDaemon();
  const infoFile = sb.path('state', 'dashboard.json');
  info = await waitFor(() => fs.existsSync(infoFile) && JSON.parse(fs.readFileSync(infoFile, 'utf8')), 'the dashboard to start');
});

after(() => {
  if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL');
});

test('serves the page and the status of every mod', async () => {
  const page = await request('GET', '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, new RegExp(`<meta name="cc-token" content="${info.token}">`));
  assert.strictEqual((await request('GET', '/app.js')).status, 200);
  const s = await waitForTexts('ModA', ['1', '↑1']);
  assert.deepStrictEqual(texts(s, 'ModB'), ['-', '.']);
  assert.deepStrictEqual(s.versions.map(v => v.name), ['1.20-lts', '1.21-lts']);
  const modA = s.mods.find(m => m.name === 'ModA');
  assert.strictEqual(modA.group, 'todo');
  assert.strictEqual(modA.start, 0);
  assert.strictEqual(modA.cells[0].unreleased.userFacing[0].subject, 'Fix crash');
});

test('orders mods by their dependencies, and says what they wait for', async () => {
  const s = await waitForTexts('ModA', ['1', '↑1']);
  assert.deepStrictEqual(s.mods.map(m => m.name), ['ModA', 'ModB', 'Addon']);
  const byName = new Map(s.mods.map(m => [m.name, m]));
  assert.deepStrictEqual(byName.get('ModB').deps, ['ModA']);
  // ModA has changes to release; ModB doesn't.
  assert.deepStrictEqual(byName.get('ModB').blockedBy, ['ModA']);
  assert.deepStrictEqual(byName.get('Addon').blockedBy, []);
  assert.deepStrictEqual(s.features, { terminal: true, ide: true });
});

test('only answers as localhost, and changes need the token', async () => {
  assert.strictEqual((await request('GET', '/api/state', { headers: { Host: 'evil.example' } })).status, 403);
  assert.strictEqual((await request('POST', '/api/refresh', { body: {} })).status, 403);
  assert.strictEqual((await post('/api/refresh', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await post('/api/refresh', { kind: 'local' })).status, 202);
  assert.strictEqual((await request('GET', '/api/nope')).status, 404);
});

test('streams the state as server-sent events', async () => {
  const first = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: info.port, path: '/api/events', headers: { Host: `127.0.0.1:${info.port}` } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        data += d;
        const m = /event: state\ndata: (.*)\n\n/.exec(data);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', reject);
  });
  assert.deepStrictEqual(texts(first, 'ModA'), ['1', '↑1']);
});

test('updates by itself when a checkout changes', async () => {
  // An unpushed commit: the watcher of .git notices, with no refresh asked.
  sb.commit(sb.path('mc21-lts', 'ModA'), 'Local work', { 'src/main/java/A.java': 'local' });
  // Not the moment between git add and git commit, which shows uncommitted changes.
  const s = await waitFor(async () => {
    const st = await state();
    return JSON.stringify(st.mods.find(m => m.name === 'ModA').cells[1].local) === '["1 unpushed commit"]' && st;
  }, 'the unpushed commit to show');
  assert.deepStrictEqual(texts(s, 'ModA'), ['1', '↑1!']);
  sb.git(sb.path('mc21-lts', 'ModA'), 'reset', '-q', '--hard', 'origin/master-1.21-lts');
  await waitForTexts('ModA', ['1', '↑1']);
});

test('fetches when asked to refresh', async () => {
  const w = sb.path('work', 'ModA');
  sb.commit(w, 'Fix another crash', { 'src/main/java/A.java': 'a3' });
  sb.git(w, 'push', '-q', 'origin', 'master-1.20-lts');
  const r = await post('/api/refresh', { kind: 'full', wait: true });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(texts(await state(), 'ModA'), ['2', '↑2']);
});

test('shows commit details and diffs', async () => {
  const hash = sb.git(sb.path('mc20-lts', 'ModA'), 'log', '-1', '--format=%H', '--grep=Fix crash').trim();
  const details = (await request('GET', `/api/commit?mod=ModA&hash=${hash.slice(0, 9)}`)).json();
  assert.strictEqual(details.hash, hash);
  assert.strictEqual(details.subject, 'Fix crash');
  assert.deepStrictEqual(details.files, [{ status: 'M', path: 'src/main/java/A.java' }]);
  const diff = await request('GET', `/api/diff?mod=ModA&hash=${hash}`);
  assert.match(diff.body, /diff --git a\/src\/main\/java\/A\.java/);
  assert.strictEqual((await request('GET', '/api/commit?mod=ModA&hash=xyz')).status, 400);
  assert.strictEqual((await request('GET', `/api/commit?mod=ModB&hash=${hash}`)).status, 404);
  assert.strictEqual((await request('GET', `/api/diff?mod=../ModA&hash=${hash}`)).status, 404);
});

test('picks up marks made with cc-mark', async () => {
  const modA = sb.path('mc20-lts', 'ModA');
  const hash = sb.git(modA, 'log', '-1', '--format=%h', '--grep=Fix another crash', 'origin/master-1.20-lts').trim();
  assert.strictEqual(sb.run(path.join(BIN, 'cc-mark'), ['no-release', hash, '--all-versions'], { cwd: modA }).code, 0);
  const s = await waitForTexts('ModA', ['1', '↑1']);
  assert.match(JSON.stringify(s.mods.find(m => m.name === 'ModA').cells[0].unreleased.dropped), /marked as no release/);
});

test('marks commits from the page', async () => {
  const hash = sb.git(sb.path('mc20-lts', 'ModA'), 'log', '-1', '--format=%H', '--grep=^Fix crash').trim();
  let r = await post('/api/mark', { mod: 'ModA', hash: hash.slice(0, 9), release: false });
  assert.strictEqual(r.status, 200, r.body);
  assert.deepStrictEqual(texts(await state(), 'ModA'), ['.', '.']);
  const marks = JSON.parse(sb.read(sb.path('marks.json')));
  assert.strictEqual(marks.commits[hash].release, false);
  assert.strictEqual(marks.commits[hash].reason, 'marked in cc-dashboard');
  r = await post('/api/mark', { mod: 'ModA', hash, release: null });
  assert.strictEqual(r.status, 200, r.body);
  assert.deepStrictEqual(texts(await state(), 'ModA'), ['1', '↑1']);
  assert.strictEqual((await post('/api/mark', { mod: 'Nope', hash, release: false })).status, 400);
  assert.strictEqual((await post('/api/mark', { mod: 'ModA', hash: 'abc', release: false })).status, 400);
});

test('starts release chains and tools in a terminal', async () => {
  const dir20 = sb.path('mc20-lts', 'ModA');
  const chainBin = path.join(BIN, 'cc-release-chain');
  assert.strictEqual((await post('/api/chain', { mod: 'ModA' })).status, 200);
  assert.strictEqual((await post('/api/chain', { mod: 'ModA', rehearse: true, confirm: true })).status, 200);
  assert.strictEqual((await post('/api/terminal', { mod: 'ModA', version: '1.21-lts' })).status, 200);
  assert.strictEqual((await post('/api/ide', { mod: 'ModB', version: '1.21-lts' })).status, 200);
  assert.strictEqual((await post('/api/terminal', { mod: 'ModB', version: '1.20-lts' })).status, 400);
  // The tools are started, but may not have written their log yet.
  const logLines = name => (fs.existsSync(sb.path(name)) ? sb.read(sb.path(name)).trim().split('\n') : []);
  await waitFor(() => logLines('fake-terminal.log').length === 3 && logLines('fake-ide.log').length === 1, 'the terminal and IDE to start');
  // The chain starts in the checkout of its first version.
  assert.deepStrictEqual(logLines('fake-terminal.log'), [
    `cd '${dir20}' && '${chainBin}' 'ModA'`,
    `cd '${dir20}' && '${chainBin}' --rehearse --confirm 'ModA'`,
    `cd '${sb.path('mc21-lts', 'ModA')}'`,
  ]);
  assert.deepStrictEqual(logLines('fake-ide.log'), [sb.path('mc21-lts', 'ModB')]);
});

test('shows a running release chain and what it waits for', async () => {
  const chain = spawn(process.execPath, [path.join(BIN, 'cc-release-chain'), 'ModA', '--no-build', '--no-review'], { env: sb.env });
  let out = '';
  chain.stdout.on('data', d => { out += d; });
  const s = await waitFor(async () => {
    const m = (await state()).mods.find(x => x.name === 'ModA');
    return m.chains.length && m.chains[0].waiting && m;
  }, `the chain to wait for an answer\n${out}`);
  assert.strictEqual(s.chains[0].pid, chain.pid);
  assert.match(s.chains[0].waiting, /^Start\?/);
  assert.deepStrictEqual(s.chains[0].versions, ['1.20-lts', '1.21-lts']);
  const exited = new Promise(resolve => chain.on('exit', resolve));
  chain.stdin.end('n\n');
  await exited;
  await waitFor(async () => (await state()).mods.find(x => x.name === 'ModA').chains.length === 0, 'the chain to be gone');
});

test('cc-status shows the status of the running dashboard', () => {
  const r = sb.run(path.join(BIN, 'cc-status'), ['-v', '--no-fetch']);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /Status from cc-dashboard/);
  assert.match(r.out, /ModA +1 +↑1\n/);
  assert.match(r.out, /Fix another crash \(marked as no release\)/);
  // Fetching goes through the dashboard too.
  const fetched = sb.run(path.join(BIN, 'cc-status'), ['-v']);
  assert.strictEqual(fetched.code, 0, fetched.err);
  assert.match(fetched.err, /Status from cc-dashboard/);
  const own = sb.run(path.join(BIN, 'cc-status'), ['-v', '--no-fetch', '--no-dashboard']);
  assert.ok(!own.err.includes('cc-dashboard'), own.err);
  assert.strictEqual(own.out, r.out);
});

test('refuses to run twice, and stops cleanly', async () => {
  const second = sb.run(process.execPath, [path.join(BIN, 'cc-dashboard'), '--port', '0']);
  assert.strictEqual(second.code, 1);
  assert.match(second.err, /The dashboard already runs/);

  const install = sb.run(path.join(BIN, 'cc-dashboard'), ['install'], { env: { CC_HELPERS_LAUNCH_AGENTS: sb.path('agents') } });
  assert.strictEqual(install.code, 1);
  assert.match(install.err, /Stop the running dashboard first/);

  const exited = new Promise(resolve => daemon.on('exit', resolve));
  daemon.kill('SIGTERM');
  assert.strictEqual(await exited, 0);
  assert.ok(!fs.existsSync(sb.path('state', 'dashboard.json')));
});

test('installs and uninstalls a launchd agent', () => {
  // A stand-in for launchctl that logs its arguments.
  const log = sb.path('launchctl.log');
  sb.write(sb.path('shims', 'launchctl'), `#!/bin/sh\necho "$@" >> '${log}'\n`);
  fs.chmodSync(sb.path('shims', 'launchctl'), 0o755);
  const env = { CC_HELPERS_LAUNCH_AGENTS: sb.path('agents') };
  const plist = sb.path('agents', 'com.cyclopsmc.cc-dashboard.plist');

  const r = sb.run(path.join(BIN, 'cc-dashboard'), ['install'], { env });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /now runs in the background/);
  const text = sb.read(plist);
  assert.ok(text.includes(`<string>${process.execPath}</string>`));
  assert.ok(text.includes(`<string>${path.join(BIN, 'cc-dashboard')}</string>`));
  assert.ok(text.includes(`<key>CC_HELPERS_CONFIG</key><string>${sb.env.CC_HELPERS_CONFIG}</string>`));
  const uid = process.getuid();
  assert.deepStrictEqual(sb.read(log).trim().split('\n'), [
    `bootout gui/${uid}/com.cyclopsmc.cc-dashboard`,
    `bootstrap gui/${uid} ${plist}`,
  ]);

  assert.strictEqual(sb.run(path.join(BIN, 'cc-dashboard'), ['uninstall'], { env }).code, 0);
  assert.ok(!fs.existsSync(plist));
  assert.match(sb.read(log), new RegExp(`bootout gui/${uid}/com.cyclopsmc.cc-dashboard\n$`));
});
