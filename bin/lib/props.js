'use strict';
// Reads mod properties (mod_version, minecraft_version, ...) like cc-param does.

const fs = require('fs');
const path = require('path');
const { gitOrNull } = require('./git');

function parseProps(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^#!\s=:][^=:\s]*)\s*[=:]\s*(.*)$/.exec(line);
    if (m) props[m[1]] = m[2].trim();
  }
  return props;
}

// The file cc-param uses in a checkout.
function propsFileName(cwd) {
  return fs.existsSync(path.join(cwd, 'secrets.properties_template')) ? 'gradle.properties' : 'build.properties';
}

function readWorkingProps(cwd) {
  const file = path.join(cwd, propsFileName(cwd));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Can't find ${file}`);
  }
  return parseProps(text);
}

// Properties at a git revision, from whichever file holds mod_version.
async function readPropsAt(cwd, ref) {
  for (const f of ['gradle.properties', 'build.properties']) {
    const text = await gitOrNull(cwd, ['show', `${ref}:${f}`]);
    if (text !== null && /^mod_version\s*=/m.test(text)) return parseProps(text);
  }
  return {};
}

// CyclopsCore version without the build number, like `cc-param cyclops`.
function cyclopsVersion(props) {
  const v = props.cyclopscore_version;
  return v ? v.replace(/-[^-]*$/, '') : '';
}

// The property that names a dependency on `mod`, as in EvilCraft-Compat -> evilcraftcompat_version.
const depKey = mod => `${mod.toLowerCase().replace(/[^a-z0-9]/g, '')}_version`;

// What changed from `before` to `after`: [{ key, from, to }], with `from` null for a new key.
// mod_version is left out, as each version has its own.
function changedProps(before, after) {
  return Object.keys(after)
    .filter(k => k !== 'mod_version' && before[k] !== after[k])
    .map(k => ({ key: k, from: k in before ? before[k] : null, to: after[k] }));
}

// `current` with the version at its end replaced, keeping what comes before it, as the
// "26.1.2-neoforge:" of "26.1.2-neoforge:1.1.0-182".
function withVersion(current, version) {
  const m = /\d+(?:\.\d+)*-\d+$/.exec(current);
  return m ? current.slice(0, m.index) + version : version;
}

// The text of a properties file with `key` set to `value`; unchanged if it has no `key`.
function setProp(text, key, value) {
  const re = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]\\s*)[^\\r\\n]*`, 'm');
  return text.replace(re, (line, lead) => lead + value);
}

module.exports = { parseProps, propsFileName, readWorkingProps, readPropsAt, cyclopsVersion, depKey, changedProps, withVersion, setProp };
