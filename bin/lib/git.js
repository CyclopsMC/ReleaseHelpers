'use strict';
// Async wrappers around the git CLI.

const { execFile, spawn } = require('child_process');

// No credential prompts, messages in English, and no index writes by `git status`, so watching a
// checkout (cc-dashboard) doesn't trigger itself.
const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' });

function git(cwd, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      timeout,
      maxBuffer: 512 * 1024 * 1024,
      env: GIT_ENV(),
    }, (err, stdout, stderr) => {
      if (err) {
        // The lines saying what went wrong, without progress lines like "From <url>".
        const lines = (stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
        const problems = lines.filter(l => /^(fatal|error|!)/.test(l));
        const detail = (problems.length ? problems : lines).join('; ') || (err.killed ? 'timed out' : err.message);
        const error = new Error(`git ${args[0]}: ${detail}`);
        error.stderr = stderr || '';
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Trimmed output, or null if the command fails.
async function gitOrNull(cwd, args) {
  try {
    return (await git(cwd, args)).trim();
  } catch (e) {
    return null;
  }
}

// Reads files ("<rev>:<path>") with a single git process; missing ones become null.
function readBlobs(cwd, specs) {
  if (!specs.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['cat-file', '--batch'], { cwd, env: GIT_ENV() });
    const chunks = [];
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.resume();
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) {
        reject(new Error(`git cat-file failed in ${cwd}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const out = [];
      let pos = 0;
      for (let i = 0; i < specs.length; i++) {
        const nl = buf.indexOf(10, pos);
        const m = /^[0-9a-f]+ blob (\d+)$/.exec(buf.slice(pos, nl).toString());
        pos = nl + 1;
        if (!m) {
          out.push(null);
          continue;
        }
        const size = Number(m[1]);
        out.push(buf.slice(pos, pos + size).toString('utf8'));
        pos += size + 1;
      }
      resolve(out);
    });
    p.stdin.end(`${specs.join('\n')}\n`);
  });
}

// Runs async task factories with at most `limit` in flight.
// Resolves to [{ value } | { error }] in task order.
async function runPool(tasks, limit, onProgress) {
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { value: await tasks[i]() };
      } catch (error) {
        results[i] = { error };
      }
      done++;
      if (onProgress) onProgress(done, tasks.length);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { git, gitOrNull, readBlobs, runPool };
