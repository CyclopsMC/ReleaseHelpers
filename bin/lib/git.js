'use strict';
// Async wrappers around the git CLI.

const { execFile } = require('child_process');

function git(cwd, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      timeout,
      maxBuffer: 512 * 1024 * 1024,
      // Never block on credential prompts; parse messages in English.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || '').trim() || (err.killed ? 'timed out' : err.message);
        reject(new Error(`git ${args[0]}: ${detail}`));
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

module.exports = { git, gitOrNull, runPool };
