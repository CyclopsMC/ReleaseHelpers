'use strict';
// The HTTP side of cc-dashboard: the page, live updates (server-sent events) and a small JSON API.
// Only reachable as localhost; requests that change something need the token from the page.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { gitOrNull } = require('./git');

const STATIC_DIR = path.join(__dirname, '..', '..', 'dashboard');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_DIFF = 400 * 1024;
const MAX_BODY = 64 * 1024;
const HASH = /^[0-9a-f]{7,40}$/;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

// Files that don't change while the page is open, like fonts and icons, may be cached for a while.
function sendFile(res, file, type) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(fs.readFileSync(file));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', d => {
      data += d;
      if (data.length > MAX_BODY) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Calls fn at most every `ms`, and once more after the last call.
function throttle(fn, ms) {
  let timer = null;
  let again = false;
  return () => {
    if (timer) {
      again = true;
      return;
    }
    fn();
    timer = setTimeout(function tick() {
      if (again) {
        again = false;
        fn();
        timer = setTimeout(tick, ms);
      } else {
        timer = null;
      }
    }, ms);
  };
}

// The first checkout of the mod that has the commit.
async function findCommit(monitor, mod, hash, format) {
  for (const dir of monitor.modDirs(mod)) {
    const out = await gitOrNull(dir, ['show', '-s', `--format=${format}`, `${hash}^{commit}`]);
    if (out !== null) return { dir, out };
  }
  return null;
}

async function commitDetails(monitor, mod, hash) {
  const found = await findCommit(monitor, mod, hash, '%H%x1f%an%x1f%aI%x1f%s%x1f%b');
  if (!found) return null;
  const [full, author, date, subject, body] = found.out.split('\x1f');
  const files = (await gitOrNull(found.dir, ['show', '--format=', '--name-status', '--no-renames', full]) || '')
    .split('\n').filter(Boolean).map(l => {
      const [status, file] = l.split('\t');
      return { status, path: file };
    });
  return { hash: full, author, date, subject, body: (body || '').trim(), files };
}

async function commitDiff(monitor, mod, hash) {
  const found = await findCommit(monitor, mod, hash, '%H');
  if (!found) return null;
  const diff = await gitOrNull(found.dir, ['show', '--format=', '--stat', '--patch', '--no-color', found.out]) || '';
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n\n[diff cut off at ${MAX_DIFF / 1024} KB]` : diff;
}

function createDashboardServer(monitor, { token, log = () => {}, actions = {} }) {
  const clients = new Set();
  const stateEvent = () => `event: state\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`;
  const broadcast = throttle(() => {
    if (!clients.size) return;
    const data = stateEvent();
    for (const res of clients) res.write(data);
  }, 250);
  monitor.on('change', broadcast);

  let port = null;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  async function handle(req, res) {
    // Blocks DNS rebinding: other sites can't reach this server under their own name.
    if (!allowedHosts().has(req.headers.host)) return send(res, 403, { error: 'Unknown host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^http:\/\//, ''))) return send(res, 403, { error: 'Unknown origin' });
      if (req.headers['x-cc-token'] !== token) return send(res, 403, { error: 'Missing or wrong token' });
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      let text = fs.readFileSync(path.join(STATIC_DIR, file), 'utf8');
      if (file === 'index.html') text = text.replace('__CC_TOKEN__', token);
      return send(res, 200, text, type);
    }
    // Bundled fonts, and the cached icons of the mods.
    const font = req.method === 'GET' && /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url.pathname);
    if (font) {
      const file = path.join(STATIC_DIR, 'fonts', font[1]);
      if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return sendFile(res, file, 'font/woff2');
    }
    const iconName = req.method === 'GET' && /^\/icons\/([^/]+)$/.exec(url.pathname);
    if (iconName) {
      const icon = monitor.iconFile(decodeURIComponent(iconName[1]));
      return icon ? sendFile(res, icon.file, icon.type) : send(res, 404, 'No icon', 'text/plain; charset=utf-8');
    }
    if (route === 'GET /api/state') return send(res, 200, monitor.snapshot());
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(stateEvent());
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return undefined;
    }
    if (route === 'GET /api/commit' || route === 'GET /api/diff') {
      const mod = url.searchParams.get('mod');
      const hash = (url.searchParams.get('hash') || '').toLowerCase();
      if (!HASH.test(hash)) return send(res, 400, { error: 'Bad commit hash' });
      if (route === 'GET /api/commit') {
        const details = await commitDetails(monitor, mod, hash);
        return details ? send(res, 200, details) : send(res, 404, { error: 'Commit not found' });
      }
      const diff = await commitDiff(monitor, mod, hash);
      return diff === null ? send(res, 404, 'Commit not found', 'text/plain; charset=utf-8') : send(res, 200, diff, 'text/plain; charset=utf-8');
    }
    if (route === 'POST /api/refresh') {
      const body = await readBody(req);
      const kind = ['local', 'remote', 'full'].includes(body.kind) ? body.kind : 'remote';
      // remote and full also recompute every mod.
      const done = monitor.request(kind);
      if (kind !== 'local') monitor.refreshProjects();
      if (body.wait) await done;
      return send(res, body.wait ? 200 : 202, { ok: true });
    }
    const name = url.pathname.slice('/api/'.length);
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && Object.prototype.hasOwnProperty.call(actions, name)) {
      return send(res, 200, await actions[name](await readBody(req)));
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
      log(`${req.method} ${req.url} failed: ${e.stack || e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    });
  });

  return {
    server,
    listen(p, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          port = server.address().port;
          resolve(port);
        });
      });
    },
    close() {
      for (const res of clients) res.end();
      monitor.off('change', broadcast);
      return new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createDashboardServer };
