'use strict';
// Reads branch heads and recent tags of many GitHub repos in one GraphQL request, so only the
// checkouts whose remote changed need a fetch.

const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const BATCH = 40;
const TIMEOUT_MS = 15000;
const RECENT_TAGS = 10;
// The GitHub Actions app.
const ACTIONS_APP_ID = 15368;
const SUITE_PAGES = 5;
const ACTIONS_CACHE_MS = 10 * 60000;
const BUILD_COMMITS = 5;

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

const ROLLUP = '... on Commit { oid statusCheckRollup { state } }';

// With `health`, also the CI state of each branch head, and of the `releases` tags.
function repoQuery(alias, { owner, name, releases = [] }, health = false) {
  const headTarget = health ? `oid ${ROLLUP}` : 'oid';
  const releaseRefs = health ? releases.map((tag, i) => `
    release${i}: ref(qualifiedName: ${str(`refs/tags/${tag}`)}) { target { ... on Tag { target { ${ROLLUP} } } ${ROLLUP} } }`).join('') : '';
  const counts = health ? `
    openIssues: issues(states: OPEN) { totalCount }
    openPullRequests: pullRequests(states: OPEN) { totalCount }` : '';
  return `${alias}: repository(owner: ${str(owner)}, name: ${str(name)}) {${counts}
    heads: refs(refPrefix: "refs/heads/", first: 100) { nodes { name target { ${headTarget} } } }
    tags: refs(refPrefix: "refs/tags/", first: ${RECENT_TAGS}, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) { nodes { name target { oid } } }${releaseRefs}
  }`;
}

// SUCCESS, FAILURE, ERROR, PENDING or EXPECTED; null without checks.
const rollup = target => (target && target.statusCheckRollup ? target.statusCheckRollup.state : null);

// The GitHub Actions runs on a commit, a page at a time.
function suitesQuery(alias, { owner, name, oid }, after = null) {
  const page = after ? `, after: ${str(after)}` : '';
  return `${alias}: repository(owner: ${str(owner)}, name: ${str(name)}) {
    object(oid: ${str(oid)}) { ... on Commit { checkSuites(first: 100${page}, filterBy: {appId: ${ACTIONS_APP_ID}}) {
      pageInfo { hasNextPage endCursor }
      nodes { status conclusion createdAt workflowRun { event workflow { name } } }
    } } }
  }`;
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']);

// The CI state from the latest run of each workflow that a push started; null if none did.
// Scheduled and issue workflows don't count.
function actionsState(suites) {
  const latest = new Map();
  for (const s of suites) {
    if (!s.workflowRun || s.workflowRun.event !== 'push') continue;
    const workflow = s.workflowRun.workflow ? s.workflowRun.workflow.name : '';
    const seen = latest.get(workflow);
    if (!seen || Date.parse(s.createdAt) > Date.parse(seen.createdAt)) latest.set(workflow, s);
  }
  const runs = [...latest.values()];
  if (!runs.length) return null;
  if (runs.some(s => FAILED.has(s.conclusion))) return 'FAILURE';
  if (runs.some(s => s.status !== 'COMPLETED')) return 'PENDING';
  return 'SUCCESS';
}

// oid -> { state, at }
const actionsCache = new Map();

// Map oid -> Actions state, for commits [{ owner, name, oid }]. A commit GitHub can't answer for
// is left out.
async function actionsStates(commits, token) {
  const now = Date.now();
  const states = new Map();
  const todo = [];
  for (const c of commits) {
    const hit = actionsCache.get(c.oid);
    if (hit && now - hit.at < ACTIONS_CACHE_MS) states.set(c.oid, hit.state);
    else todo.push({ ...c, suites: [], after: null });
  }
  let pending = todo;
  for (let page = 0; page < SUITE_PAGES && pending.length; page++) {
    const next = [];
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const query = `query {\n${batch.map((c, j) => suitesQuery(`c${j}`, c, c.after)).join('\n')}\n}`;
      const json = await post(apiUrl(), token, { query });
      batch.forEach((c, j) => {
        const repo = json.data && json.data[`c${j}`];
        const suites = repo && repo.object && repo.object.checkSuites;
        if (!suites) {
          c.failed = true;
          return;
        }
        c.suites.push(...suites.nodes);
        if (suites.pageInfo.hasNextPage) {
          c.after = suites.pageInfo.endCursor;
          next.push(c);
        }
      });
    }
    pending = next;
  }
  for (const c of todo) {
    if (c.failed) continue;
    const state = actionsState(c.suites);
    states.set(c.oid, state);
    // A run that is still going is asked for again next time.
    if (state !== 'PENDING') actionsCache.set(c.oid, { state, at: now });
  }
  return states;
}

// Map "owner/name" -> { heads: Map branch -> oid, tags: [{ name, oid }] }, for the repos GitHub
// knows. With `health`, also headStates (branch -> CI state), releaseStates (tag -> CI state), and
// the numbers of open issues and pull requests.
// CI states only count GitHub Actions: a commit that fails by other checks, like a Coveralls
// status, is looked at again with actionsStates.
// Throws if the request fails as a whole.
async function remoteRefs(repos, token = githubToken(), { health = false } = {}) {
  const result = new Map();
  const failing = [];
  for (let i = 0; i < repos.length; i += BATCH) {
    const batch = repos.slice(i, i + BATCH);
    const query = `query {\n${batch.map((r, j) => repoQuery(`r${j}`, r, health)).join('\n')}\n}`;
    const json = await post(apiUrl(), token, { query });
    if (!json.data) throw new Error((json.errors && json.errors[0] && json.errors[0].message) || 'GitHub sent no data');
    batch.forEach((r, j) => {
      const repo = json.data[`r${j}`];
      if (!repo) return;
      const refs = {
        heads: new Map(repo.heads.nodes.map(n => [n.name, n.target.oid])),
        tags: repo.tags.nodes.map(n => ({ name: n.name, oid: n.target.oid })),
      };
      if (health) {
        // [name, commit] of the heads, and of the releases.
        const heads = repo.heads.nodes.map(n => [n.name, n.target]);
        const releases = (r.releases || []).map((tag, i) => {
          const ref = repo[`release${i}`];
          // Annotated tags point to a Tag, whose target is the commit.
          return [tag, ref && ref.target && (ref.target.target || ref.target)];
        });
        for (const [, commit] of [...heads, ...releases]) {
          if (commit && ['FAILURE', 'ERROR'].includes(rollup(commit))) failing.push({ owner: r.owner, name: r.name, oid: commit.oid });
        }
        refs.headStates = heads;
        refs.releaseStates = releases;
        refs.openIssues = repo.openIssues ? repo.openIssues.totalCount : null;
        refs.openPullRequests = repo.openPullRequests ? repo.openPullRequests.totalCount : null;
      }
      result.set(`${r.owner}/${r.name}`.toLowerCase(), refs);
    });
  }
  if (health) {
    const unique = [...new Map(failing.map(c => [c.oid, c])).values()];
    let actions = new Map();
    try {
      actions = await actionsStates(unique, token);
    } catch (e) {
      // Without an answer, the combined state stands.
    }
    const state = commit => {
      if (!commit) return null;
      return actions.has(commit.oid) ? actions.get(commit.oid) : rollup(commit);
    };
    for (const refs of result.values()) {
      refs.headStates = new Map(refs.headStates.map(([name, commit]) => [name, state(commit)]));
      refs.releaseStates = new Map(refs.releaseStates.map(([tag, commit]) => [tag, state(commit)]));
    }
  }
  return result;
}

// The newest commits of a branch, with the GitHub Actions runs their pushes started, and the steps
// of those runs.
function buildsQuery({ owner, name, branch }) {
  return `query {
  repository(owner: ${str(owner)}, name: ${str(name)}) {
    ref(qualifiedName: ${str(`refs/heads/${branch}`)}) { target { ... on Commit {
      history(first: ${BUILD_COMMITS}) { nodes { oid
        checkSuites(first: 50, filterBy: {appId: ${ACTIONS_APP_ID}}) { nodes {
          status conclusion
          workflowRun { runNumber event workflow { name } }
          checkRuns(first: 5) { nodes { steps(first: 40) { nodes { name conclusion } } } }
        } }
      } }
    } } }
  }
}`;
}

// What the pushes of a commit built: { running, build }. `build` is the number of a run that
// published to Maven, by a successful step named like "Deploy to Maven", or without such a step,
// a successful run of the CI workflow; null if none did.
function commitBuild(suites) {
  const pushes = suites.filter(s => s.workflowRun && s.workflowRun.event === 'push');
  const published = pushes.filter(s => {
    const steps = (s.checkRuns ? s.checkRuns.nodes : []).flatMap(r => (r.steps ? r.steps.nodes : []));
    const maven = steps.filter(st => /maven/i.test(st.name));
    // A CI that skips publishing, e.g. for "Bump mod version" commits, skips that step.
    if (maven.length) return maven.some(st => st.conclusion === 'SUCCESS');
    return s.conclusion === 'SUCCESS' && !!s.workflowRun.workflow && s.workflowRun.workflow.name === 'CI';
  }).map(s => s.workflowRun.runNumber);
  return {
    running: pushes.some(s => s.status !== 'COMPLETED'),
    build: published.length ? Math.max(...published) : null,
  };
}

// The newest commits of a branch, newest first: [{ oid, running, build }], see commitBuild.
async function branchBuilds(repo, token = githubToken()) {
  const data = await graphql(buildsQuery(repo), {}, token);
  const ref = data.repository && data.repository.ref;
  if (!ref) throw new Error(`${repo.owner}/${repo.name} has no branch ${repo.branch}`);
  return ref.target.history.nodes.map(n => ({ oid: n.oid, ...commitBuild(n.checkSuites.nodes) }));
}

// Runs one GraphQL query; throws with GitHub's message if it sends no data. A token without the
// scope the query needs gets an error that says how to add it.
async function graphql(query, variables = {}, token = githubToken()) {
  if (!token) throw new Error('No GitHub token: run gh auth login, or set GH_TOKEN.');
  const json = await post(apiUrl(), token, { query, variables });
  const errors = json.errors || [];
  const scope = errors.find(e => e.type === 'INSUFFICIENT_SCOPES');
  if (scope) {
    const needs = /\['([^']+)'/.exec(scope.message);
    throw new Error(`The GitHub token lacks the ${needs ? needs[1] : 'needed'} scope: run gh auth refresh -s ${needs ? needs[1] : 'read:project'}.`);
  }
  if (!json.data || errors.length) throw new Error((errors[0] && errors[0].message) || 'GitHub sent no data');
  return json.data;
}

module.exports = { githubRepo, githubToken, graphql, remoteRefs, repoQuery, suitesQuery, actionsState, buildsQuery, commitBuild, branchBuilds };
