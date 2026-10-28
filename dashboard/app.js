// Control-room UI: one screen at 1440x900. Fetches the audit branch from GitHub, verifies it
// with lib.js and renders the status line, the key numbers, the task board, the small panels
// and the folded details. All DOM writes use textContent or createElement(NS), never innerHTML,
// and widths go through the CSSOM, so the strict CSP holds. Every request is a GET.
import {
  CADENCE_NOTE, DEFAULTS, FOLLOW_UP_MIN, HUMAN_DAYS, MEDIAN_DAYS, STAGES, STAGE_LABELS, STALE_DATA_MIN, TASK_STATES, TASK_STATE_LABELS,
  anchorTimes, cadenceText, canonicalize, combineNeedsYou, compactAge, costJoin, dayPaths, deriveMetrics, dispatchBanner, dropClosed, eventTime,
  fallbackCatalog, formatDuration, formatLimit, formatUsd, healthSummary, heartbeatTimes, humanTouch, issueToMerged, latestDispatchState, limitsText,
  liveness, medianTaskCost, observedCadence, parseAnchors, parseContract, parseJsonl, parseTaskmap, parseTime, qualityStats, recentActivity,
  relativeTime, reviewItems, shortDuration, shortTaskName, stageSummary, stageTimes, statusSummary,
  allDayPaths, eventsInWindow, plainProblem, plainReason, segText, costItem, earliestSpendDay, handsOffItem, humanSteps, latestOutcomes, outcomesStale, outcomesSummary, OUTCOME_STATUSES, qualityItem, shippedItem, shortDate, speedItem, statusParts, validateBuildCost, validateDrills,
  isDrill, repairSentence, subjectLabel, summarizePr, summarizeTaskIssue, taskBoard, taskCatalog, taskIssueMap, timelineFor, utcDay, VERIFIER_LIMITS, verifierReason, verifierStatus, verifyChain,
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
// for the task map, the contracts, the task issues, the build cost and the drill record, so sample
// mode makes no GitHub call.
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
// build-cost.json and drills.json: same-origin static files (no API cost), read on load and hourly.
const STATICS_MAX_AGE_MS = 60 * 60000;
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
  partialHistory: false, // true when only the window's day files could be loaded
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
  // Task issues: map (task id -> issue) from the last good read, or null; doneMark is the count of
  // task_done and merged events when it was read, so a new one triggers an early refresh.
  taskIssues: { map: null, etag: null, items: null, error: null, fetchedAt: null, attemptedAt: null, doneMark: null, truncated: false },
  fixtureMeta: null,
  // build-cost.json and drills.json, deployed with the page: validateBuildCost/validateDrills results.
  statics: { build: null, drills: null, attemptedAt: null },
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
  $('details').open = true;
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

// The whole log: every day file in the tree listing (raw downloads don't count against the API
// limit), so the scoreboard's numbers are lifetime results and the chain is verified from its
// first event. If the listing can't be read, only the window's days are fetched and the page says
// the scoreboard covers that window.
async function fetchDayFiles(sha) {
  const listing = await listAuditFiles(sha);
  const paths = listing ? allDayPaths(listing) : dayPaths(now(), DAYS);
  state.partialHistory = !listing;
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

// The sample's stand-in for the task map, contracts, task issues, build cost and drills (read once).
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

// Reads one same-origin JSON file and validates it; never throws.
async function readStatic(path, validate) {
  try {
    const res = await fetch(path, { cache: 'no-cache', credentials: 'omit' });
    if (!res.ok) return { ok: false, error: `${path}: HTTP ${res.status}` };
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: `${path}: not valid JSON` };
    }
    const r = validate(data);
    return r.ok ? r : { ok: false, error: `${path}: ${r.error}` };
  } catch (err) {
    return { ok: false, error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function maybeRefreshStatics() {
  const st = state.statics;
  if (st.attemptedAt != null && Date.now() - st.attemptedAt < STATICS_MAX_AGE_MS) return;
  st.attemptedAt = Date.now();
  if (FIXTURE) {
    // The sample's stand-ins (a missing one exercises the "unavailable" wording).
    try {
      const meta = await loadFixtureMeta();
      const one = (key, validate) => (key in meta ? (validate(meta[key]).ok ? validate(meta[key]) : { ok: false, error: `${key}: ${validate(meta[key]).error}` }) : { ok: false, error: `${key} missing from the sample` });
      st.build = one('buildCost', validateBuildCost);
      st.drills = one('drills', validateDrills);
    } catch (err) {
      st.build = st.drills = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    [st.build, st.drills] = await Promise.all([readStatic('build-cost.json', validateBuildCost), readStatic('drills.json', validateDrills)]);
  }
  state.dataVersion++;
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
      await maybeRefreshStatics();
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
        await maybeRefreshStatics();
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
  // gh-aw Outcomes: the newest snapshot judges the agents' PRs and maps runs to tasks; the full
  // cost (agent plus threat detection) comes from the spend snapshots, joined by run id.
  const outcomes = latestOutcomes(state.events);
  const cost = costJoin(state.events, outcomes?.snapshot.runs ?? null, { now: t, days: MEDIAN_DAYS });
  const done = board.tasks.filter((x) => x.state === 'done');
  const doneIds = done.map((x) => x.id);
  const doneTimes = done.map((x) => x.since).filter(isNum);
  return {
    board,
    dispatch,
    banner: dispatchBanner(state.events, { now: t }),
    cost,
    taskCost: medianTaskCost(cost, doneIds),
    // Speed: every done real task whose start and merge are in the loaded audit log.
    toMerged: issueToMerged(state.events, { now: t, days: Infinity, tasks: new Set(doneIds) }),
    doneSpan: doneTimes.length ? [Math.min(...doneTimes), Math.max(...doneTimes)] : null,
    steps: humanSteps(state.events),
    outcomes,
    outcomesSum: outcomes ? outcomesSummary(outcomes.snapshot) : null,
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
    renderHeader(m, v, needs);
  } catch (err) {
    setStatus(`Problem showing the header: ${err?.message ?? err}`);
  }
  const loaded = state.loaded;
  const known = FIXTURE || prsKnown();
  renderIf('score', [loaded, v && scoreSig(v)], withMetrics((mm, vv) => renderScore(vv)), full);
  renderIf('board', [loaded, state.meta.status, state.meta.error, state.taskIssues.error, state.taskIssues.map != null, v?.board.tasks.map((x) => [x.id, x.state, x.since, x.reason, x.issue, x.tier, x.prs])], withMetrics((mm, vv) => renderBoard(vv)), full);
  renderIf('human-steps', [loaded, v?.steps], withMetrics((mm, vv) => renderSteps(vv)), full);
  renderIf('outcomes', [loaded, v?.outcomesSum, v?.outcomes?.lastAt, v?.cost.agentCompare], withMetrics((mm, vv) => renderOutcomes(vv)), full);
  renderIf('about', [loaded, v && scoreSig(v), state.partialHistory, state.records.length], withMetrics((mm, vv) => renderAbout(vv)), full);
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
  // open-PR lists, the task catalog and the task issues have been read or have failed.
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

/** The anchors in the verifier file, or [] if it isn't loaded or isn't valid. */
function loadedAnchors() {
  if (state.verifier.status !== 'ok') return [];
  const parsed = parseAnchors(state.verifier.text);
  return parsed.problem ? [] : parsed.anchors;
}

/** Tooltip lines with the cadence the scheduled jobs really ran at, from the loaded data. */
function cadenceLines(anchors = loadedAnchors()) {
  return {
    heartbeat: cadenceText('Check-ins', observedCadence(heartbeatTimes(eventsInWindow(state.events, { now: now(), days: DAYS }))), DAYS),
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

function renderHeader(m, v, needs) {
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
  // Tooltips stay at two short sentences; the rule, the chain and the cadence are in Details.
  state.healthView = { health, detail, chainLine, verifier };
  const first = health.problems[0];
  const hbAgo = hb?.at ? relativeTime(parseTime(hb.at), now()) : null;
  setChip('health', {
    tone: TONE[health.level], iconName: LEVEL_ICON[health.level], text: health.level === 'loading' ? `… ${health.label}` : health.label,
    tipText: health.level === 'loading' ? 'Loading the audit log.'
      : health.level === 'ok' ? `Healthy: the audit log is verified, and the factory checked in ${hbAgo ?? 'recently'}.`
        : first?.code === 'paused' ? 'Paused: new work waits for a safety gate. The rule is under Details, Liveness.'
          : `${health.label}: ${segText(plainProblem(first, { heartbeatAt: parseTime(hb?.at) }), now())}. The rule is under Details, Liveness.`,
  });
  setStatus(`Factory ${health.label}${health.level !== 'ok' && health.reasons.length ? `: ${health.reasons[0]}` : ''}`);
  renderVerifierLine(verifier);

  renderParts(m, v, needs, health);
  const dryRun = m?.dryRun ?? null;
  const version = m?.factoryVersion ?? null;
  // Live is the normal state, so only a dry run gets a chip (the version is in the "updated" tooltip).
  setChip('dry-badge', {
    hidden: dryRun !== true, tone: 'warn', iconName: 'info', text: 'Dry run',
    tipText: "Dry run: the factory logs its decisions but doesn't act on them.",
  });
  setChip('mode-badge', { hidden: !FIXTURE, tone: 'info', iconName: 'info', text: 'Sample', tipText: `Sample data, read offline. Remove ?fixture=${FIXTURE_PARAM} from the address for live data.` });

  const meta = [];
  if (FIXTURE) meta.push(`sample data from ${FIXTURE_URL}`);
  else {
    if (state.lastCheck) meta.push(`checked ${relativeTime(state.lastCheck, Date.now())}`);
    if (state.nextCheckAt) meta.push(`next ${relativeTime(state.nextCheckAt, Date.now())}`);
    if (state.rate) meta.push(`API ${state.rate.remaining}/${state.rate.limit} left` + (state.rate.reset ? `, resets ${relativeTime(state.rate.reset, Date.now())}` : ''));
    meta.push(getToken() ? 'your token' : 'no token');
  }
  const age = state.lastOkAt == null ? null : compactAge(Date.now() - state.lastOkAt);
  // The clock icon and the tooltip say "updated"; the visible text is just the age.
  $('updated-text').textContent = age ? `${age} ago` : state.error ? 'not updated' : 'loading…';
  const r = state.rate;
  setTip('updated', `${age ? `Data updated ${age} ago` : 'Data not loaded yet'}, from the audit log on GitHub.${!FIXTURE && r ? ` ${r.remaining} of ${r.limit} API requests left this hour.` : ''}`);
  if (version) meta.push(`factory version ${version}`);
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
// Segments (lib.js builders) to DOM: every number and link is its own inline-block run, so a long
// sentence still reads as short runs (the glance test's 8-word rule) without changing its words.

const STATE_ICON = { done: 'ok', running: 'play', needs: 'warn', waiting: 'wait' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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

function segNodes(segs) {
  const out = [];
  (segs || []).forEach((s, i) => {
    const text = s.t === 'sep' ? '·' : s.t === 'time' ? null : s.text;
    const prev = segs[i - 1];
    const glued = (typeof text === 'string' && /^[,.:;)]/.test(text)) || (prev?.t === 'text' && prev.text.endsWith('('));
    if (i && !glued) out.push(' ');
    if (s.t === 'big') out.push(h('b', { class: 'big' }, s.text));
    else if (s.t === 'num') out.push(h('b', { class: 'run' }, s.text));
    else if (s.t === 'time') out.push(h('span', { class: 'run' }, timeEl(s.at)));
    else if (s.t === 'sep') out.push(h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'));
    else if (s.t === 'link') out.push(s.href ? h('a', { class: 'run', href: s.href, rel: s.href.startsWith('#') ? null : 'noopener noreferrer' }, s.text) : h('span', { class: 'run' }, s.text));
    else out.push(s.text);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Status line: health chip · state · what needs you

const PART_ICON = { warn: 'warn', alert: 'fail' };

// Rebuilt only when it changes (relative times update in place), and through replaceSection(), so
// a focused link in the status line keeps focus across the 15-second refresh.
function setPart(id, part, tipText) {
  const el = $(id);
  const sig = JSON.stringify([part, tipText]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (!part) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `part part--${part.level} has-tip`;
  replaceSection(id, ...(PART_ICON[part.level] ? [h('span', { class: 'part-i', role: 'img', 'aria-label': part.level === 'alert' ? 'Problem' : 'Warning' }, icon(PART_ICON[part.level]))] : []),
    h('span', {}, segNodes(part.segs)), h('span', { id: `${id}-tip`, class: 'tip-src', hidden: true }, tipText));
  el.setAttribute('aria-describedby', `${id}-tip`);
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
}

function renderParts(m, v, needs, health) {
  if (!state.loaded || !m || !v) {
    setPart('state-part', null);
    setPart('needs-part', null);
    return;
  }
  const p = statusParts({
    health, heartbeatAt: parseTime(m.heartbeat.at), killSwitch: m.killSwitch.enabled, board: v.board, banner: v.banner,
    needsItems: needs?.items ?? [], reviews: needs?.rs === 'sample' ? 'ok' : needs?.rs ?? 'pending',
  });
  const c = v.board.counts;
  const running = c.running > 0;
  const stateTip = health.problems.some((x) => x.code !== 'paused') ? 'The most serious problem right now. The health rule is under Details, Liveness.'
    : m.killSwitch.enabled === false ? 'The factory switch is off, so no new work starts.'
      : v.banner?.state === 'paused' && v.banner.reason !== 'kill_switch' ? `Paused ${relativeTime(parseTime(v.banner.since), now())} by a safety gate. Work resumes by itself when it clears.`
        : running ? 'Tasks with work under way. Select one to view its issue.'
          : `Nothing is running; ${c.done} of ${v.board.total} tasks are done.`;
  const items = needs?.items ?? [];
  const rs = needs?.rs;
  const needsTip = items.length ? 'Hand-offs and PR reviews waiting for you, oldest first. Select a number to view it on GitHub.'
    : rs === 'unavailable' ? "The open-PR list couldn't be read, so PR reviews may be missing."
      : rs === 'pending' ? 'Reading the open-PR list for PR reviews.'
        : rs === 'sample' ? "No hand-offs are waiting. Sample data doesn't read live PR reviews."
          : 'No hand-offs or PR reviews are waiting for you. Closed issues and PRs are left out.';
  setPart('state-part', p.state, stateTip);
  setPart('needs-part', p.needs, needsTip);
}

// ---------------------------------------------------------------------------
// Scoreboard: five sentences, each with one big number; definitions in the tooltips

function scoreSig(v) {
  return [v.board.counts, v.board.byTier, v.board.total, v.toMerged.medianMs, v.toMerged.count, v.doneSpan, v.cost.total, v.cost.drillAic, v.cost.known, v.cost.spend,
    v.taskCost, v.quality, v.steps.total, state.statics.build, state.statics.drills, state.taskIssues.error, state.taskIssues.map != null,
    v.outcomesSum, v.outcomes && outcomesStale(v.outcomes, now())];
}

function scoreItem(item, tipText) {
  return tip(h('li', { class: `score-item score--${item.key}`, 'data-row-key': item.key },
    h('p', { class: 'score-main' }, segNodes(item.main)),
    item.subs.map((sub) => h('p', { class: 'score-sub' }, segNodes(sub)))), tipText);
}

function renderScore(v) {
  if (!state.loaded) {
    replaceSection('score', h('li', { class: 'score-item' }, h('p', { class: 'score-main' }, h('b', { class: 'big' }, '…'))));
    return;
  }
  const st = state.statics;
  const b = v.board;
  const doneReal = b.counts.done;
  const itm = v.toMerged;
  const c = v.cost;
  const since = earliestSpendDay(state.events);
  const build = st.build?.ok ? st.build.value : null;
  const steps = v.steps;
  const drills = st.drills;
  const partial = state.partialHistory ? `Only the last ${DAYS} days of the audit log could be loaded.` : null;
  const os = v.outcomesSum;
  const stale = v.outcomes && outcomesStale(v.outcomes, now()) ? `gh-aw Outcomes last evaluated ${relativeTime(v.outcomes.lastAt, now())}, so they may be out of date.` : null;
  replaceSection('score',
    scoreItem(shippedItem(b, os), `${state.taskIssues.map && !state.taskIssues.error ? 'Tasks ported from JavaScript to Rust whose issue is closed as completed.' : "Tasks merged per the audit log; the task-issue list couldn't be read."} ${stale ?? (os ? 'gh-aw Outcomes judges each agent PR; real work only, drills separate.' : 'gh-aw Outcomes, which judges each agent PR, has no snapshot yet.')}`),
    scoreItem(speedItem({ medianMs: itm.medianMs, count: itm.count, firstAt: v.doneSpan?.[0], lastAt: v.doneSpan?.[1], done: doneReal }),
      itm.count ? `Median time from a task's start to its merge, over ${itm.count} of ${doneReal} done tasks. ${partial ?? 'Dates are the first and last finishes.'}`
        : `Start and merge times for these tasks aren't in the audit log. ${partial ?? 'Details explains how speed is measured.'}`),
    scoreItem(costItem({ build: st.build, cost: c, acceptedPrs: os?.real.prs.accepted ?? null }), [
      build ? `Build: one-time sessions to make the factory, as of ${shortDate(build.asOf)}.` : `Build cost unavailable: ${shortError(st.build?.error ?? 'not read yet')}.`,
      c.spend === 'missing' ? 'Run: the agent runs have no cost measurement yet.' : partial ?? (c.known ? `Run: the factory's full agent runs${since ? ` since ${shortDate(since)}` : ''}, at $0.01 per AI credit.` : 'Run: the real and drill split needs gh-aw Outcomes, not available yet.'),
    ].join(' ')),
    scoreItem(handsOffItem(os, steps), os
      ? `gh-aw counts a PR as zero-touch if no person edited it. ${stale ?? partial ?? 'Manual steps outside the PR are counted separately below.'}`
      : 'gh-aw Outcomes, which marks PRs no person edited, has no snapshot yet. Manual steps outside the PR are counted below.'),
    scoreItem(qualityItem(v.quality, drills), `Reverts and changes the reviewer blocked before merge count real work only. ${drills?.ok ? `Drill results are from the build journal, as of ${shortDate(drills.value.asOf)}.` : `Drill record unavailable: ${shortError(drills?.error ?? 'not read yet')}.`}`));
}

/** The first problem of an error message, at most 10 words, for a short tooltip. */
function shortError(text) {
  const words = String(text).split('; ')[0].replace(/\.$/, '').split(/\s+/);
  return words.length > 10 ? `${words.slice(0, 10).join(' ')}…` : words.join(' ');
}

// The definitions behind the scoreboard, as visible text inside Details (tooltips stay short).
function renderAbout(v) {
  if (!state.loaded) {
    replaceSection('about', empty('…'));
    return;
  }
  const st = state.statics;
  const b = v.board;
  const c = v.cost;
  const itm = v.toMerged;
  const build = st.build?.ok ? st.build.value : null;
  const since = earliestSpendDay(state.events);
  const names = { implement: 'coder', repair: 'repair', review: 'reviewer' };
  const steps = v.steps;
  const drills = st.drills;
  const entry = (term, ...lines) => [h('dt', {}, term), h('dd', {}, lines.filter(Boolean).join(' '))];
  replaceSection('about', h('dl', { class: 'about' },
    state.partialHistory ? entry('Scope', `The audit tree couldn't be listed, so only the last ${DAYS} days were loaded: every number here covers that window, not the whole log.`)
      : entry('Scope', `Every number on the scoreboard covers the whole audit log (${state.records.length.toLocaleString('en-US')} events, all verified), not a window. Details lists the last ${DAYS} days.`),
    entry('Shipped', 'A task is done when its issue is closed as completed; while its issue is open, when the controller closes it after the merge; without the issue list, when the audit log shows the merge.',
      `Routine tasks (tier auto) merge by themselves once their checks pass; core tasks (tier auto-strict) also need the reviewer agent and the strict gates.`,
      `Now: ${Object.entries(b.byTier).map(([k, x]) => `${k} ${x.done} of ${x.total}`).join(', ')}.`, 'Safety drills (drill/*) are not tasks.', 'The tasks port chrono\'s JavaScript parsers and refiners to Rust.', taskIssuesLine(),
      v.outcomesSum ? `gh-aw Outcomes: how gh-aw judged each real coder PR (${OUTCOME_STATUSES.slice(0, 3).join(', ')}); drills are counted apart, in Outcomes (gh-aw).` : 'gh-aw Outcomes: no snapshot in the audit log yet.'),
    entry('Speed', `The median time from a task's start (its first auto_ready, else its first agent run) to its merge, over ${itm.count} of ${b.counts.done} done tasks whose start and merge are in the log.`,
      v.doneSpan ? `First finish ${iso(v.doneSpan[0])}, last ${iso(v.doneSpan[1])}.` : null, 'Minutes up to 90, then hours.'),
    entry('Total cost', build ? `Build: ${Math.round(build.aiUnits).toLocaleString('en-US')} AI credits (${formatUsd(build.usd * 100)}), research, design, coordination and build sessions, from ${build.source}, as of ${build.asOf}.` : `Build cost unavailable: ${st.build?.error ?? 'not read yet'}.`,
      `Run: the latest measured AI credits of each of the factory's agent runs${since ? ` since ${since}` : ''}, from the controller's spend snapshots; 1 AI credit = $0.01.`,
      c.known && c.measuredRuns ? `By agent: ${Object.entries(names).map(([k, n]) => `${n} ${formatUsd(c.byWorkflow[k].aic)} over ${plural(c.byWorkflow[k].measured, 'run')}`).join(', ')}.` : null,
      c.known && c.measuredRuns ? `Safety drills ${formatUsd(c.drillAic)}; runs not tied to a task (${formatUsd(c.unattributed)}, ${plural(c.unattributedRuns, 'run')}, mostly reviewer runs) count as real tasks. Runs are matched to tasks and drills by the gh-aw Outcomes snapshot.` : 'Without a gh-aw Outcomes snapshot the run cost has no real and drill split.',
      v.taskCost.medianAic != null ? `Median full cost per done task: ${formatUsd(v.taskCost.medianAic)} over ${plural(v.taskCost.count, 'task')} (coder and repair runs; reviewer runs aren't tied to tasks yet).` : null,
      "gh-aw's own credit figure excludes the threat-detection job; this page uses the full cost."),
    entry('Hands-off', 'gh-aw Outcomes marks an accepted PR zero-touch when no person edited it. Manual steps outside the PR are ours, from the audit log:'),
    entry('Human effort', steps.goLive ? `Go-live: ${iso(steps.goLive)}, the first real agent run of a real task.` : 'Not live yet.',
      'Counted: a person putting an agent PR in the merge queue, and label changes, pushes or hand-started runs on agent PRs or factory tasks when the log records them.',
      "Not counted: plain reviews and comments, and anything on other PRs (the coordinator's own, under the shared account).",
      steps.total ? `By kind: ${Object.entries(steps.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}.` : null),
    entry('Repairs', repairSentence(v.quality.repairs), repairSentence(v.quality.drillRepairs, 'Safety drills: '),
      'A repair fixed the PR when the PR merged next; it was handed to a person when a hand-off came first.'),
    entry('Quality', 'Reverts: merges the factory undid automatically after main broke. Changes blocked: hand-offs because the reviewer agent objected before the merge. Both leave out safety drills.',
      drills?.ok ? `Safety drills: ${drills.value.runs.map((r) => `${r.id} ${r.result}${r.note ? ` (${r.note})` : ''}`).join(', ')}; ${plural(drills.value.defects, 'defect')} found and fixed. From ${drills.value.source}, as of ${drills.value.asOf}.` : `Drill record unavailable: ${drills?.error ?? 'not read yet'}.`),
    entry('Data', 'Everything comes from GitHub, read-only: the audit log, the task map and contracts, the task issues and the open PRs. gh-aw Outcomes results arrive in the audit log as outcomes_snapshot events. The build cost and drill record are files published with this page. Every event is re-hashed and its chain checked in your browser.')));
}

const WORKFLOW_WORD = Object.freeze({ implement: 'coder', repair: 'repair', review: 'reviewer' });

// Details: the gh-aw Outcomes snapshot, as a per-status table (real work vs safety drills).
function renderOutcomes(v) {
  const L = v.outcomes;
  if (!state.loaded) {
    replaceSection('outcomes', empty('…'));
    return;
  }
  if (!L) {
    replaceSection('outcomes', empty('gh-aw Outcomes not available yet: the audit log has no Outcomes snapshot.'));
    return;
  }
  const s = v.outcomesSum;
  const statuses = [...new Set([...OUTCOME_STATUSES, ...Object.keys(s.real.items), ...Object.keys(s.drills.items)])];
  const rows = statuses.map((st) => row(st, h('span', {}, st), String(s.real.prStatus[st] ?? 0), String(s.drills.prStatus[st] ?? 0), String(s.real.items[st] ?? 0), String(s.drills.items[st] ?? 0)));
  const c = v.cost;
  const ac = c.agentCompare;
  const ratio = ac.agent > 0 ? ac.full / ac.agent : null;
  const runUrl = (id) => `${GH}/${REPO}/actions/runs/${id}`;
  const runs = L.snapshot.runs;
  // `gh aw outcomes` takes an agent run id: the newest real coder run that opened a PR, else any.
  const isPr = (r) => r.items.some((x) => x.type === 'create_pull_request');
  const real = runs.filter((r) => !(r.drill === true || isDrill(r.task)));
  const example = [...real].reverse().find((r) => r.workflow === 'implement' && isPr(r)) ?? real.at(-1) ?? runs.at(-1);
  replaceSection('outcomes',
    h('p', { class: 'hint' }, `gh-aw Outcomes judges what each agent run produced (PRs, comments, checks): accepted, rejected, pending and so on. Last evaluated `, timeEl(L.snapshot.evaluatedAt),
      L.checkedAt != null ? ['; last checked unchanged ', timeEl(L.checkedAt)] : null, `. gh-aw ${L.snapshot.ghAwVersion ?? '?'}, ${plural(s.real.runs + s.drills.runs, 'run')}.`),
    table('gh-aw Outcomes by status', ['Status', 'Real PRs', 'Drill PRs', 'All real outputs', 'All drill outputs'], rows, { numeric: [1, 2, 3, 4] }),
    h('p', { class: 'hint' }, `Hands-off: ${s.real.zeroTouch} of ${s.real.prs.accepted} accepted real PRs are zero-touch (no person edited them).`),
    h('p', { class: 'hint' }, "gh-aw's own credit figure excludes the threat-detection job; this page uses the full cost.",
      ratio ? ` For real runs the full cost is about ${ratio.toFixed(2)}× gh-aw's (${Math.round(ac.full).toLocaleString('en-US')} vs ${Math.round(ac.agent).toLocaleString('en-US')} AI credits, over the ${ac.runs} of ${plural(ac.of, 'measured real run')} that have both figures).` : ''),
    example ? h('p', { class: 'hint' }, 'Reproduce for one agent run: ', h('code', {}, `gh aw outcomes ${example.runId}`), ', or ', h('a', { href: '#outcome-runs' }, 'any run id below'), '.') : null,
    h('p', { class: 'hint' }, 'Collected by the ', link(runUrl(L.snapshot.sourceRunId), 'snapshot run'), '.',
      L.ignored ? ` ${plural(L.ignored, 'malformed snapshot')} ignored.` : '', L.snapshot.dropped ? ` ${plural(L.snapshot.dropped, 'malformed entry')} skipped.` : ''),
    h('details', { class: 'fold fold--sub', id: 'outcome-runs-fold' }, h('summary', {}, `Agent runs in the snapshot (${runs.length})`),
      h('ul', { class: 'recent', id: 'outcome-runs', tabindex: '-1' }, [...runs].reverse().map((r) => h('li', { 'data-row-key': `r${r.runId}` },
        h('span', { class: 'recent-t' }, link(runUrl(r.runId), String(r.runId)), ` · ${WORKFLOW_WORD[r.workflow] ?? r.workflow}${r.task ? ` · ${shortTaskName(r.task)}` : ''}${r.drill === true || isDrill(r.task) ? ' (drill)' : ''}`),
        h('span', { class: 'recent-at' }, r.items.map((x) => x.status).join(', ') || 'no outputs'))))));
}

function renderSteps(v) {
  const s = v.steps;
  if (!state.loaded) {
    replaceSection('human-steps', empty('…'));
    return;
  }
  const intro = h('p', { class: 'hint' }, s.goLive
    ? `Manual steps since go-live (${relativeTime(s.goLive, now())}): a person putting an agent PR in the merge queue, or changing labels, pushing or starting a run on agent PRs and factory tasks. Plain reviews and comments don't count.`
    : 'Not live yet: no real agent run of a real task in the loaded audit log.');
  if (!s.steps.length) {
    replaceSection('human-steps', intro, empty('No manual steps.'));
    return;
  }
  replaceSection('human-steps', intro, h('ol', { class: 'recent' }, s.steps.slice().reverse().map((x, i) => h('li', { 'data-row-key': `${i}` },
    h('span', { class: 'recent-t' }, `${x.pr != null ? `#${x.pr}` : x.issue != null ? `#${x.issue}` : ''} ${x.task ? shortTaskName(x.task) : ''}`.trim(), ' · ', x.what),
    h('span', { class: 'recent-at' }, timeEl(x.at))))));
}

// ---------------------------------------------------------------------------
// Task board: one tile per task, grouped by contract area, coloured by state with an icon

function boardTile(t) {
  const href = t.issue != null ? `${GH}/${REPO}/issues/${t.issue}` : `${GH}/${REPO}/blob/main/${contractPath(t.id)}`;
  const word = TASK_STATE_LABELS[t.state];
  const stateText = t.state === 'done' ? `done${t.since != null ? ` ${relativeTime(t.since, now())}` : ''}`
    : t.state === 'running' ? `running${t.reason ? `, ${t.reason}` : ''}`
      : t.state === 'needs' ? `needs you${t.reason ? `: ${plainReason(t.reason)}` : ''}`
        : t.reason ?? 'waiting';
  const tier = t.tier === 'auto' ? 'Routine task' : t.tier === 'auto-strict' ? 'Core task' : 'Task';
  const tipText = `${t.id}: ${stateText}. ${tier}; select to view ${t.issue != null ? `issue #${t.issue}` : 'its contract'}.`;
  const a = h('a', { class: `tile tile--${t.state}`, href, rel: 'noopener noreferrer', 'aria-label': `${t.short}: ${word}` },
    h('span', { class: 'tile-i' }, icon(STATE_ICON[t.state])),
    h('span', { class: 'tile-n' }, t.short));
  return h('li', { 'data-row-key': t.id }, tip(a, tipText));
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
  setTip('board-info', 'One tile per task, grouped by area; colour and icon show its state. Select a tile to view its issue.');
  if (!state.loaded) {
    replaceSection('board', empty('… Loading'));
    return;
  }
  if (!b.total) {
    replaceSection('board', empty(mm.status === 'pending' ? '… Reading the task map' : 'No tasks yet'));
    return;
  }
  replaceSection('board',
    mm.status === 'error' ? tip(h('p', { class: 'board-note' }, icon('warn'), 'Task map unavailable'), `${shortError(mm.error)}. Showing the tasks seen in the audit log.`) : null,
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


function renderHuman(v) {
  const x = v.human;
  $('human').textContent = state.loaded ? `${x.total} in the last ${x.days} days (${plural(x.reviews, 'review')}, ${x.enqueues} queued to merge by hand${x.other ? `, ${x.other} other` : ''}).` : '…';
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
  const lastTip = L.lastAt == null ? `No check-in from the factory in the last ${DAYS} days.` : `The factory's last check-in, ${relativeTime(L.lastAt, now())}. Amber after ${HB_WARN} without one, red after ${HB_ALERT}.`;
  const nextTip = L.mode === 'follow-up' ? `Expected about ${FOLLOW_UP_MIN} min after the last check-in, while work is in flight.`
    : 'Expected at the next hourly run. GitHub often runs these hours late.';
  const cad = cadenceLines();
  const hv = state.healthView;
  replaceSection('live',
    stat({ key: 'last', labelFirst: true, label: 'Last check-in', value: L.lastAt == null ? '—' : timeEl(L.lastAt), level, tipText: lastTip }),
    stat({ key: 'next', labelFirst: true, label: 'Next check-in', value: L.nextAt == null ? '—' : h('span', {}, '~', timeEl(L.nextAt)), tipText: nextTip }),
    h('p', { class: 'hint pre' }, [
      `Observed: ${cad.heartbeat}`,
      `Observed: ${cad.verifier}`,
      `Check-in: green up to ${HB_WARN}, ${limitsText(DEFAULTS.heartbeatWarnMin, DEFAULTS.heartbeatAlertMin)}. ${CADENCE_NOTE}.`,
      L.followUpMissed ? `The follow-up check-in expected ${FOLLOW_UP_MIN} min after the last one hasn't arrived.` : null,
    ].filter(Boolean).join('\n')),
    h('p', { class: 'hint pre' }, [
      hv ? `Health now: ${hv.health.label}${hv.health.reasons.length ? ` (${hv.health.reasons.join('; ')})` : ''}.` : null,
      hv ? hv.detail.text : null,
      hv ? hv.chainLine : null,
      hv ? verifierReason(hv.verifier) : null,
      '',
      HEALTH_RULE,
    ].filter((x) => x != null).join('\n')));
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
  `Latest step of ${r.task ?? (r.pr != null ? `PR #${r.pr}` : 'this item')}, ${relativeTime(r.at, now())}.`))));
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
    const what = p.conclusion === 'success' ? 'passed' : p.conclusion === 'failure' ? 'failed' : String(p.conclusion ?? 'unknown');
    const where = prs.length ? `PR ${prs.map((n) => `#${n}`).join(', ')}` : p.event === 'push' ? 'main' : p.event === 'merge_group' ? 'the merge queue' : 'GitHub';
    const lines = `${wf} ${what} on ${where}, ${relativeTime(parseTime(at), now())}.${isNum(p.run_id) ? ' Select to view the run on GitHub.' : ''}`;
    const runHref = isNum(p.run_id) ? `${GH}/${REPO}/actions/runs/${p.run_id}${isNum(p.run_attempt) ? `/attempts/${p.run_attempt}` : ''}` : null;
    return h('li', { class: `chk chk--${tone}`, 'data-row-key': key },
      h('span', { class: 'chk-icon', role: 'img', 'aria-label': String(p.conclusion ?? 'unknown') }, icon(tone === 'ok' ? 'ok' : tone === 'fail' ? 'fail' : 'dot')),
      tip(runHref ? link(runHref, wf) : h('b', {}, wf), lines),
      h('span', { class: 'chk-on' }, prs.length ? prs.flatMap((n, j) => [j ? ' ' : '', link(`${GH}/${REPO}/pull/${n}`, `#${n}`)])
        : h('span', { class: 'muted' }, p.event === 'push' ? 'main' : p.event === 'merge_group' ? 'merge queue' : '—')),
      h('span', { class: 'muted' }, timeEl(at)));
  } catch (err) {
    return h('li', { class: 'chk problem', 'data-row-key': key }, `Couldn't show this check: ${err?.message ?? err}`);
  }
}

function renderChecks(mAll) {
  // The operations views in Details show the window (the scoreboard uses the whole log).
  const from = Date.parse(utcDay(now()) + 'T00:00:00Z') - (DAYS - 1) * 86400000;
  const m = { checks: mAll.checks.filter((ev) => (eventTime(ev) ?? 0) >= from) };
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
  }, all ? 'Fewer' : 'View all'), all ? `Show the newest ${CHECKS_SHOWN} only.` : `Show all ${m.checks.length} checks.`) : null;
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
  const lines = isMedian ? `Median time per stage over the tasks merged in the last ${MEDIAN_DAYS} days. Bars share one scale.`
    : `${r.task}: ${formatDuration(r.totalMs)} from ready to merge. Select to see its timeline.`;
  return h('div', { class: `srow${isMedian ? ' srow--avg' : ''}`, 'data-row-key': r.key },
    h('span', { class: 'srow-label' }, isMedian ? tip(h('b', {}, 'Median'), lines) : subjectButton(r.key, r.label, lines)),
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

  $('events-sum').textContent = records.length ? `${records.length.toLocaleString('en-US')} events in the whole log, newest first.` : '';
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
  // In-page links (the scoreboard's "manual steps") open the folds around their target.
  const openTo = (id) => {
    const el = id ? document.getElementById(id) : null;
    if (!el || !el.closest('details')) return false;
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (a && openTo(a.getAttribute('href').slice(1))) {
      e.preventDefault();
      history.replaceState(null, '', a.getAttribute('href'));
    }
  });
  if (location.hash) addEventListener('load', () => openTo(location.hash.slice(1)), { once: true });
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
