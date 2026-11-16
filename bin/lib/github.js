'use strict';
// Reads branch heads and recent tags of many GitHub repos in one GraphQL request, so only the
// checkouts whose remote changed need a fetch.

const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const BATCH = 40;
const TIMEOUT_MS = 15000;
const RECENT_TAGS = 10;

function apiUrl() {
  return process.env.CC_HELPERS_GITHUB_API || 'https://api.github.com/graphql';
}

// { owner, name } for GitHub remote URLs, else null.
function githubRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

let cachedToken;
// From GH_TOKEN, GITHUB_TOKEN or the GitHub CLI; null if there is none.
function githubToken() {
  if (cachedToken === undefined) {
    cachedToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
    if (!cachedToken) {
      try {
        cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
      } catch (e) {
        cachedToken = null;
      }
    }
  }
  return cachedToken;
}

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).request(u, {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'cc-helpers' },
      timeout: TIMEOUT_MS,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('GitHub sent invalid JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const str = s => JSON.stringify(String(s));

function repoQuery(alias, { owner, name }) {
  return `${alias}: repository(owner: ${str(owner)}, name: ${str(name)}) {
    heads: refs(refPrefix: "refs/heads/", first: 100) { nodes { name target { oid } } }
    tags: refs(refPrefix: "refs/tags/", first: ${RECENT_TAGS}, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name target { oid } } }
  }`;
}

// Map "owner/name" -> { heads: Map branch -> oid, tags: [{ name, oid }] }, for the repos GitHub
// knows. Throws if the request fails as a whole.
async function remoteRefs(repos, token = githubToken()) {
  const result = new Map();
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    const query = `query {\n${batch.map((r, j) => repoQuery(`r${j}`, r)).join('\n')}\n}`;
    const json = await post(apiUrl(), token, { query });
    if (!json.data) throw new Error((json.errors && json.errors[0] && json.errors[0].message) || 'GitHub sent no data');
    batch.forEach((r, j) => {
      const repo = json.data[`r${j}`];
      if (!repo) return;
      result.set(`${r.owner}/${r.name}`.toLowerCase(), {
        heads: new Map(repo.heads.nodes.map(n => [n.name, n.target.oid])),
        tags: repo.tags.nodes.map(n => ({ name: n.name, oid: n.target.oid })),
      });
    });
  }
  return result;
}

module.exports = { githubRepo, githubToken, remoteRefs, repoQuery };
