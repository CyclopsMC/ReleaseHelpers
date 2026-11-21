'use strict';
// GitHub project boards (Projects v2) for the dashboard: what each status column holds, and which
// items were fixed by commits that are not released yet.

const { graphql } = require('./github');

const PAGE = 100;
const MAX_PAGES = 10;

// A board from its URL (https://github.com/orgs/CyclopsMC/projects/3) or "owner/number"
// (an organization's board): { owner, number, user }, or null.
function parseProject(spec) {
  const url = /github\.com\/(orgs|users)\/([^/\s]+)\/projects\/(\d+)/.exec(String(spec));
  if (url) return { owner: url[2], number: Number(url[3]), user: url[1] === 'users' };
  const short = /^([\w.-]+)\/(\d+)$/.exec(String(spec).trim());
  return short ? { owner: short[1], number: Number(short[2]), user: false } : null;
}

// Issues and pull requests have a state of different types, so each gets its own name.
const content = state => `
          number title url ${state}: state
          repository { nameWithOwner }
          labels(first: 5) { nodes { name } }`;
const query = user => `query($owner: String!, $number: Int!, $after: String) {
  owner: ${user ? 'user' : 'organization'}(login: $owner) {
    projectV2(number: $number) {
      title
      url
      status: field(name: "Status") { ... on ProjectV2SingleSelectField { options { name } } }
      items(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isArchived
          status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content {
            __typename
            ... on Issue {${content('issueState')}
            }
            ... on PullRequest {${content('prState')}
            }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}`;

// { title, url, statuses: [name], items: [{ status, kind, number, title, url, state, repo, labels }] }
async function fetchProject(project) {
  let after = null;
  let result = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(query(project.user), { owner: project.owner, number: project.number, after });
    const board = data.owner && data.owner.projectV2;
    if (!board) throw new Error(`No project ${project.number} of ${project.owner}`);
    if (!result) {
      result = { title: board.title, url: board.url, statuses: board.status ? board.status.options.map(o => o.name) : [], items: [] };
    }
    for (const n of board.items.nodes) {
      if (n.isArchived || !n.content) continue;
      const c = n.content;
      result.items.push({
        status: n.status ? n.status.name : null,
        kind: c.__typename === 'PullRequest' ? 'pr' : c.__typename === 'Issue' ? 'issue' : 'draft',
        number: c.number || null,
        title: c.title,
        url: c.url || null,
        state: c.issueState || c.prState || null,
        repo: c.repository ? c.repository.nameWithOwner : null,
        labels: c.labels ? c.labels.nodes.map(l => l.name) : [],
      });
    }
    if (!board.items.pageInfo.hasNextPage) break;
    after = board.items.pageInfo.endCursor;
  }
  return result;
}

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*(?:,|and)\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;

// The issues and pull requests a commit closes, as "owner/repo#n" (lower case): from closing
// keywords (Closes #12) and the "(#34)" GitHub adds to the subject of a merged pull request.
function commitRefs(commit, repo) {
  const refs = new Set();
  const add = ref => {
    const m = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref.trim());
    if (m) refs.add(`${(m[1] || repo).toLowerCase()}#${m[2]}`);
  };
  for (const m of `${commit.subject}\n${commit.body || ''}`.matchAll(CLOSES)) m[1].split(/\s*(?:,|and)\s*/).forEach(add);
  const pr = /\(#(\d+)\)\s*$/.exec(commit.subject);
  if (pr) add(`#${pr[1]}`);
  return refs;
}

// The boards for the page, and the items per mod for its panel.
// boards: [{ spec, data | null, error | null }]
// mods: [{ name, repo: 'owner/name' | null, unreleased: [{ version, commits }] }], the commits
// on each version that are not released there yet.
function summarizeProjects(boards, mods, { perColumn = 6 } = {}) {
  const modOf = new Map(mods.filter(m => m.repo).map(m => [m.repo.toLowerCase(), m]));
  // owner/repo#n -> versions where its fix is not released yet.
  const waiting = new Map();
  for (const m of mods.filter(x => x.repo)) {
    for (const { version, commits } of m.unreleased) {
      for (const c of commits) {
        for (const ref of commitRefs(c, m.repo)) {
          if (!waiting.has(ref)) waiting.set(ref, new Set());
          waiting.get(ref).add(version);
        }
      }
    }
  }
  const perMod = {};
  const projects = boards.map(({ spec, data, error }) => {
    if (!data) return { spec, error };
    const done = data.statuses.length ? data.statuses[data.statuses.length - 1] : null;
    const items = data.items.map(i => {
      const mod = i.repo ? modOf.get(i.repo.toLowerCase()) : null;
      const ref = i.repo && i.number ? `${i.repo.toLowerCase()}#${i.number}` : null;
      const unreleased = ref && waiting.has(ref) ? [...waiting.get(ref)] : [];
      return {
        ...i,
        mod: mod ? mod.name : (i.repo ? i.repo.split('/')[1] : null),
        done: (done !== null && i.status === done) || i.state === 'CLOSED' || i.state === 'MERGED',
        unreleased,
      };
    });
    // Active columns, the furthest along first; items without a status last.
    const names = data.statuses.filter(s => s !== done).reverse();
    if (items.some(i => !i.done && !i.status)) names.push(null);
    const columns = names.map(name => {
      const list = items.filter(i => !i.done && i.status === name);
      return { name, count: list.length, items: list.slice(0, perColumn) };
    }).filter(c => c.count);
    // For a mod's panel: the furthest along first, then no status, then done but not released.
    const rank = i => {
      if (i.done) return names.length + 1;
      const k = names.indexOf(i.status);
      return k < 0 ? names.length : k;
    };
    const forPanel = items.filter(x => x.mod && (!x.done || x.unreleased.length)).sort((a, b) => rank(a) - rank(b));
    for (const i of forPanel) {
      (perMod[i.mod] = perMod[i.mod] || []).push({ project: data.title, status: i.status, done: i.done, kind: i.kind, number: i.number, title: i.title, url: i.url, unreleased: i.unreleased });
    }
    return {
      spec,
      title: data.title,
      url: data.url,
      open: items.filter(i => !i.done).length,
      done: items.filter(i => i.done).length,
      columns,
      // Done on the board, but the fix still has to be released somewhere.
      unreleased: items.filter(i => i.done && i.unreleased.length),
    };
  });
  return { projects, perMod };
}

module.exports = { parseProject, fetchProject, commitRefs, summarizeProjects };
