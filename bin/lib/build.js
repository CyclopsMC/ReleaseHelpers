'use strict';
// Builds mod checkouts with the Gradle settings of their MC version.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// GRADLE_OPTS with the version's gradleOpts. Command-line -D values override the same keys in
// ~/.gradle/gradle.properties, and every Gradle call that inherits the env picks them up.
function gradleOptsEnv(version, base = process.env.GRADLE_OPTS || '') {
  const opts = Object.entries(version.gradleOpts || {}).map(([key, value]) => {
    if (/["\\]/.test(String(value))) throw new Error(`gradleOpts value of ${key} can't contain quotes or backslashes`);
    // Quoted, so values with spaces (jvmargs) stay one argument for the gradlew script.
    return `"-D${key}=${value}"`;
  });
  return [base, ...opts].filter(Boolean).join(' ');
}

function buildEnv(version) {
  return { ...process.env, GRADLE_OPTS: gradleOptsEnv(version) };
}

function buildEnabled(config, version) {
  return config.build !== false && version.build !== false;
}

function buildCommand(config, extraArgs = []) {
  const cmd = Array.isArray(config.build) ? config.build : ['./gradlew', 'build'];
  return cmd.concat(extraArgs);
}

// The configured version whose dir contains `cwd` as a mod checkout.
function versionForDir(config, cwd) {
  const real = p => {
    try {
      return fs.realpathSync(p);
    } catch (e) {
      return path.resolve(p);
    }
  };
  const parent = real(path.join(cwd, '..'));
  return config.versions.find(v => real(v.dir) === parent) || null;
}

// Runs the build; output goes to `logFile` if given, else to the terminal.
function runBuild({ config, version, cwd, logFile = null, extraArgs = [] }) {
  const [cmd, ...args] = buildCommand(config, extraArgs);
  const started = Date.now();
  return new Promise(resolve => {
    let fd = null;
    let stdio = 'inherit';
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fd = fs.openSync(logFile, 'w');
      stdio = ['ignore', fd, fd];
    }
    const child = spawn(cmd, args, { cwd, env: buildEnv(version), stdio });
    let finished = false;
    const done = code => {
      if (finished) return;
      finished = true;
      if (fd !== null) fs.closeSync(fd);
      resolve({ code, ms: Date.now() - started });
    };
    child.on('error', e => {
      if (fd !== null) fs.writeSync(fd, `${e.message}\n`);
      done(127);
    });
    child.on('close', code => done(code === null ? 1 : code));
  });
}

module.exports = { gradleOptsEnv, buildEnv, buildEnabled, buildCommand, versionForDir, runBuild };
