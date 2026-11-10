// Results page data: reads what chrono-node-rs already records and writes data.json for the page.
// Plain code, Node built-ins only, read-only token (the source repo is public).
//
//   GH_TOKEN=... node results/build.mjs --out site/data.json [--v2 v2-runs.json]
//
// Sources: the repo tree (languages, contracts), factory:task issues, merged PRs, the agent PRs'
// comments, reviews and commits (GraphQL: hands-off), the controller's audit log (`run_spend`: v1
// agent-run cost), the v2 runs' usage (--v2, from the workflow step), agentic-canary runs, and this
// directory's build-cost.json and drills.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { SOURCE_REPO, CAO_URL, cost, drills, languages, summarize, v1Spend, zeroTouch } from './lib.mjs';

const API = 'https://api.github.com';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('GH_TOKEN missing');
const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};

async function api(path, { raw = false, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'User-Agent': 'factory-results' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path.split('?')[0]}: HTTP ${res.status}`);
  return raw ? res.text() : res.json();
}

async function pages(path, pick = (d) => d) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const d = pick(await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    out.push(...d);
    if (d.length < 100) return out;
  }
  throw new Error(`${path}: more than 30 pages`);
}

const R = `/repos/${SOURCE_REPO}`;
const tree = await api(`${R}/git/trees/main?recursive=1`);
if (tree.truncated) throw new Error('tree truncated');
const langs = languages(tree.tree.map((t) => t.path));

const issues = (await pages(`${R}/issues?labels=factory:task&state=all`))
  .filter((i) => !i.pull_request)
  .map((i) => ({ title: i.title, state: i.state, created_at: i.created_at, closed_at: i.closed_at }));

const merged = (await pages(`${R}/pulls?state=closed`))
  .filter((p) => p.merged_at)
  .map((p) => ({ number: p.number, title: p.title, head: p.head.ref, merged_at: p.merged_at }));

const agentPrs = [];
for (let cursor = null; ;) {
  const q = `query($q: String!, $c: String) { search(query: $q, type: ISSUE, first: 50, after: $c) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title
      comments(first: 100) { pageInfo { hasNextPage } nodes { author { __typename login } } }
      reviews(first: 100) { pageInfo { hasNextPage } nodes { author { __typename login } } }
      commits(first: 100) { pageInfo { hasNextPage } nodes { commit { author { email user { login } } } } } } } } }`;
  const d = await api('/graphql', { body: { query: q, variables: { q: `repo:${SOURCE_REPO} is:pr is:merged author:app/sabbasi3-factory-agent`, c: cursor } } });
  if (d.errors) throw new Error(`graphql: ${JSON.stringify(d.errors).slice(0, 200)}`);
  for (const n of d.data.search.nodes) agentPrs.push({ number: n.number, title: n.title, zero_touch: zeroTouch(n) });
  if (!d.data.search.pageInfo.hasNextPage) break;
  cursor = d.data.search.pageInfo.endCursor;
}

const auditTree = await api(`${R}/git/trees/audit?recursive=1`);
const events = [];
for (const t of auditTree.tree.filter((t) => t.type === 'blob' && /^audit\/\d{4}\/\d{2}\/\d{2}\.jsonl$/.test(t.path))) {
  for (const line of (await api(`${R}/contents/${t.path}?ref=audit`, { raw: true })).split('\n')) if (line.trim()) events.push(JSON.parse(line));
}

// v2 runs (their usage, read by the workflow step); a run whose usage expired or can't be read is
// counted as unknown, never as zero.
const v2Runs = opt('--v2') ? JSON.parse(readFileSync(opt('--v2'), 'utf8')) : [];
const v2 = {
  runs: v2Runs.filter((r) => Number.isFinite(r.aic)).length,
  aic: v2Runs.reduce((n, r) => n + (Number.isFinite(r.aic) ? r.aic : 0), 0),
  unknown: v2Runs.filter((r) => !Number.isFinite(r.aic)).length,
};

const canary = (await api(`${R}/actions/workflows/agentic-canary.yml/runs?status=completed&per_page=100`)).workflow_runs;
const local = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));

const data = {
  generated_at: new Date().toISOString(),
  source: SOURCE_REPO,
  cao: CAO_URL,
  ...summarize({ langs, issues, merged, agentPrs }),
  cost: cost(local('./build-cost.json'), v1Spend(events), v2),
  drills: drills(local('./drills.json'), canary),
};
writeFileSync(opt('--out'), JSON.stringify(data, null, 1) + '\n');
console.log(JSON.stringify(data.totals), JSON.stringify(data.cost));
