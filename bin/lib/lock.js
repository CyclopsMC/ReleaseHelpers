'use strict';
// Locks shared between processes (one release chain per mod, a limited number of builds).
// A lock is a directory holding the owner's pid; locks of dead processes are taken over.

const fs = require('fs');
const os = require('os');
const path = require('path');

function stateDir() {
  return process.env.CC_HELPERS_STATE_DIR
    || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'cc-helpers');
}

const held = new Set();
process.on('exit', () => {
  for (const dir of held) fs.rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function ownerPid(dir) {
  try {
    return Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')) || null;
  } catch (e) {
    return null;
  }
}

function isFresh(dir) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs < 5000;
  } catch (e) {
    return false;
  }
}

// Takes the lock if it is free or stale; returns whether it was taken.
function tryLock(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      held.add(dir);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = ownerPid(dir);
      // A lock without a pid file may be one that is being created right now.
      if (pid ? isAlive(pid) : isFresh(dir)) return false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}

function unlock(dir) {
  held.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

const modLockDir = mod => path.join(stateDir(), 'locks', mod);

// Pid of a running release chain for the mod, or null.
function modLockOwner(mod) {
  const pid = ownerPid(modLockDir(mod));
  return pid && isAlive(pid) && pid !== process.pid ? pid : null;
}

// Waits for one of `max` build slots; resolves to a function that frees it.
async function acquireBuildSlot(max, onWait) {
  let waiting = false;
  for (;;) {
    for (let i = 0; i < max; i++) {
      const dir = path.join(stateDir(), 'build-slots', String(i));
      if (tryLock(dir)) return () => unlock(dir);
    }
    if (!waiting && onWait) onWait();
    waiting = true;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

module.exports = { tryLock, unlock, modLockDir, modLockOwner, acquireBuildSlot, stateDir, isAlive };
