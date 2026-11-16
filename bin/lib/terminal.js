'use strict';
// Opens a terminal window that runs a command, or your IDE, for the dashboard's buttons.

const { spawn } = require('child_process');

const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;
const appleString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// "dashboard": { "terminal": "Terminal" | "iTerm" | ["kitty", "sh", "-c", "{cmd}; exec $SHELL"] }
// {cmd} is the shell command line (cd to {cwd}, then the command).
function terminalCommand(config, cwd, command) {
  const setting = (config.dashboard && config.dashboard.terminal) || (process.platform === 'darwin' ? 'Terminal' : null);
  const line = `cd ${shellQuote(cwd)}${command ? ` && ${command}` : ''}`;
  if (Array.isArray(setting) && setting.length) {
    return setting.map(a => String(a).replace(/\{cmd\}/g, line).replace(/\{cwd\}/g, cwd));
  }
  if (setting === 'Terminal') {
    return ['osascript', '-e', `tell application "Terminal" to do script ${appleString(line)}`, '-e', 'tell application "Terminal" to activate'];
  }
  if (setting === 'iTerm') {
    return ['osascript',
      '-e', 'tell application "iTerm"',
      '-e', 'activate',
      '-e', 'set w to (create window with default profile)',
      '-e', `tell current session of w to write text ${appleString(line)}`,
      '-e', 'end tell'];
  }
  throw new Error('Set "dashboard": { "terminal": [...] } in the config to open terminals, '
    + 'e.g. ["gnome-terminal", "--", "bash", "-c", "{cmd}; exec bash"].');
}

// "dashboard": { "ide": ["idea", "{dir}"] }, or null when not set.
function ideCommand(config, dir) {
  const setting = config.dashboard && config.dashboard.ide;
  return Array.isArray(setting) && setting.length ? setting.map(a => String(a).replace(/\{dir\}/g, dir)) : null;
}

// Starts it detached; rejects if it can't be started.
function launch(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', e => reject(new Error(`Can't start ${argv[0]}: ${e.message}`)));
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { terminalCommand, ideCommand, launch, shellQuote };
