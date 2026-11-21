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

module.exports = { parseProps, propsFileName, readWorkingProps, readPropsAt, cyclopsVersion };
