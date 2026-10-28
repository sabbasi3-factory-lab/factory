// Control-room UI: one screen at 1440x900. Fetches the audit branch from GitHub, verifies it
// with lib.js and renders the status line, the key numbers, the task board, the small panels
// and the folded details. All DOM writes use textContent or createElement(NS), never innerHTML,
// and widths go through the CSSOM, so the strict CSP holds. Every request is a GET.
import {
  AGENT_WORKFLOWS, CADENCE_NOTE, DEFAULTS, FOLLOW_UP_MIN, HUMAN_DAYS, MEDIAN_DAYS, STAGES, STAGE_LABELS, STALE_DATA_MIN, TASK_STATES, TASK_STATE_LABELS,
  anchorTimes, cadenceText, canonicalize, combineNeedsYou, compactAge, costJoin, dayPaths, deriveMetrics, dispatchBanner, dropClosed, existingDayPaths,
  fallbackCatalog, formatAge, formatDuration, formatLimit, formatUsd, healthSummary, heartbeatTimes, humanTouch, issueToMerged, latestDispatchState, limitsText,
  liveness, medianTaskCost, observedCadence, parseAnchors, parseContract, parseJsonl, parseTaskmap, parseTime, prRef, qualityStats, recentActivity,
  relativeTime, reviewItems, shortDuration, shortTaskName, shortTitle, snapshotRunIds, stageSummary, stageTimes, stateLine, statusSummary,
  subjectLabel, summarizePr, summarizeTaskIssue, taskBoard, taskCatalog, taskIssueMap, timelineFor, utcDay, VERIFIER_LIMITS, verifierReason, verifierStatus, verifyChain,
} from './lib.js';

const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
const BRANCH = 'audit';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const GH = 'https://github.com';
const TOKEN_KEY = 'factory-dashboard.github-token';
const THEME_KEY = 'factory-dashboard.theme';
// Sample data (relative URLs, so they work locally and on Pages): ?fixture=1 is a busy
// factory, ?fixture=quiet the quiet state the live page is usually in. The meta file stands in
// for the task map, the contracts and the Actions run lists, so sample mode makes no GitHub call.
const FIXTURES = Object.freeze({
  1: { events: 'test/fixtures/sample.jsonl', anchors: 'test/fixtures/anchors.jsonl', meta: 'test/fixtures/sample-meta.json' },
  quiet: { events: 'test/fixtures/quiet.jsonl', anchors: 'test/fixtures/quiet-anchors.jsonl', meta: 'test/fixtures/quiet-meta.json' },
});
const MISSING_BRANCH_POLL_S = 300;
// Open-PR lists (both repos, for owner reviews) and the source repo's open issues and PRs (to
// drop closed items): v1 audit events have no "closed" event, so these come from GitHub.
const FACTORY_REPO = 'sabbasi3-factory-lab/factory';
const PR_REPOS = [REPO, FACTORY_REPO];
// Two list calls per refresh: after an audit head change but at most every ~5 min, and at
// least every 15 min so the state doesn't go stale. Unauthenticated, that's 4 to 12 of
// the 60 requests an hour; nextDelayMs() then spreads the branch polls over the rest.
const PR_MIN_AGE_MS = 5 * 60000;
const PR_MAX_AGE_MS = 15 * 60000;
const PR_RETRY_MS = 60000;
const PR_STALE_MS = 20 * 60000; // older than this, PR state counts as unknown
// Independent verifier: the audit-verify workflow appends an anchor line per successful
// verification to this file. It's read from raw.githubusercontent.com (outside the API
// limit) at most every 5 min. Until the branch exists, one API call at most every 15 min
// checks for it instead, so the page doesn't keep logging 404s for the raw file.
const ANCHORS_BRANCH = 'anchors';
const ANCHORS_PATH = 'anchors/chrono-node-rs.jsonl';
const VERIFIER_MIN_MS = 5 * 60000;
const VERIFIER_PROBE_MS = 15 * 60000;
const VERIFIER_RETRY_MS = 60000;
// The task map and the contracts it generates, from raw.githubusercontent.com (no API cost):
// read on load, then hourly; a failed read is retried after 5 min.
const TASKMAP_PATH = 'scripts/seed-backlog/taskmap.yaml';
const META_MAX_AGE_MS = 60 * 60000;
const META_RETRY_MS = 5 * 60000;
// The agent workflow run lists (3 API calls, with ETags), read only when a spend snapshot names
// a run that isn't in them yet, at most every 10 min, and only with enough API budget left.
const RUNS_MIN_MS = 10 * 60000;
const RUNS_RESERVE = 5;
// The task issues (one API call, with an ETag): their open/closed state decides which tasks are
// done, whatever the audit window holds. Read on load, then at most every 30 min, or sooner (but
// at most every 2 min) when the audit log shows a new task_done or merged.
const TASK_ISSUES_MAX_AGE_MS = 30 * 60000;
const TASK_ISSUES_MIN_MS = 2 * 60000;
const TASK_ISSUES_RESERVE = 5;

const params = new URLSearchParams(location.search);
const FIXTURE_PARAM = Object.hasOwn(FIXTURES, params.get('fixture') ?? '') ? params.get('fixture') : null;
const FIXTURE = FIXTURE_PARAM != null;
const FIXTURE_URL = FIXTURE ? FIXTURES[FIXTURE_PARAM].events : null;
const ANCHORS_FIXTURE_URL = FIXTURE ? FIXTURES[FIXTURE_PARAM].anchors : null;
const META_FIXTURE_URL = FIXTURE ? FIXTURES[FIXTURE_PARAM].meta : null;
const POLL_S = clampInt(params.get('poll'), 30, 10, 3600);
// The 14-day medians need 14 days of day files.
const DAYS = clampInt(params.get('days'), MEDIAN_DAYS, 1, 31);

const state = {
  records: [],
  events: [],
  chain: null,
  headSha: null,
  etag: null,
  noLog: false,
  loaded: false,
  rate: null,
  error: null,
  windowDay: null,
  lastCheck: null,
  lastOkAt: null, // last successful load or check (Date.now() ms), for "updated … ago"
  nextCheckAt: null,
  clockOffset: 0,
  expanded: new Set(),
  checksExpanded: false,
  sigs: new Map(), // section id -> signature of what it shows, so unchanged sections aren't rebuilt
  subject: '',
  typeFilter: '',
  timer: null,
  busy: false,
  dataVersion: 0,
  renderedVersion: -1,
  prs: { fetchedAt: null, lastOk: false, error: null, lists: new Map() }, // repo -> { etag, prs }
  prsKnownRendered: null,
  // status: 'pending' | 'ok' | 'missing' | 'error'; branchSeen skips the API probe once the branch exists.
  verifier: { status: 'pending', text: null, detail: null, attemptedAt: null, branchSeen: false },
  // The task catalog: status 'pending' | 'ok' | 'error'; catalog stays from the last good read.
  meta: { status: 'pending', catalog: null, missing: [], error: null, fetchedAt: null, attemptedAt: null },
  // Agent workflow runs: status 'idle' (not needed yet) | 'ok' | 'error'; lists: workflow -> { etag, runs }.
  runs: { status: 'idle', lists: new Map(), error: null, fetchedAt: null, attemptedAt: null, tried: new Set(), waitingForRate: false },
  // Task issues: map (task id -> issue) from the last good read, or null; doneMark is the count of
  // task_done and merged events when it was read, so a new one triggers an early refresh.
  taskIssues: { map: null, etag: null, items: null, error: null, fetchedAt: null, attemptedAt: null, doneMark: null, truncated: false },
  fixtureMeta: null,
};

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + state.clockOffset;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function clampInt(value, dflt, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// ---------------------------------------------------------------------------
// DOM helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function link(href, text) {
  return h('a', { href, rel: 'noopener noreferrer' }, text);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v);
const fmtInt = (n) => (isNum(n) ? n.toLocaleString('en-US') : '—');

// A relative time ("23m ago", or just "23m" when `bare`) that moves with the clock; the exact UTC
// time is in its title.
function timeEl(ts, { bare = false } = {}) {
  const ms = typeof ts === 'number' ? ts : parseTime(ts);
  if (ms == null) return '—';
  return h('time', { datetime: iso(ms), title: iso(ms), 'data-at': String(ms), 'data-bare': bare ? '1' : null }, relText(ms, bare));
}

function relText(ms, bare) {
  return bare ? compactAge(now() - ms) : relativeTime(ms, now());
}

function showTimeline(key) {
  state.subject = key;
  $('timeline-fold').open = true;
  safe('timeline', () => renderTimeline(deriveMetrics(state.events, { now: now() })));
  $('timeline-fold').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('subject').focus({ preventScroll: true });
}

function subjectButton(key, label, tipText = 'Show the timeline') {
  return tip(h('button', { type: 'button', class: 'linklike', onclick: () => showTimeline(key) }, label), tipText);
}

function empty(text) {
  return h('p', { class: 'empty' }, text);
}

function table(caption, headers, rows, { foot = null, numeric = [] } = {}) {
  const thead = h('thead', {}, h('tr', {}, headers.map((t, i) => h('th', { scope: 'col', class: numeric.includes(i) ? 'num' : null }, t))));
  const tbody = h('tbody', {}, rows);
  const t = h('table', {}, h('caption', { class: 'sr-only' }, caption), thead, tbody, foot);
  if (numeric.length) {
    for (const tr of [...rows, ...(foot ? foot.querySelectorAll('tr') : [])]) {
      if (!tr.classList?.contains('detail')) numeric.forEach((i) => tr.children[i]?.classList.add('num'));
    }
  }
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': caption, tabindex: '0', 'data-focus-key': 'table' }, t);
}

// `key` identifies the row within its table, so focus can be restored after a re-render.
function row(key, ...cells) {
  return h('tr', { 'data-row-key': key }, cells.map((c) => h('td', {}, c ?? '—')));
}

function updateClockCells() {
  for (const el of document.querySelectorAll('[data-at]')) {
    const text = relText(Number(el.getAttribute('data-at')), el.hasAttribute('data-bare'));
    if (el.textContent !== text) el.textContent = text;
  }
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

// Give every focusable element a key that is stable across re-renders and unique
// within its section: "row:<row key>#<n>" inside a keyed row, "section#<n>" elsewhere.
function assignFocusKeys(container) {
  const counts = new Map();
  for (const el of container.querySelectorAll(FOCUSABLE)) {
    if (el.hasAttribute('data-focus-key')) continue;
    const owner = el.closest('[data-row-key]');
    const scope = owner && container.contains(owner) ? `row:${owner.getAttribute('data-row-key')}` : 'section';
    const n = counts.get(scope) ?? 0;
    counts.set(scope, n + 1);
    el.setAttribute('data-focus-key', `${scope}#${n}`);
  }
}

// Replace a section's content; if focus was inside it, put focus back on the element
// with the same key in the same section, else on its table or lane region, else on the
// section itself (every section container has tabindex="-1"), so focus never drops to body.
function replaceSection(id, ...nodes) {
  const el = $(id);
  const active = document.activeElement;
  const hadFocus = active && active !== document.body && active !== el && el.contains(active);
  const key = hadFocus ? active.getAttribute('data-focus-key') : null;
  el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
  assignFocusKeys(el);
  if (!hadFocus) return;
  const target = (key && el.querySelector(`[data-focus-key="${CSS.escape(key)}"]`))
    ?? el.querySelector('[data-focus-key="table"]')
    ?? el;
  target.focus({ preventScroll: true });
}

// A row built from one malformed event shows a placeholder instead of breaking its table.
function safeRow(key, columns, build) {
  try {
    return build();
  } catch (err) {
    return h('tr', { 'data-row-key': key }, h('td', { colspan: String(columns), class: 'problem' }, `Couldn't show this row: ${err?.message ?? err}`));
  }
}

// One section failing must never stop the others from rendering.
function safe(id, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`dashboard: rendering #${id} failed`, err);
    try {
      replaceSection(id, h('p', { class: 'empty problem' }, `Couldn't show this section: ${err?.message ?? err}`));
    } catch {
      /* the container itself is missing */
    }
  }
}

// ---------------------------------------------------------------------------
// Loading

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function readRate(res) {
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (limit != null && remaining != null) {
    state.rate = { limit: Number(limit), remaining: Number(remaining), reset: reset ? Number(reset) * 1000 : null };
  }
}

// Spread the remaining requests over the time left in the rate-limit window.
// Unauthenticated 304s still count against the 60/h limit, so without a token
// this settles at about one check a minute; with a token it stays at POLL_S.
function nextDelayMs(minSeconds) {
  let ms = minSeconds * 1000;
  const r = state.rate;
  if (r && r.reset && r.reset > Date.now()) {
    const left = r.reset - Date.now();
    if (r.remaining <= 0) return left + 2000;
    ms = Math.max(ms, Math.ceil(left / Math.max(1, r.remaining - 5)));
  }
  return ms;
}

// Lists the day files that exist at the head commit, so missing days aren't fetched
// (each 404 would log a console error). One API call per head change. Returns null if
// the listing isn't usable, and the caller then falls back to fetching every day.
async function listAuditFiles(sha) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${API}/repos/${REPO}/git/trees/${sha}:audit?recursive=1`, {
      headers, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    readRate(res);
    if (res.status === 404) return []; // no audit/ directory at this commit
    if (!res.ok) return null;
    const body = await res.json();
    return body && Array.isArray(body.tree) && !body.truncated ? body.tree : null;
  } catch {
    return null;
  }
}

async function fetchDayFiles(sha) {
  const wanted = dayPaths(now(), DAYS);
  const listing = await listAuditFiles(sha);
  const paths = listing ? existingDayPaths(listing, wanted) : wanted;
  const texts = await Promise.all(paths.map(async (path) => {
    const res = await fetch(`${RAW}/${REPO}/${sha}/${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 404) return '';
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.text();
  }));
  return paths.flatMap((path, i) => parseJsonl(texts[i], path));
}

async function setRecords(records) {
  state.records = records;
  state.events = records.map((r) => r.event).filter((e) => e && typeof e === 'object' && e.payload && typeof e.payload === 'object');
  state.chain = await verifyChain(records);
  state.loaded = true;
  state.dataVersion++;
}

async function pollGitHub() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (state.etag) headers['If-None-Match'] = state.etag;
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${REPO}/branches/${BRANCH}`, {
    headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  readRate(res);
  state.lastCheck = Date.now();

  if (res.status === 304) {
    if (state.windowDay !== utcDay(now()) && state.headSha) await loadWindow(state.headSha);
    return POLL_S;
  }
  if (res.status === 404) {
    state.noLog = true;
    state.headSha = null;
    state.etag = res.headers.get('etag');
    await setRecords([]);
    return Math.max(POLL_S, MISSING_BRANCH_POLL_S);
  }
  if (res.status === 401) throw new Error('GitHub rejected the saved token (401). Forget it in Settings, or replace it.');
  if (res.status === 403 || res.status === 429) {
    if (state.rate && state.rate.remaining === 0) throw new Error('GitHub API rate limit reached; waiting for the reset.');
    throw new Error(`GitHub API refused the request (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(`GitHub API error (HTTP ${res.status}).`);

  const body = await res.json();
  const sha = body?.commit?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Unexpected branch response from GitHub.');
  state.noLog = false;
  if (sha !== state.headSha || state.windowDay !== utcDay(now())) await loadWindow(sha);
  // Keep the ETag only after the day files loaded, so a failed load is retried.
  state.etag = res.headers.get('etag');
  return POLL_S;
}

async function loadWindow(sha) {
  const records = await fetchDayFiles(sha);
  state.headSha = sha;
  state.windowDay = utcDay(now());
  await setRecords(records);
}

async function loadFixture() {
  const res = await fetch(FIXTURE_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load the fixture (HTTP ${res.status}).`);
  const records = parseJsonl(await res.text(), FIXTURE_URL);
  // Pin the clock just after the last fixture event, so ages read as they would live.
  const last = records.map((r) => parseTime(r.event?.timestamp)).filter((t) => t != null).pop();
  if (last != null) state.clockOffset = last + 12 * 60000 - Date.now();
  await setRecords(records);
}

async function fetchOpenPrs(repo) {
  const cached = state.prs.lists.get(repo);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${repo}/pulls?state=open&per_page=100`, {
    headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  readRate(res);
  if (res.status === 304 && cached) return cached;
  if (!res.ok) throw new Error(`${repo.split('/')[1]} PR list: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`${repo.split('/')[1]} PR list: unexpected response`);
  // Keep only what's shown or matched; PR bodies are used for the tier match and dropped.
  return { etag: res.headers.get('etag'), prs: body.map(summarizePr).filter((p) => p.number != null) };
}

// Open issues and PRs of the source repo (the issues list includes PRs), to drop closed ones from
// Needs you and Running. A full page may be truncated, so it counts as unknown (no filtering).
async function fetchOpenNumbers() {
  const cached = state.prs.open;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${REPO}/issues?state=open&per_page=100`, {
    headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  readRate(res);
  if (res.status === 304 && cached) return cached;
  if (!res.ok) throw new Error(`open issues: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('open issues: unexpected response');
  const numbers = body.length >= 100 ? null : new Set(body.map((i) => i.number).filter(isNum));
  return { etag: res.headers.get('etag'), numbers };
}

async function maybeRefreshPrs(headChanged) {
  const p = state.prs;
  if (headChanged) p.headDirty = true;
  const age = p.fetchedAt == null ? Infinity : Date.now() - p.fetchedAt;
  const due = !p.lastOk || age >= PR_MAX_AGE_MS || (p.headDirty && age >= PR_MIN_AGE_MS);
  if (!due) return;
  if (!p.lastOk && p.attemptedAt && Date.now() - p.attemptedAt < PR_RETRY_MS) return;
  p.attemptedAt = Date.now();
  if (state.rate && state.rate.remaining < PR_REPOS.length + 2) {
    p.lastOk = false;
    p.error = 'GitHub API rate limit is too low to read the PR lists';
    state.dataVersion++;
    return;
  }
  try {
    // The open-issues read is optional: if it fails, only closed-item filtering is off.
    const [open, ...lists] = await Promise.all([
      fetchOpenNumbers().catch(() => ({ etag: null, numbers: null })),
      ...PR_REPOS.map(fetchOpenPrs),
    ]);
    PR_REPOS.forEach((repo, i) => p.lists.set(repo, lists[i]));
    p.open = { ...open, at: Date.now() };
    p.fetchedAt = Date.now();
    p.lastOk = true;
    p.error = null;
    p.headDirty = false;
  } catch (err) {
    p.lastOk = false;
    p.error = err instanceof Error ? err.message : String(err);
  }
  state.dataVersion++;
}

/** True only if the latest PR-list read succeeded and is recent; never guess from stale data. */
function prsKnown() {
  return state.prs.lastOk && state.prs.fetchedAt != null && Date.now() - state.prs.fetchedAt <= PR_STALE_MS;
}

/** Open issue and PR numbers of the source repo now, or null when not known (no filtering). */
function openNumbers() {
  if (FIXTURE) return null;
  return prsKnown() ? state.prs.open?.numbers ?? null : null;
}

/** When the open numbers were read, on the page's clock (events are compared with it). */
function openNumbersAt() {
  const at = state.prs.open?.at;
  return isNum(at) ? at + state.clockOffset : null;
}

// True if the anchors branch exists; one API call (matching-refs answers 200 with [] when
// it doesn't, so nothing is logged as an error).
async function anchorsBranchExists() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${FACTORY_REPO}/git/matching-refs/heads/${ANCHORS_BRANCH}`, {
    headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  readRate(res);
  if (!res.ok) throw new Error(`anchors branch check: HTTP ${res.status}`);
  const refs = await res.json();
  if (!Array.isArray(refs)) throw new Error('anchors branch check: unexpected response');
  return refs.some((r) => r?.ref === `refs/heads/${ANCHORS_BRANCH}`);
}

// Never throws: a problem here only changes the verifier chip, not the page status.
async function maybeRefreshVerifier() {
  const v = state.verifier;
  const wait = v.status === 'missing' ? VERIFIER_PROBE_MS : v.status === 'error' && v.branchSeen ? VERIFIER_RETRY_MS : VERIFIER_MIN_MS;
  if (v.attemptedAt != null && Date.now() - v.attemptedAt < wait) return;
  const set = (status, { text = null, detail = null } = {}) => Object.assign(v, { status, text, detail });
  try {
    if (FIXTURE) {
      v.attemptedAt = Date.now();
      const res = await fetch(ANCHORS_FIXTURE_URL, { cache: 'no-store' });
      if (!res.ok) set('error', { detail: `HTTP ${res.status}` });
      else set('ok', { text: await res.text() });
      return;
    }
    if (!v.branchSeen) {
      if (state.rate && state.rate.remaining < 2) return; // try again on a later tick
      v.attemptedAt = Date.now();
      if (!(await anchorsBranchExists())) {
        set('missing');
        return;
      }
      v.branchSeen = true;
    }
    v.attemptedAt = Date.now();
    const res = await fetch(`${RAW}/${FACTORY_REPO}/${ANCHORS_BRANCH}/${ANCHORS_PATH}`, {
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (res.status === 404) {
      v.branchSeen = false;
      set('missing');
    } else if (!res.ok) set('error', { detail: `HTTP ${res.status}` });
    else set('ok', { text: await res.text() });
  } catch (err) {
    set('error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

// The sample's stand-in for the task map, contracts and Actions run lists (read once).
function loadFixtureMeta() {
  state.fixtureMeta ??= fetch(META_FIXTURE_URL, { cache: 'no-store' }).then((res) => {
    if (!res.ok) throw new Error(`sample meta: HTTP ${res.status}`);
    return res.json();
  });
  return state.fixtureMeta;
}

async function fetchRawText(path) {
  const res = await fetch(`${RAW}/${REPO}/main/${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

const contractPath = (id) => `contracts/${id.split('/').map(encodeURIComponent).join('/')}.yaml`;

// The task catalog: the task map, then every task's contract (tier, area, dependencies), all from
// raw.githubusercontent.com. Never throws: without the task map, the board falls back to the tasks
// seen in the events; a missing contract only leaves that task's tier unknown.
async function maybeRefreshMeta() {
  const mm = state.meta;
  const age = mm.fetchedAt == null ? Infinity : Date.now() - mm.fetchedAt;
  if (mm.status === 'ok' && age < META_MAX_AGE_MS) return;
  if (mm.status !== 'ok' && mm.attemptedAt != null && Date.now() - mm.attemptedAt < META_RETRY_MS) return;
  mm.attemptedAt = Date.now();
  try {
    let taskmap;
    let read;
    if (FIXTURE) {
      const meta = await loadFixtureMeta();
      taskmap = meta.taskmap;
      read = async (id) => meta.contracts?.[id] ?? null;
    } else {
      taskmap = await fetchRawText(TASKMAP_PATH);
      read = (id) => fetchRawText(contractPath(id)).catch(() => null);
    }
    const entries = parseTaskmap(taskmap);
    if (!entries.length) throw new Error('the task map lists no tasks');
    const texts = await Promise.all(entries.map((e) => read(e.id)));
    const contracts = new Map();
    entries.forEach((e, i) => {
      if (typeof texts[i] === 'string') contracts.set(e.id, parseContract(texts[i]));
    });
    Object.assign(mm, { status: 'ok', catalog: taskCatalog(entries, contracts), missing: entries.filter((e) => !contracts.has(e.id)).map((e) => e.id), error: null, fetchedAt: Date.now() });
  } catch (err) {
    mm.status = mm.catalog ? 'ok' : 'error';
    mm.error = err instanceof Error ? err.message : String(err);
  }
  state.dataVersion++;
}

async function fetchRunList(workflow) {
  const cached = state.runs.lists.get(workflow);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${REPO}/actions/workflows/${workflow}.lock.yml/runs?per_page=100`, {
    headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  readRate(res);
  if (res.status === 304 && cached) return cached;
  if (!res.ok) throw new Error(`${workflow} runs: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.workflow_runs)) throw new Error(`${workflow} runs: unexpected response`);
  const runs = body.workflow_runs.filter((r) => isNum(r?.id)).map((r) => ({
    id: r.id, created_at: typeof r.created_at === 'string' ? r.created_at : null, display_title: typeof r.display_title === 'string' ? r.display_title : '', workflow,
  }));
  return { etag: res.headers.get('etag'), runs };
}

// The run lists are read only when a spend snapshot names a run they don't list yet (each run id
// is looked for once), at most every 10 min, and only with API requests to spare. Never throws.
async function maybeRefreshRuns() {
  const r = state.runs;
  if (FIXTURE) {
    if (r.status === 'ok') return;
    try {
      const meta = await loadFixtureMeta();
      for (const wf of AGENT_WORKFLOWS) r.lists.set(wf, { etag: null, runs: (meta.runs?.[wf] ?? []).map((x) => ({ ...x, workflow: wf })) });
      Object.assign(r, { status: 'ok', error: null, fetchedAt: Date.now() });
    } catch (err) {
      Object.assign(r, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    state.dataVersion++;
    return;
  }
  const listed = new Set((agentRuns() ?? []).map((x) => x.id));
  const missing = [...snapshotRunIds(state.events)].filter((id) => !listed.has(id) && !r.tried.has(id));
  r.waitingForRate = false;
  if (!missing.length) return;
  if (r.attemptedAt != null && Date.now() - r.attemptedAt < RUNS_MIN_MS) return;
  if (state.rate && state.rate.remaining < AGENT_WORKFLOWS.length + RUNS_RESERVE) {
    r.waitingForRate = true;
    return;
  }
  r.attemptedAt = Date.now();
  try {
    const lists = await Promise.all(AGENT_WORKFLOWS.map(fetchRunList));
    AGENT_WORKFLOWS.forEach((wf, i) => r.lists.set(wf, lists[i]));
    Object.assign(r, { status: 'ok', error: null, fetchedAt: Date.now() });
    for (const id of missing) r.tried.add(id);
  } catch (err) {
    r.status = r.lists.size === AGENT_WORKFLOWS.length ? 'ok' : 'error';
    r.error = err instanceof Error ? err.message : String(err);
  }
  state.dataVersion++;
}

const doneMark = () => state.events.filter((e) => e.type === 'task_done' || e.type === 'merged').length;

// Never throws: on failure the last good map stays (and says so), or the board uses the audit log only.
async function maybeRefreshTaskIssues() {
  const ti = state.taskIssues;
  if (FIXTURE) {
    if (ti.map) return;
    try {
      const meta = await loadFixtureMeta();
      Object.assign(ti, { map: taskIssueMap((meta.issues ?? []).map(summarizeTaskIssue)), error: null, fetchedAt: Date.now(), doneMark: doneMark() });
    } catch (err) {
      ti.error = err instanceof Error ? err.message : String(err);
    }
    state.dataVersion++;
    return;
  }
  const age = ti.fetchedAt == null ? Infinity : Date.now() - ti.fetchedAt;
  const newDone = ti.doneMark != null && doneMark() !== ti.doneMark;
  if (!(ti.map == null || age >= TASK_ISSUES_MAX_AGE_MS || newDone)) return;
  if (ti.attemptedAt != null && Date.now() - ti.attemptedAt < TASK_ISSUES_MIN_MS) return;
  if (state.rate && state.rate.remaining < 1 + TASK_ISSUES_RESERVE) return; // try on a later tick
  ti.attemptedAt = Date.now();
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (ti.etag && ti.items) headers['If-None-Match'] = ti.etag;
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}/repos/${REPO}/issues?state=all&labels=${encodeURIComponent('factory:task')}&per_page=100`, {
      headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    readRate(res);
    if (res.status !== 304) {
      if (!res.ok) throw new Error(`task issues: HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('task issues: unexpected response');
      // Bodies are matched for the task marker and dropped.
      Object.assign(ti, { items: body.map(summarizeTaskIssue).filter(Boolean), etag: res.headers.get('etag'), truncated: body.length >= 100 });
    }
    Object.assign(ti, { map: taskIssueMap(ti.items), error: null, fetchedAt: Date.now(), doneMark: doneMark() });
  } catch (err) {
    ti.error = err instanceof Error ? err.message : String(err);
  }
  state.dataVersion++;
}

/** Every listed agent run, or null when the lists haven't been read. */
function agentRuns() {
  const r = state.runs;
  if (r.lists.size < AGENT_WORKFLOWS.length) return null;
  return [...r.lists.values()].flatMap((l) => l.runs);
}

async function tick() {
  clearTimeout(state.timer);
  if (state.busy) return;
  state.busy = true;
  let delayS = POLL_S;
  try {
    if (FIXTURE) {
      if (!state.loaded) await loadFixture();
      await maybeRefreshVerifier();
      await maybeRefreshMeta();
      await maybeRefreshTaskIssues();
      await maybeRefreshRuns();
    } else if (document.visibilityState === 'hidden' && state.loaded) {
      delayS = POLL_S; // don't spend requests on a hidden tab
    } else {
      const headBefore = state.headSha;
      try {
        delayS = await pollGitHub();
      } finally {
        await maybeRefreshPrs(state.headSha !== headBefore);
        await maybeRefreshVerifier();
        await maybeRefreshMeta();
        await maybeRefreshTaskIssues();
        await maybeRefreshRuns();
      }
    }
    state.error = null;
    if (state.loaded) state.lastOkAt = Date.now();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.etag = null;
  } finally {
    state.busy = false;
  }
  const delay = FIXTURE ? POLL_S * 1000 : nextDelayMs(delayS);
  state.nextCheckAt = Date.now() + delay;
  state.timer = setTimeout(tick, delay);
  render();
}

// ---------------------------------------------------------------------------
// Rendering

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el;
}

function icon(name, cls = '') {
  return svg('svg', { class: `i ${cls}`.trim(), 'aria-hidden': 'true', focusable: 'false' }, svg('use', { href: `#i-${name}` }));
}

// Widths are set through the CSSOM, which the CSP allows (no style attributes).
function withWidth(el, pct) {
  el.style.width = `${Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))}%`;
  return el;
}


/** Everything the page shows that's derived from the events plus the side reads, in one place. */
function buildView(m) {
  const t = now();
  const catalog = state.meta.catalog ?? (state.meta.status === 'error' ? fallbackCatalog(state.events) : []);
  const board = taskBoard(state.events, catalog, { open: openNumbers(), asOf: openNumbersAt(), needsItems: m.needsYou.items, issues: state.taskIssues.map });
  const dispatch = latestDispatchState(state.events);
  const cost = costJoin(state.events, agentRuns(), { now: t, days: MEDIAN_DAYS });
  const doneIds = board.tasks.filter((x) => x.state === 'done').map((x) => x.id);
  return {
    board,
    dispatch,
    banner: dispatchBanner(state.events, { now: t }),
    state: stateLine({ loaded: state.loaded, board, dispatch }),
    cost,
    taskCost: medianTaskCost(cost, doneIds),
    toMerged: issueToMerged(state.events, { now: t, days: MEDIAN_DAYS }),
    quality: qualityStats(state.events),
    human: humanTouch(state.events, { now: t, days: HUMAN_DAYS }),
    live: liveness(state.events, { now: t, inFlight: board.counts.running > 0, dispatch }),
    recent: recentActivity(state.events, { limit: 5 }),
  };
}

// Rebuilds a section only when what it shows changed or new data arrived, so focus, open tooltips
// and text selections survive the 15-second clock refresh (a rebuild puts focus back, see
// replaceSection).
function renderIf(id, sigOf, build, full) {
  safe(id, () => {
    const sig = JSON.stringify([state.dataVersion, sigOf]);
    if (!full && state.sigs.get(id) === sig && $(id).childNodes.length) return;
    state.sigs.set(id, sig);
    build();
  });
}

function render({ full = false } = {}) {
  let m = null;
  let v = null;
  let metricsError = null;
  try {
    m = dropClosed(deriveMetrics(state.events, { now: now() }), openNumbers(), openNumbersAt());
    v = buildView(m);
  } catch (err) {
    metricsError = err;
    console.error('dashboard: deriving the view failed', err);
  }
  const withMetrics = (fn) => () => {
    if (!m || !v) throw metricsError;
    fn(m, v);
  };
  let needs = null;
  try {
    if (m) needs = needsView(m);
  } catch (err) {
    console.error('dashboard: deriving Needs you failed', err);
  }
  try {
    renderHeader(m, v);
  } catch (err) {
    setStatus(`Problem showing the header: ${err?.message ?? err}`);
  }
  const loaded = state.loaded;
  const known = FIXTURE || prsKnown();
  renderIf('numbers', [loaded, v && numbersSig(v)], withMetrics((mm, vv) => renderNumbers(vv)), full);
  renderIf('needs', [loaded, state.error, known, needs?.rs, needs?.items.map((i) => [i.key, i.since, i.title, i.reason])], withMetrics((mm) => renderNeeds(mm, needs ?? needsView(mm))), full);
  renderIf('board', [loaded, state.meta.status, state.meta.error, state.taskIssues.error, state.taskIssues.map != null, v?.board.tasks.map((x) => [x.id, x.state, x.since, x.reason, x.issue, x.tier, x.prs])], withMetrics((mm, vv) => renderBoard(vv)), full);
  renderIf('cost', [loaded, v && costSig(m, v)], withMetrics((mm, vv) => renderCost(mm, vv)), full);
  renderIf('quality', [loaded, v?.quality], withMetrics((mm, vv) => renderQuality(vv)), full);
  renderIf('human', [loaded, v?.human], withMetrics((mm, vv) => renderHuman(vv)), full);
  renderIf('live', [loaded, v && liveSig(m, v)], withMetrics((mm, vv) => renderLive(mm, vv)), full);
  renderIf('recent', [loaded, v?.recent.map((r) => [r.text, r.at])], withMetrics((mm, vv) => renderRecent(vv)), full);
  if (full || state.renderedVersion !== state.dataVersion || state.prsKnownRendered !== known) {
    state.renderedVersion = state.dataVersion;
    state.prsKnownRendered = known;
    safe('checks', withMetrics(renderChecks));
    safe('stages', withMetrics(renderStages));
    safe('timeline', withMetrics(renderTimeline));
    safe('events', renderEvents);
  }
  updateClockCells();
  refreshTip();
  // Readiness marker for tests and tools: data (or its error) is shown, and in live mode the
  // open-PR lists, the task catalog and (when needed) the run lists have been read or have failed.
  const settled = state.loaded || state.error || state.noLog;
  const sidesRead = FIXTURE || state.prs.fetchedAt != null || state.prs.error;
  if (settled && sidesRead && state.meta.status !== 'pending') document.documentElement.dataset.ready = '1';
}

// ---------------------------------------------------------------------------
// Tooltips. Each tip's text sits in a hidden span that the target references with
// aria-describedby (icon buttons may use data-tip next to their aria-label instead).
// One shared popover (#tip, aria-hidden because the description already reaches
// assistive tech) shows the text on hover and on keyboard focus; Escape hides it.

let tipSeq = 0;
const NATIVE_FOCUS = 'a[href], button, input, select, textarea, summary';

function tip(el, text) {
  if (text == null || text === '') return el;
  const id = `tip-${++tipSeq}`;
  el.append(h('span', { id, class: 'tip-src', hidden: true }, text));
  el.setAttribute('aria-describedby', id);
  el.classList.add('has-tip');
  if (!el.matches(NATIVE_FOCUS) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  return el;
}

/** Sets the text of a static element's tip span (id `<id>-tip`). */
function setTip(id, text) {
  const src = $(`${id}-tip`);
  if (src && src.textContent !== text) src.textContent = text;
}

function tipTextOf(el) {
  if (el.dataset.tip) return el.dataset.tip;
  return (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '').filter(Boolean).join('\n');
}

const tipState = { target: null, hover: null };

function showTip(target) {
  const pop = $('tip');
  const text = tipTextOf(target);
  if (!text) {
    hideTip();
    return;
  }
  tipState.target = target;
  if (pop.textContent !== text) pop.textContent = text;
  pop.hidden = false;
  placeTip();
}

function placeTip() {
  const pop = $('tip');
  const t = tipState.target;
  if (!t || pop.hidden) return;
  const r = t.getBoundingClientRect();
  const w = pop.offsetWidth;
  const ht = pop.offsetHeight;
  const below = r.bottom + 6;
  const top = below + ht > innerHeight - 4 && r.top - ht - 6 > 0 ? r.top - ht - 6 : below;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  pop.style.top = `${top}px`;
}

function hideTip() {
  tipState.target = null;
  $('tip').hidden = true;
}

// After a re-render, keep the tip on the element that has focus (or hide it).
function refreshTip() {
  const t = tipState.target;
  if (!t) return;
  if (t.isConnected) showTip(t);
  else if (document.activeElement?.classList?.contains('has-tip')) showTip(document.activeElement);
  else hideTip();
}

function initTips() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('.has-tip') ?? null;
    tipState.hover = t;
    if (t && t !== tipState.target) showTip(t);
    else if (!t && tipState.target && !e.target.closest?.('#tip') && document.activeElement !== tipState.target) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('has-tip')) showTip(e.target);
    else if (tipState.target && tipState.target !== tipState.hover) hideTip();
  });
  document.addEventListener('focusout', (e) => {
    if (e.target === tipState.target && tipState.hover !== e.target) hideTip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tipState.target) hideTip();
  });
  addEventListener('scroll', placeTip, { passive: true, capture: true });
  addEventListener('resize', placeTip);
}

// ---------------------------------------------------------------------------
// Header: the status line (health, kill switch, plain-English state, dry run)

// "loading" is neutral on purpose: before the first load nothing is known to be wrong.
const TONE = { ok: 'ok', warn: 'warn', alert: 'alert', info: 'info', loading: 'muted' };
const LEVEL_ICON = { ok: 'ok', warn: 'warn', alert: 'fail', info: 'dot', loading: null };
const HB_WARN = formatLimit(DEFAULTS.heartbeatWarnMin);
const HB_ALERT = formatLimit(DEFAULTS.heartbeatAlertMin);
const VF_WARN = formatLimit(VERIFIER_LIMITS.warnMin);
const VF_ALERT = formatLimit(VERIFIER_LIMITS.alertMin);
const HEALTH_RULE = `Healthy: fresh data, verified chain, heartbeat within ${HB_WARN}, verifier anchor within ${VF_WARN}.\n`
  + `Degraded: last refresh failed, data over ${STALE_DATA_MIN} min old, heartbeat late (over ${HB_WARN}), chain not verified, verifier late (over ${VF_WARN}) or not set up.\n`
  + `Down: no audit log, broken chain, heartbeat missing or over ${HB_ALERT}, verifier over ${VF_ALERT} or unreadable.\n`
  + 'Paused: dispatch held by a gate (spend, budget, Actions load), nothing else wrong.';
const STATE_ICON_NAME = { ok: 'ok', warn: 'warn', info: 'play', loading: null };

/** The anchors in the verifier file, or [] if it isn't loaded or isn't valid. */
function loadedAnchors() {
  if (state.verifier.status !== 'ok') return [];
  const parsed = parseAnchors(state.verifier.text);
  return parsed.problem ? [] : parsed.anchors;
}

/** Tooltip lines with the cadence the scheduled jobs really ran at, from the loaded data. */
function cadenceLines(anchors = loadedAnchors()) {
  return {
    heartbeat: cadenceText('Heartbeats', observedCadence(heartbeatTimes(state.events)), DAYS),
    verifier: cadenceText('Verifications', observedCadence(anchorTimes(anchors, { now: now(), days: DAYS })), DAYS),
  };
}

function setStatus(text) {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text; // only real changes are announced
}

/** Fills a static chip: icon, text and the tip span `<id>-tip`. */
function setChip(id, { hidden = false, tone = null, iconName = null, text = '', tipText = '' }) {
  const el = $(id);
  el.hidden = hidden;
  if (hidden) return;
  el.className = `chip${tone ? ` chip--${tone}` : ''} has-tip`;
  el.replaceChildren(...(iconName ? [icon(iconName)] : []), h('span', {}, text), h('span', { id: `${id}-tip`, class: 'tip-src', hidden: true }, tipText));
  el.setAttribute('aria-describedby', `${id}-tip`);
}

function stateTip(v) {
  const c = v.board.counts;
  const lines = [
    v.board.total ? `Tasks: ${c.done} done, ${c.running} running, ${c.needs} need you, ${c.waiting} waiting (of ${v.board.total}).` : 'No tasks in the catalog yet.',
  ];
  if (v.banner) lines.push('', v.banner.text.replace(/ (since|\(recorded) [^:]*:/, ':'), v.banner.tip);
  else if (v.dispatch?.state === 'running') lines.push('', 'The controller is dispatching work.');
  lines.push('', 'Running: work started on a task and not merged yet. Paused: dispatch held by a gate. Waiting: tasks ready for a free slot, or blocked by dependencies. Idle: nothing to do.');
  return lines.join('\n');
}

function renderHeader(m, v) {
  const chain = state.chain;
  const hb = m?.heartbeat ?? null;
  const dataAgeMin = FIXTURE || state.lastOkAt == null ? null : (Date.now() - state.lastOkAt) / 60000;
  const verifier = verifierStatus(state.verifier, now());
  const health = healthSummary({ loaded: state.loaded, noLog: state.noLog, error: state.error, chain, heartbeat: hb, dataAgeMin, verifier, dispatch: v?.banner ?? null });
  const detail = statusSummary({
    loaded: state.loaded, noLog: state.noLog, error: state.error, fixture: FIXTURE,
    eventCount: state.events.length, headSha: state.headSha, days: DAYS, heartbeat: hb,
  });
  const chainLine = !chain || chain.status === 'empty' ? (state.loaded ? 'Chain: no events' : 'Chain: not loaded')
    : chain.status === 'verified'
      ? `Chain verified: ${chain.total} event${chain.total === 1 ? '' : 's'}, ${chain.windowStart === 'genesis' ? 'back to the first event of the log' : 'every hash and parent link in the window'}`
      : `Chain broken at event ${chain.brokenAt} (${chain.brokenSource}: ${chain.brokenReason})`;
  setChip('health', {
    tone: TONE[health.level], iconName: LEVEL_ICON[health.level], text: health.level === 'loading' ? `… ${health.label}` : health.label,
    tipText: [...(health.level === 'ok' ? [] : health.reasons), detail.text, chainLine,
      ...(health.reasons.includes(verifierReason(verifier)) ? [] : [verifierReason(verifier)]), '', HEALTH_RULE,
      ...(state.loaded ? (({ heartbeat, verifier: vf }) => ['', `Observed: ${heartbeat}`, `Observed: ${vf}`, CADENCE_NOTE])(cadenceLines()) : [])].join('\n'),
  });
  setStatus(`Factory ${health.label}${health.level !== 'ok' && health.reasons.length ? `: ${health.reasons[0]}` : ''}${v && state.loaded ? `. ${v.state.text}` : ''}`);
  renderVerifierLine(verifier);

  const enabled = m?.killSwitch?.enabled ?? null;
  setChip('kill-chip', {
    // Off is the deliberate, safe state: neutral grey, not red (red means Down).
    hidden: enabled == null, tone: enabled ? 'ok' : 'muted', iconName: 'power', text: enabled ? 'Factory on' : 'Factory off',
    tipText: `factory_enabled from the latest heartbeat${m?.killSwitch?.at ? ` (${relativeTime(parseTime(m.killSwitch.at), now())}, ${m.killSwitch.at})` : ''}; off means no new dispatches`,
  });
  const st = v?.state ?? null;
  setChip('state-chip', st && state.loaded
    ? { tone: TONE[st.level] ?? 'info', iconName: STATE_ICON_NAME[st.level] ?? 'dot', text: st.text, tipText: stateTip(v) }
    : { hidden: true });
  const dryRun = m?.dryRun ?? null;
  const version = m?.factoryVersion ?? null;
  // Live is the normal state, so only a dry run gets a chip (the version is in the "updated" tooltip).
  setChip('dry-badge', {
    hidden: dryRun !== true, tone: 'warn', iconName: 'info', text: 'Dry run',
    tipText: `Decisions are logged, not acted on${version ? `\nFactory version ${version}` : ''}`,
  });
  setChip('mode-badge', { hidden: !FIXTURE, tone: 'info', iconName: 'info', text: 'Sample', tipText: `Sample data from ${FIXTURE_URL}, clock pinned at ${iso(now())}. Remove ?fixture=${FIXTURE_PARAM} for live data.` });

  const meta = [];
  if (FIXTURE) meta.push(`sample data from ${FIXTURE_URL}`);
  else {
    if (state.lastCheck) meta.push(`checked ${relativeTime(state.lastCheck, Date.now())}`);
    if (state.nextCheckAt) meta.push(`next ${relativeTime(state.nextCheckAt, Date.now())}`);
    const r = state.rate;
    if (r) meta.push(`API ${r.remaining}/${r.limit} left` + (r.reset ? `, resets ${relativeTime(r.reset, Date.now())}` : ''));
    meta.push(getToken() ? 'your token' : 'no token');
  }
  const age = state.lastOkAt == null ? null : compactAge(Date.now() - state.lastOkAt);
  $('updated-text').textContent = age ? `updated ${age} ago` : state.error ? 'not updated' : 'loading…';
  setTip('updated', [
    `${REPO}, ${BRANCH} branch, last ${DAYS} UTC days`,
    meta.join(' · '),
    version ? `Factory version ${version}` : null,
    `Checks every ${POLL_S} s at most, about once a minute without a token.`,
  ].filter(Boolean).join('\n'));
  $('meta-settings').textContent = meta.length ? `Now: ${meta.join(' · ')}.` : '';
  $('poll-hint').textContent = `Checks every ${POLL_S} s at most (?poll=N), spread out to stay within the rate limit: about once a minute without a token. Window: ${DAYS} days (?days=N).`;
}

// The independent verifier has no chip of its own: it's part of the health chip (and its
// tooltip). The audit-log section keeps a muted detail line.
function renderVerifierLine(v) {
  const line = $('verifier-line');
  if (line.textContent !== v.line) line.textContent = v.line;
}

// ---------------------------------------------------------------------------
// Key numbers: number + short label; the definition and detail are in each tooltip

const STATE_ICON = { done: 'ok', running: 'play', needs: 'warn', waiting: 'wait' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function numTile({ key, label, iconName, value, sub = null, tipText, level = null }) {
  const el = h('article', { class: `panel ntile${level ? ` ntile--${level}` : ''}`, 'data-row-key': key },
    h('h3', { class: 'num-l' }, icon(iconName), label),
    h('p', { class: 'num-v' }, value),
    sub ? h('p', { class: 'num-s' }, sub) : null);
  return tip(el, tipText);
}

function numbersSig(v) {
  return [state.taskIssues.error, state.taskIssues.map != null, v.board.counts, v.board.byTier, v.board.total, v.toMerged.medianMs, v.toMerged.count, v.taskCost, v.cost.known, state.runs.status, state.runs.error, state.meta.status];
}

function tierSplit(byTier) {
  const order = ['auto', 'auto-strict', ...Object.keys(byTier).filter((k) => k !== 'auto' && k !== 'auto-strict')];
  return order.filter((k) => byTier[k]).map((k) => `${k} ${byTier[k].done}`);
}

/** Why a cost needing the run lists is "—", or null when it's known. */
function runsProblem(v) {
  if (v.cost.known) return null;
  const r = state.runs;
  if (!v.cost.measuredRuns) return 'No measured agent runs in the spend snapshots yet.';
  if (r.waitingForRate) return 'Waiting for API requests to spare (the GitHub rate limit) before reading the agent run lists.';
  if (r.error) return `Couldn't read the agent run lists (implement, repair, review): ${r.error}.`;
  return 'Reading the agent run lists…';
}

function renderNumbers(v) {
  if (!state.loaded) {
    replaceSection('numbers', ['Tasks done', 'Issue → merged', 'Cost per task'].map((label, i) => numTile({ key: `n${i}`, label, iconName: ['grid', 'clock', 'coin'][i], value: '…', tipText: 'Loading the audit log' })));
    return;
  }
  const b = v.board;
  const c = b.counts;
  const tiers = Object.entries(b.byTier).map(([k, x]) => `${k}: ${x.done} of ${x.total} done`);
  const itm = v.toMerged;
  const sorted = itm.items.slice().sort((a, x) => a.ms - x.ms);
  const why = runsProblem(v);
  const tc = v.taskCost;
  replaceSection('numbers',
    numTile({
      key: 'done', label: 'Tasks done', iconName: 'grid', value: b.total ? `${c.done}/${b.total}` : '—',
      sub: b.total ? tierSplit(b.byTier).join(' · ') : null,
      level: b.total && c.done === b.total ? 'ok' : null,
      tipText: [
        b.total ? `${c.done} of ${b.total} tasks done (merged).` : 'No tasks in the catalog yet.',
        ...tiers,
        `Also: ${c.running} running, ${c.needs} need you, ${c.waiting} waiting.`,
        'Tasks are the task map\'s entries; drill/* tasks were fire drills and are not counted.',
        taskIssuesLine(),
      ].join('\n'),
    }),
    numTile({
      key: 'merge', label: 'Issue → merged', iconName: 'clock', value: shortDuration(itm.medianMs), sub: `median, ${MEDIAN_DAYS} days`,
      tipText: [
        itm.count ? `Median ${shortDuration(itm.medianMs)} over ${plural(itm.count, 'task')} merged in the last ${MEDIAN_DAYS} days.` : `No task merged in the last ${MEDIAN_DAYS} days.`,
        itm.count ? `Fastest ${shortDuration(sorted[0].ms)}, slowest ${shortDuration(sorted.at(-1).ms)}.` : null,
        'From the task\'s first auto_ready (else its first dispatch) to its merge. Drills and plain PRs are left out.',
        DAYS < MEDIAN_DAYS ? `Only ${DAYS} days are loaded (?days=${DAYS}).` : null,
      ].filter(Boolean).join('\n'),
    }),
    numTile({
      key: 'cost', label: 'Cost per task', iconName: 'coin', value: why || tc.medianAic == null ? '—' : formatUsd(tc.medianAic), sub: 'median',
      tipText: [
        why ?? (tc.count ? `Median ${formatUsd(tc.medianAic)} (${Math.round(tc.medianAic).toLocaleString('en-US')} AIC) over ${plural(tc.count, 'done task')} with attributed cost.` : 'No done task with attributed cost yet.'),
        'A task\'s cost: the latest measured AIC of each implement, repair and review run attributed to it (1 AIC = $0.01).',
        'Runs come from the controller\'s spend snapshots, joined with the Actions run lists by title or dispatch time.',
      ].join('\n'),
    }));
}

// ---------------------------------------------------------------------------
// Needs you: the count, then one line per item

function reviewState() {
  if (FIXTURE) return 'sample';
  if (prsKnown()) return 'ok';
  return state.prs.fetchedAt == null && !state.prs.error ? 'pending' : 'unavailable';
}

function needsView(m) {
  const rs = reviewState();
  const reviews = rs === 'ok' ? reviewItems(PR_REPOS.map((repo) => ({ repo, prs: state.prs.lists.get(repo)?.prs ?? [] })), now()) : [];
  return { rs, items: combineNeedsYou(m.needsYou.items, reviews, REPO) };
}

function viewLink(href, text) {
  const a = link(href, text);
  a.classList.add('btn', 'btn--small');
  return a;
}

// At most 3 lines, each a ref, a 2-word title and a "View" button; the rest is in the tooltip.
const NEEDS_SHOWN = 3;
const NEEDS_TITLE_WORDS = 2;

function needsLines(it) {
  const since = it.since ? parseTime(it.since) : null;
  const waited = since == null ? null : `Waiting ${formatDuration(now() - since)}, since ${iso(since)}`;
  if (it.kind === 'review') {
    return { iconName: 'person', kind: 'Review and merge', ref: prRef(it.repo, it.number, REPO), title: it.title || '(no title)', since,
      lines: [`Review and merge ${it.repo.split('/')[1]}#${it.number}`, it.title || '(no title)', waited], action: viewLink(it.url, 'View PR') };
  }
  const kind = it.kind === 'needs_human' ? 'Needs human' : 'Stale contract';
  const title = it.task ? shortTaskName(it.task) : it.pr != null ? `PR #${it.pr}` : `issue #${it.issue ?? '?'}`;
  return {
    iconName: it.kind === 'needs_human' ? 'warn' : 'clock', kind, ref: it.issue != null ? `#${it.issue}` : it.pr != null ? `#${it.pr}` : '—', title, since,
    lines: [`${kind}: ${it.task ?? title}`, it.reason ? `Reason: ${it.reason}` : null, it.effect ? `Effect: ${it.effect}` : null, waited],
    action: it.issue != null ? viewLink(`${GH}/${REPO}/issues/${it.issue}`, 'View issue') : it.pr != null ? viewLink(`${GH}/${REPO}/pull/${it.pr}`, 'View PR') : null,
  };
}

function needsRow(it) {
  const x = needsLines(it);
  return h('li', { 'data-row-key': it.key },
    h('span', { class: `needs-icon${it.kind === 'needs_human' ? ' needs-icon--alert' : ''}`, role: 'img', 'aria-label': x.kind }, icon(x.iconName)),
    h('span', { class: 'needs-ref mono' }, x.ref),
    tip(h('span', { class: 'needs-t' }, shortTitle(x.title, NEEDS_TITLE_WORDS)), x.lines.filter(Boolean).join('\n')),
    x.action ?? h('span'));
}

function renderNeeds(m, view = needsView(m)) {
  const cap = DEFAULTS.humanQueueMax;
  const { rs, items } = view;
  const panel = $('needs-panel');
  if (!state.loaded && !state.error) {
    panel.classList.remove('needs--clear', 'needs--some');
    replaceSection('needs', h('p', { class: 'num-v' }, '…'));
    return;
  }
  const about = [
    'Needs-human items, stale contracts and human-tier PRs waiting for your review, oldest first.',
    'Items whose issue or PR is closed now are left out.',
    `Above ${cap}, the controller stops admitting new human-tier work.`,
    rs === 'sample' ? 'Sample data: review items are read live from GitHub, so none are shown here.' : null,
    rs === 'unavailable' ? `Review list unavailable: ${state.prs.error ?? 'the PR lists are out of date'}, so PRs waiting for your review aren't counted.` : null,
    rs === 'pending' ? 'Still reading the open-PR lists for reviews.' : null,
  ].filter(Boolean).join('\n');
  const clear = !items.length && (rs === 'ok' || rs === 'sample');
  panel.classList.toggle('needs--clear', clear);
  panel.classList.toggle('needs--some', items.length > 0);
  const head = tip(h('p', { class: 'num-v needs-n' },
    clear ? h('span', { class: 'needs-ok', role: 'img', 'aria-label': 'Nothing needs you' }, icon('ok'))
      : rs === 'unavailable' ? h('span', { class: 'needs-ok', role: 'img', 'aria-label': 'Review list unavailable' }, icon('question')) : null,
    h('span', {}, String(items.length)),
    items.length > cap ? h('span', { class: 'needs-cap', role: 'img', 'aria-label': `Over the cap of ${cap}` }, icon('warn')) : null),
  `${items.length ? `${plural(items.length, 'item')} waiting for you.` : 'Nothing needs you.'}\n${about}`);
  if (!items.length) {
    replaceSection('needs', head);
    return;
  }
  const shown = items.slice(0, NEEDS_SHOWN);
  replaceSection('needs', head,
    h('ul', { class: 'needs-list' }, shown.map((it) => {
      try {
        return needsRow(it);
      } catch (err) {
        return h('li', { class: 'problem', 'data-row-key': it.key ?? '?' }, `Couldn't show this item: ${err?.message ?? err}`);
      }
    })),
    items.length > NEEDS_SHOWN ? tip(h('p', { class: 'needs-more' }, `+${items.length - NEEDS_SHOWN}`),
      items.slice(NEEDS_SHOWN).map((it) => { const x = needsLines(it); return `${x.ref} ${x.title}`; }).join('\n')) : null);
}

// ---------------------------------------------------------------------------
// Task board: one tile per task, grouped by contract area, coloured by state with an icon

function boardTile(t) {
  const href = t.issue != null ? `${GH}/${REPO}/issues/${t.issue}` : `${GH}/${REPO}/blob/main/${contractPath(t.id)}`;
  const word = TASK_STATE_LABELS[t.state];
  const lines = [
    `${t.id}${t.title ? ` · ${t.title}` : ''}`,
    `Tier: ${t.tier ?? 'unknown'}`,
    `State: ${word}${t.reason && t.reason !== 'merged' ? ` (${t.reason})` : ''}`,
    t.issueState ? `Issue: ${t.issueState === 'completed' ? 'closed as completed' : t.issueState === 'closed' ? 'closed, not completed' : 'open'}` : state.taskIssues.map ? 'No task issue found' : null,
    t.since != null ? `Since ${relativeTime(t.since, now())} (${iso(t.since)})` : null,
    [t.issue != null ? `Issue #${t.issue}` : null, t.prs.length ? `PR ${t.prs.map((n) => `#${n}`).join(', ')}` : null].filter(Boolean).join(' · ') || null,
    t.issue != null ? `View issue #${t.issue} on GitHub` : 'View its contract on GitHub (no issue in the loaded events)',
  ];
  const a = h('a', { class: `tile tile--${t.state}`, href, rel: 'noopener noreferrer', 'aria-label': `${t.short}: ${word}` },
    h('span', { class: 'tile-i' }, icon(STATE_ICON[t.state])),
    h('span', { class: 'tile-n' }, t.short));
  return h('li', { 'data-row-key': t.id }, tip(a, lines.filter(Boolean).join('\n')));
}

/** Where the done states come from, for the tooltips. */
function taskIssuesLine() {
  const ti = state.taskIssues;
  if (ti.map && !ti.error) return `Done = task issue closed as completed (or, while it's open, the controller's task_done). Task issues read ${relativeTime(ti.fetchedAt + state.clockOffset, now())}.${ti.truncated ? ' The list is a full page of 100, so some may be missing: those use the audit log.' : ''}`;
  if (ti.map) return `Couldn't refresh the task issues (${ti.error}); using the list read ${relativeTime(ti.fetchedAt + state.clockOffset, now())}.`;
  if (ti.error) return `Task issues unavailable (${ti.error}): done comes from the audit log only (merged or task_done in the last ${DAYS} days).`;
  return 'Reading the task issues…';
}

function renderBoard(v) {
  const b = v.board;
  const mm = state.meta;
  const legend = $('board-legend');
  // With every task in one state the "Tasks done" number already says it; the tiles' icons and
  // labels carry the state either way.
  const present = TASK_STATES.filter((st) => b.counts[st]);
  legend.replaceChildren(...(state.loaded && present.length > 1 ? present.map((st) => h('span', { class: `lg lg--${st}` }, icon(STATE_ICON[st]), `${b.counts[st]} ${TASK_STATE_LABELS[st]}`)) : []));
  setTip('board-info', [
    'One tile per task of the task map, grouped by its contract area. Select a tile to view its issue on GitHub.',
    'Done: merged. Running: work started (implement, repair or review agent, checks, merge queue) and not merged, issue open. Needs you: an open needs-human item. Waiting: a dependency not done, or ready for a free slot.',
    'Drill tasks (drill/*) were fire drills of the factory and are not shown.',
    taskIssuesLine(),
    mm.status === 'error' ? `Task map unavailable (${mm.error}): showing the tasks seen in the audit log.` : null,
    mm.missing.length ? `Contracts not read: ${mm.missing.join(', ')}.` : null,
  ].filter(Boolean).join('\n'));
  if (!state.loaded) {
    replaceSection('board', empty('… Loading'));
    return;
  }
  if (!b.total) {
    replaceSection('board', empty(mm.status === 'pending' ? '… Reading the task map' : 'No tasks yet'));
    return;
  }
  replaceSection('board',
    mm.status === 'error' ? tip(h('p', { class: 'board-note' }, icon('warn'), 'Task map unavailable'), `${mm.error}. Showing the tasks seen in the audit log.`) : null,
    b.groups.map((g, i) => h('div', { class: 'group', role: 'group', 'aria-labelledby': `group-${i}` },
      h('h3', { class: 'group-h', id: `group-${i}` }, g.label),
      h('ul', { class: 'tiles' }, g.tasks.map(boardTile)))));
}

// ---------------------------------------------------------------------------
// Small panels: number + label rows, the detail in each row's tooltip

function stat({ value, label, tipText, level = null, labelFirst = false, key }) {
  const v = h('b', { class: `stat-v${level ? ` stat-v--${level}` : ''}` }, value);
  const l = h('span', { class: 'stat-l' }, label);
  return tip(h('p', { class: 'stat', 'data-row-key': key }, ...(labelFirst ? [l, ' ', v] : [v, ' ', l])), tipText);
}

const aic = (n) => `${Math.round(n).toLocaleString('en-US')} AIC`;

function costSig(m, v) {
  return [m.aicToday, v.cost.total, v.cost.perDay, v.taskCost, v.cost.known, v.cost.unattributed, state.chain?.windowStart, state.runs.error, state.runs.waitingForRate];
}

function renderCost(m, v) {
  if (!state.loaded) {
    replaceSection('cost', empty('…'));
    return;
  }
  const a = m.aicToday;
  const c = v.cost;
  const why = runsProblem(v);
  const toDate = state.chain?.windowStart === 'genesis';
  const wf = AGENT_WORKFLOWS.map((w) => `${w}: ${c.byWorkflow[w].measured} runs, ${aic(c.byWorkflow[w].aic)}`);
  const days = c.perDay;
  const spendDays = days.aic.filter((x) => x > 0).length;
  replaceSection('cost',
    stat({
      key: 'today', value: formatUsd(a.total), label: `today, cap ${formatUsd(a.budget)}`, level: a.level === 'ok' ? null : a.level,
      tipText: [
        `Today (UTC): ${aic(a.total)} of the ${aic(a.budget)} daily cap (${(a.pct ?? 0).toFixed(1)}%). Amber at ${DEFAULTS.aicAlertPct}%, red at 100%.`,
        'The cap is policies/budgets.yaml factory_per_day.max_aic, enforced by the controller across all workflows.',
        a.source === 'spend_snapshot'
          ? (a.measured == null ? `Measured/reserved split unavailable (the snapshot lists ${a.listed} of ${a.runs ?? '?'} runs).` : `${aic(a.measured)} measured + ${aic(a.reserved)} reserved for runs in flight (${a.runs} runs); snapshot ${relativeTime(parseTime(a.at), now())}.`)
          : 'No spend snapshot today yet.',
      ].join('\n'),
    }),
    stat({
      key: 'total', value: c.measuredRuns ? formatUsd(c.total) : '—', label: toDate ? 'to date' : `in ${DAYS} days`,
      tipText: [
        c.measuredRuns ? `Total ${toDate ? 'to date' : `in the last ${DAYS} days`}: ${aic(c.total)} over ${plural(c.measuredRuns, 'measured run')} (the latest value per run in the spend snapshots).` : 'No measured runs in the spend snapshots yet.',
        toDate ? 'The loaded window reaches the start of the audit log.' : `Over the loaded window (the last ${DAYS} days).`,
        ...(c.known ? [...wf, `Drill tasks: ${aic(c.drillAic)}. Not attributed to a task: ${aic(c.unattributed)} (${plural(c.unattributedRuns, 'run')}).`] : [why]),
        'The median per task is the "Cost per task" number at the top.',
        spendDays ? `AIC per UTC day, last ${days.days.length} days: ${days.days.map((d, i) => (days.aic[i] ? `${d.slice(5)} ${Math.round(days.aic[i]).toLocaleString('en-US')}` : null)).filter(Boolean).join(', ')}.` : null,
      ].filter(Boolean).join('\n'),
    }),
  );
}

function renderQuality(v) {
  if (!state.loaded) {
    replaceSection('quality', empty('…'));
    return;
  }
  const q = v.quality;
  const r = q.repairs;
  const window = `In the loaded window (last ${DAYS} days); drills (drill/*) left out.`;
  replaceSection('quality',
    stat({ key: 'reverts', value: String(q.reverts), label: q.reverts === 1 ? 'revert' : 'reverts', level: q.reverts ? 'warn' : null,
      tipText: `Merges the factory reverted automatically after main regressed (auto_revert).\n${window}` }),
    stat({ key: 'escaped', value: String(q.escaped.count), label: q.escaped.count === 1 ? 'escaped defect' : 'escaped defects', level: q.escaped.count ? 'warn' : null,
      tipText: `Escaped defect: a merge whose post-merge ci on main failed (check_result: push, ci, failure), counted once per commit.${q.escaped.shas.length ? `\nCommits: ${q.escaped.shas.map((s) => s.slice(0, 7)).join(', ')}` : ''}\n${window}` }),
    stat({ key: 'objections', value: String(q.objections), label: q.objections === 1 ? 'reviewer objection' : 'reviewer objections',
      tipText: `Hand-offs because the reviewer agent objected (needs_human, reason review_objected).\n${window}` }),
    stat({ key: 'repairs', labelFirst: true, label: 'Repairs worked:', value: r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`,
      tipText: `${r.succeeded} of ${r.succeeded + r.failed} repairs worked${r.pending ? `, ${r.pending} pending` : ''}. A repair worked when its task's PR merged afterwards with no needs_human in between.\n${window}` }));
}

function renderHuman(v) {
  if (!state.loaded) {
    replaceSection('human', empty('…'));
    return;
  }
  const x = v.human;
  replaceSection('human',
    stat({ key: 'actions', value: String(x.total), label: `actions, ${x.days} days`,
      tipText: `${plural(x.reviews, 'review')}, ${x.enqueues} PR${x.enqueues === 1 ? '' : 's'} queued to merge by hand${x.other ? `, ${x.other} other` : ''}, in the last ${x.days} days.\nhuman_action events, plus queued events by a person (not a [bot]).` }),
    stat({ key: 'resolve', value: shortDuration(x.medianResolveMs), label: 'to unblock',
      tipText: `Median time to unblock a hand-off: from needs_human to the next event that moves the task on (re-dispatch, a person's action, merge, or the task closing).\n${x.resolved} resolved, ${x.unresolved} not yet, in the loaded window; drills left out.` }));
}

function liveSig(m, v) {
  return [m.heartbeat.level, v.live, v.board.counts.running];
}

function renderLive(m, v) {
  if (!state.loaded) {
    replaceSection('live', empty('…'));
    return;
  }
  const L = v.live;
  const hb = m.heartbeat;
  const level = hb.level === 'ok' ? null : hb.level === 'none' ? 'alert' : hb.level;
  const lastTip = [
    L.lastAt == null ? `No controller event in the last ${DAYS} days.` : `Last controller poll: ${L.lastType} event, ${iso(L.lastAt)}.`,
    hb.ageMin == null ? `No heartbeat in the last ${DAYS} days.` : `Last heartbeat ${formatAge(hb.ageMin)} ago (${hb.at}).`,
    cadenceLines().heartbeat,
    `Heartbeat: green up to ${HB_WARN}, ${limitsText(DEFAULTS.heartbeatWarnMin, DEFAULTS.heartbeatAlertMin)}`,
    CADENCE_NOTE,
  ].join('\n');
  const nextTip = L.mode === 'follow-up'
    ? `Work is in flight or dispatch is paused by a gate, so the controller's follow-up chain polls again about ${FOLLOW_UP_MIN} min after its last poll (${iso(L.nextAt)}).`
    : [`Next scheduled (hourly) poll: ${L.nextAt == null ? 'unknown' : iso(L.nextAt)}.`, L.followUpMissed ? `The follow-up poll expected ${FOLLOW_UP_MIN} min after the last one hasn't arrived.` : null,
      'GitHub\'s cron often runs scheduled jobs hours late on Free plans.', cadenceLines().heartbeat].filter(Boolean).join('\n');
  replaceSection('live',
    stat({ key: 'last', labelFirst: true, label: 'Polled', value: L.lastAt == null ? '—' : timeEl(L.lastAt), level, tipText: lastTip }),
    stat({ key: 'next', labelFirst: true, label: 'Next', value: L.nextAt == null ? '—' : h('span', {}, '~', timeEl(L.nextAt)), tipText: `Next controller poll expected ${relativeTime(L.nextAt, now())}.\n${nextTip}` }));
}

function renderRecent(v) {
  if (!state.loaded) {
    replaceSection('recent', empty('…'));
    return;
  }
  if (!v.recent.length) {
    replaceSection('recent', empty('No activity yet'));
    return;
  }
  replaceSection('recent', h('ol', { class: 'recent' }, v.recent.map((r, i) => tip(h('li', { 'data-row-key': `${i}:${r.text}` },
    h('span', { class: 'recent-t' }, r.text), h('span', { class: 'recent-at' }, timeEl(r.at, { bare: true }))),
  [`${r.type}${r.task ? ` · ${r.task}` : ''}${r.issue != null ? ` · issue #${r.issue}` : ''}${r.pr != null ? ` · PR #${r.pr}` : ''}`, r.at != null ? iso(r.at) : null].filter(Boolean).join('\n')))));
}

// ---------------------------------------------------------------------------
// Folded details: latest checks and where the time goes

const CHECKS_SHOWN = 5;

function checkRow(ev, i) {
  const key = typeof ev.id === 'string' ? ev.id : `#${i}`;
  try {
    const p = ev.payload;
    const tone = p.conclusion === 'success' ? 'ok' : p.conclusion === 'failure' ? 'fail' : 'other';
    const prs = Array.isArray(p.prs) ? p.prs.filter(isNum) : [];
    const wf = String(p.workflow ?? 'check');
    const at = p.completed_at ?? ev.timestamp;
    const lines = [
      isNum(p.run_id) ? `View run ${p.run_id}${isNum(p.run_attempt) && p.run_attempt > 1 ? ` (attempt ${p.run_attempt})` : ''} on GitHub` : null,
      `${wf}: ${p.conclusion ?? 'unknown'}${typeof p.event === 'string' ? ` on ${p.event}` : ''}`,
      typeof p.failure_signature === 'string' ? `Failure signature ${p.failure_signature}` : null,
      typeof p.heldout_seed === 'string' ? `Held-out seed ${p.heldout_seed}` : null,
      parseTime(at) != null ? `Completed ${new Date(parseTime(at)).toISOString()}` : null,
    ].filter(Boolean).join('\n');
    const runHref = isNum(p.run_id) ? `${GH}/${REPO}/actions/runs/${p.run_id}${isNum(p.run_attempt) ? `/attempts/${p.run_attempt}` : ''}` : null;
    return h('li', { class: `chk chk--${tone}`, 'data-row-key': key },
      h('span', { class: 'chk-icon', role: 'img', 'aria-label': String(p.conclusion ?? 'unknown') }, icon(tone === 'ok' ? 'ok' : tone === 'fail' ? 'fail' : 'dot')),
      tip(runHref ? link(runHref, wf) : h('b', {}, wf), lines),
      h('span', { class: 'chk-on' }, prs.length ? prs.flatMap((n, j) => [j ? ' ' : '', link(`${GH}/${REPO}/pull/${n}`, `#${n}`)])
        : typeof p.event === 'string' ? h('span', { class: 'muted' }, p.event) : '—'),
      h('span', { class: 'muted' }, timeEl(at)));
  } catch (err) {
    return h('li', { class: 'chk problem', 'data-row-key': key }, `Couldn't show this check: ${err?.message ?? err}`);
  }
}

function renderChecks(m) {
  const passed = m.checks.filter((ev) => ev.payload?.conclusion === 'success').length;
  $('checks-info').textContent = m.checks.length ? `${passed} of ${m.checks.length} passed in ${DAYS} days. Newest first.` : '';
  if (!m.checks.length) {
    replaceSection('checks', empty('No checks yet'));
    return;
  }
  const more = m.checks.length - CHECKS_SHOWN;
  const all = more > 0 && state.checksExpanded;
  const toggle = more > 0 ? tip(h('button', {
    type: 'button', class: 'more more--row', 'aria-expanded': String(all), 'aria-controls': 'checks-list',
    onclick: () => {
      state.checksExpanded = !state.checksExpanded;
      safe('checks', () => renderChecks(deriveMetrics(state.events, { now: now() }))); // restores focus to this button
    },
  }, all ? 'Fewer' : 'View all'), all ? `Show the newest ${CHECKS_SHOWN} only` : `Show all ${m.checks.length} checks in the window`) : null;
  replaceSection('checks',
    h('ul', { class: `checks${all ? ' checks--all' : ''}`, id: 'checks-list' }, m.checks.slice(0, all ? m.checks.length : CHECKS_SHOWN).map(checkRow)),
    toggle);
}

const SHORT_STAGE = Object.freeze({
  ready: 'Ready', picked: 'Picked', running: 'Running', 'pr-open': 'PR open', checks: 'Checks', queued: 'Queue', merged: 'Merged', deployed: 'Deployed',
});
const INSIGHT_STAGE = Object.freeze({ ...SHORT_STAGE, running: 'Agent running', queued: 'Merge queue', merged: 'Waiting to deploy' });

function stackRow(r, maxMs, isMedian = false) {
  const desc = r.segments.map((sg) => `${STAGE_LABELS[sg.stage]} ${formatDuration(sg.ms)}`).join(', ');
  const stack = withWidth(h('div', { class: 'stack', role: 'img', 'aria-label': `${r.label}: ${desc}; total ${formatDuration(r.totalMs)}` },
    r.segments.map((sg) => withWidth(h('i', { class: `seg st-${sg.stage}` }), (sg.ms / r.totalMs) * 100))),
  (r.totalMs / maxMs) * 100);
  const lines = `${isMedian ? `Median per stage over the tasks merged in the last ${MEDIAN_DAYS} days` : r.task}\n${r.segments.map((sg) => `${STAGE_LABELS[sg.stage]}: ${formatDuration(sg.ms)}${isMedian ? ` (${plural(sg.tasks, 'task')})` : ''}`).join('\n')}\n${isMedian ? 'Sum of the medians' : 'Total'} ${formatDuration(r.totalMs)}`;
  return h('div', { class: `srow${isMedian ? ' srow--avg' : ''}`, 'data-row-key': r.key },
    h('span', { class: 'srow-label' }, isMedian ? tip(h('b', {}, 'Median'), lines) : subjectButton(r.key, r.label, `Show the timeline\n${lines}`)),
    h('div', { class: 'track' }, stack),
    h('span', { class: 'muted num' }, shortDuration(r.totalMs)));
}

function renderStages(m) {
  const sb = stageSummary(stageTimes(state.events), { now: now(), days: MEDIAN_DAYS });
  const shown = sb.rows.slice(-10);
  $('stages-info').textContent = sb.rows.length
    ? `Tasks merged in the last ${MEDIAN_DAYS} days${sb.rows.length > shown.length ? `, latest ${shown.length} of ${sb.rows.length}` : ''}. The top bar is the median per stage.`
    : '';
  if (!sb.rows.length) {
    replaceSection('stages', empty(`No task merged in the last ${MEDIAN_DAYS} days`));
    return;
  }
  const used = STAGES.filter((st) => sb.rows.some((r) => r.segments.some((sg) => sg.stage === st)));
  const ins = sb.insight;
  replaceSection('stages',
    stackRow(sb.median, sb.maxMs, true),
    shown.map((r) => stackRow(r, sb.maxMs)),
    h('p', { class: 'legend' }, used.map((st) => h('span', {}, h('i', { class: `st-${st}`, 'aria-hidden': 'true' }), SHORT_STAGE[st]))),
    ins ? tip(h('p', { class: 'insight' }, icon('info'), h('span', {}, `${INSIGHT_STAGE[ins.stage]} is ${Math.round(ins.pct)}% of the median`)),
      `${ins.label} takes the largest median time: ${formatDuration(ins.ms)}, ${Math.round(ins.pct)}% of the summed stage medians over ${plural(ins.tasks, 'task')}.`) : null);
}

// ---------------------------------------------------------------------------
// Folded details: timeline and audit log

function eventDetail(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'heartbeat':
      return `${p.trigger ?? ''} · open PRs ${p.open_pr_count ?? '?'} · decisions ${p.decision_count ?? '?'} · enabled ${p.factory_enabled}`;
    case 'check_result':
      return `${p.workflow ?? '?'}: ${p.conclusion ?? '?'}${p.failure_signature ? ` (${p.failure_signature})` : ''}`;
    case 'human_action':
      return `${p.action ?? ''} ${p.state ?? ''} by ${p.reviewer ?? '?'}`;
    case 'pr_opened':
      return `by ${p.author ?? '?'}`;
    case 'queued':
    case 'dequeued':
      return `by ${p.actor ?? '?'}`;
    case 'merged':
      return isSha(p.merge_commit_sha) ? `as ${p.merge_commit_sha.slice(0, 7)}` : '';
    case 'run_finished':
      return `${p.model ?? ''} · ${fmtInt(p.aic)} AIC · ${formatDuration(p.duration_ms)}`;
    case 'spend_snapshot':
      return `${fmtInt(isNum(p.aic_today) ? Math.round(p.aic_today) : null)} AIC on ${p.day ?? '?'} · ${fmtInt(p.runs_total)} runs`;
    case 'dispatch_state':
      return `${p.state ?? '?'}${p.reason && p.reason !== 'none' ? ` (${p.reason})` : ''} · ready ${p.ready ?? '?'}, in flight ${p.in_flight ?? '?'}`;
    default:
      return [p.effect, p.reason].filter((x) => typeof x === 'string').join(': ');
  }
}

function renderTimeline(m) {
  const select = $('subject');
  const subjects = m.subjects;
  if (state.subject && !subjects.some((s) => s.key === state.subject)) state.subject = '';
  const tasks = subjects.filter((s) => s.key.startsWith('task:'));
  const prs = subjects.filter((s) => s.key.startsWith('pr:'));
  const sig = subjects.map((s) => s.key).join('\n');
  if (select.dataset.sig !== sig) {
    const opts = [h('option', { value: '' }, subjects.length ? 'Choose a task or PR…' : 'No tasks or PRs yet')];
    if (tasks.length) opts.push(h('optgroup', { label: 'Tasks' }, tasks.map((s) => h('option', { value: s.key }, s.label))));
    if (prs.length) opts.push(h('optgroup', { label: 'Pull requests' }, prs.map((s) => h('option', { value: s.key }, s.label))));
    select.replaceChildren(...opts);
    select.dataset.sig = sig;
  }
  select.value = state.subject;
  select.disabled = !subjects.length;

  if (!state.subject) {
    replaceSection('timeline', empty(subjects.length ? 'Pick a task or PR to see its events in order.' : 'No tasks or PRs in the window yet.'));
    return;
  }
  const items = timelineFor(state.events, state.subject);
  const list = h('ol', { class: 'timeline' }, items.map(({ event: ev, gapMs }) => safeTimelineItem(() => h('li', {},
    h('span', { class: 'tl-time' }, timeEl(ev.timestamp)),
    h('span', { class: 'tl-gap' }, gapMs == null ? 'start' : `+${formatDuration(gapMs)}`),
    h('span', { class: 'tl-type' }, h('code', {}, ev.type)),
    h('span', { class: 'tl-detail' }, [subjectLabel(ev), eventDetail(ev)].filter(Boolean).join(' · ')),
  ))));
  replaceSection('timeline', list);
}

function safeTimelineItem(build) {
  try {
    return build();
  } catch (err) {
    return h('li', { class: 'problem' }, `Couldn't show this event: ${err?.message ?? err}`);
  }
}

function integrityLabel(res) {
  if (!res) return ['—', ''];
  if (!res.ok) return [res.problems[0] ?? 'problem', 'pill--alert'];
  if (res.link === 'window-start') return ['ok · window start', 'pill--info'];
  if (res.link === 'genesis') return ['ok · genesis', 'pill--info'];
  return ['ok', 'pill--ok'];
}

function renderEvents() {
  const records = state.records;
  const types = [...new Set(state.events.map((e) => e.type))].sort();
  if (state.typeFilter && !types.includes(state.typeFilter)) state.typeFilter = '';
  const select = $('type-filter');
  const sig = types.join('\n');
  if (select.dataset.sig !== sig) {
    select.replaceChildren(h('option', { value: '' }, 'All types'), ...types.map((t) => h('option', { value: t }, t)));
    select.dataset.sig = sig;
  }
  select.value = state.typeFilter;
  select.disabled = !types.length;

  $('events-sum').textContent = records.length ? `${records.length.toLocaleString('en-US')} events in the last ${DAYS} days, newest first.` : '';
  if (!records.length) {
    replaceSection('events', empty(state.noLog ? 'No audit log yet.' : state.loaded ? 'No events in the window.' : 'Loading…'));
    return;
  }
  const results = state.chain?.results ?? [];
  const shown = [];
  for (let i = records.length - 1; i >= 0 && shown.length < 200; i--) {
    const ev = records[i].event;
    if (state.typeFilter && ev?.type !== state.typeFilter) continue;
    shown.push(i);
  }
  if (!shown.length) {
    replaceSection('events', empty('No events of this type in the window.'));
    return;
  }
  const trs = [];
  for (const i of shown) {
    const rec = records[i];
    const ev = rec.event;
    const res = results[i];
    const key = `${rec.source}:${rec.line}`; // unique and stable, even for malformed events
    const open = state.expanded.has(key);
    const detailId = `ev-detail-${i}`;
    const [label, cls] = integrityLabel(res);
    const toggle = h('button', {
      type: 'button',
      class: 'expander',
      'aria-expanded': String(open),
      'aria-controls': detailId,
      'aria-label': `${open ? 'Hide' : 'Show'} JSON of event ${i + 1}`,
      onclick: () => {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        safe('events', renderEvents); // restores focus to this button
      },
    }, `${open ? '▾' : '▸'} ${i + 1}`);
    trs.push(safeRow(key, 6, () => row(key,
      toggle,
      ev ? timeEl(ev.timestamp) : '—',
      ev ? h('code', {}, String(ev.type)) : 'unparseable',
      ev ? subjectLabel(ev) || '—' : '—',
      ev ? eventDetail(ev) || '—' : rec.error,
      h('span', { class: `pill ${cls}` }, label),
    )));
    if (open) {
      let json;
      try {
        json = ev ? canonicalize(ev) : rec.raw;
      } catch {
        json = rec.raw;
      }
      const problems = res && !res.ok ? h('p', { class: 'problem' }, `Integrity: ${res.problems.join('; ')}`) : null;
      const expected = res && res.expectedSha && ev && res.expectedSha !== ev.sha ? h('p', { class: 'problem' }, `Recomputed sha: ${res.expectedSha}`) : null;
      trs.push(h('tr', { class: 'detail', id: detailId, 'data-row-key': `${key}:detail` }, h('td', { colspan: '6' },
        h('p', { class: 'hint' }, `${rec.source} line ${rec.line} · canonical JSON`),
        problems, expected,
        h('pre', { class: 'json', tabindex: '0' }, json))));
    }
  }
  replaceSection('events', 
    table('Recent events, newest first', ['#', 'Time', 'Type', 'Task / PR', 'Detail', 'Integrity'], trs),
    shown.length === 200 ? h('p', { class: 'hint' }, 'Showing the newest 200 events.') : null,
  );
}

// ---------------------------------------------------------------------------
// Wiring

// Theme: follows the system unless the owner picks one; the choice stays in localStorage.
function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  $('theme').setAttribute('aria-label', `Switch to the ${next} theme`);
  $('theme').dataset.tip = `Switch to the ${next} theme`;
  if (tipState.target === $('theme')) showTip($('theme'));
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* no storage: follow the system */
  }
  applyTheme(stored);
  $('theme').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* the choice just won't persist */
    }
    applyTheme(next);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));
}

function init() {
  $('refresh').addEventListener('click', () => {
    if (FIXTURE) state.loaded = false;
    tick();
  });
  $('subject').addEventListener('change', (e) => {
    state.subject = e.target.value;
    safe('timeline', () => renderTimeline(deriveMetrics(state.events, { now: now() })));
  });
  $('type-filter').addEventListener('change', (e) => {
    state.typeFilter = e.target.value;
    safe('events', renderEvents);
  });
  const showTokenState = () => {
    $('token').value = '';
    $('token').placeholder = getToken() ? 'saved in this browser' : 'not set';
  };
  showTokenState();
  $('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('token').value.trim();
    if (!value) return;
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      state.error = "Couldn't save the token: localStorage is unavailable.";
    }
    showTokenState();
    state.etag = null; // ETags are per credential
    tick();
  });
  $('forget').addEventListener('click', () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing stored */
    }
    showTokenState();
    state.etag = null;
    tick();
  });
  initTheme();
  initTips();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.nextCheckAt && Date.now() >= state.nextCheckAt - 1000) tick();
  });
  // Ages and "next check" move with the clock even when no data changes.
  setInterval(() => {
    if (state.loaded) render();
  }, 15000);
  render({ full: true });
  tick();
}

init();
