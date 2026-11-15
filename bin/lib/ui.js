'use strict';
// Terminal prompts and notifications for interactive commands.

const readline = require('readline');
const { spawnSync } = require('child_process');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const colors = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

// Only alert when the person may have looked away, i.e. after a long step.
const ALERT_AFTER_MS = 20000;

// Reads answers line by line, from a terminal or piped input.
class Prompter {
  constructor({ notify = true, title = 'cc-helpers' } = {}) {
    this.queue = [];
    this.waiting = null;
    this.closed = false;
    this.notify = notify;
    this.title = title;
    this.lastAnswer = Date.now();
    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    this.rl.on('line', line => this.push(line));
    this.rl.on('close', () => {
      this.closed = true;
      this.push(null);
    });
  }

  push(line) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(line);
    } else if (line !== null) {
      this.queue.push(line);
    }
  }

  nextLine() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => { this.waiting = resolve; });
  }

  async ask(question) {
    this.alert(question);
    process.stdout.write(`${question} `);
    const line = await this.nextLine();
    if (line === null) throw new Error('No answer: input was closed');
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
    this.lastAnswer = Date.now();
    return line.trim();
  }

  // choices: [{ key: 'p', label: '[p]atch 1.0.1', value: 'patch' }]; `def` is a value.
  async choose(question, choices, def) {
    const defLabel = def ? colors.dim(` (default: ${choices.find(c => c.value === def).key})`) : '';
    for (;;) {
      const answer = (await this.ask(`${question} ${choices.map(c => c.label).join(' / ')}${defLabel}`)).toLowerCase();
      const pick = answer === '' ? def : answer;
      const choice = choices.find(c => c.key === pick || c.value === pick);
      if (choice) return choice.value;
      console.log(`Please answer ${choices.map(c => c.key).join(', ')}.`);
    }
  }

  async confirm(question, def = true) {
    const answer = await this.choose(question, [
      { key: 'y', label: '[y]es', value: 'yes' },
      { key: 'n', label: '[n]o', value: 'no' },
    ], def ? 'yes' : 'no');
    return answer === 'yes';
  }

  async input(question, def) {
    return (await this.ask(`${question} ${colors.dim(`[${def}]`)}`)) || def;
  }

  alert(question) {
    if (Date.now() - this.lastAnswer < ALERT_AFTER_MS) return;
    process.stdout.write('\x07');
    if (this.notify && process.platform === 'darwin') {
      const text = question.split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '');
      spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(this.title)}`]);
    }
  }

  close() {
    this.rl.close();
  }
}

module.exports = { Prompter, colors };
