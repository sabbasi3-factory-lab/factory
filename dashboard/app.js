// Control-room UI (v2). Fetches the audit branch from GitHub, verifies it with lib.js
// and renders the panels. All DOM writes use textContent or createElement(NS), never
// innerHTML, and widths go through the CSSOM, so the strict CSP holds.
import {
  CADENCE_NOTE, DEFAULTS, STAGES, STAGE_LABELS, STALE_DATA_MIN, anchorTimes, anchorsPerDay, cadenceText, canonicalize, combineNeedsYou, compactAge, costSummary,
  dailySeries, dayPaths, deriveMetrics, dispatchBanner, existingDayPaths, formatAge, formatDuration, formatLimit, healthSummary, heartbeatTimes, limitsText, observedCadence,
  parseAnchors, parseJsonl, parseTime, pipeline, prRef, shortTitle,
  VERIFIER_LIMITS, heartbeatTile, sparkSegments, stageBreakdown, statusSummary, subjectLabel, reviewItems, summarizePr, timelineFor, typicalRunMs, unmergedPrs, utcDay,
  verifierReason, verifierStatus, verifyChain,
} from './lib.js';

const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
const BRANCH = 'audit';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const GH = 'https://github.com';
const TOKEN_KEY = 'factory-dashboard.github-token';
const THEME_KEY = 'factory-dashboard.theme';
// Sample data (relative URLs, so they work locally and on Pages): ?fixture=1 is a busy
// factory, ?fixture=quiet the quiet state the live page is usually in.
const FIXTURES = Object.freeze({
  1: { events: 'test/fixtures/sample.jsonl', anchors: 'test/fixtures/anchors.jsonl' },
  quiet: { events: 'test/fixtures/quiet.jsonl', anchors: 'test/fixtures/quiet-anchors.jsonl' },
});
const MISSING_BRANCH_POLL_S = 300;
// Open-PR lists (product repo for PR lanes; both repos for owner reviews). v1 audit events
// have no "closed" PR event and no human-tier PR events, so these come from GitHub directly.
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

const params = new URLSearchParams(location.search);
const FIXTURE_PARAM = Object.hasOwn(FIXTURES, params.get('fixture') ?? '') ? params.get('fixture') : null;
const FIXTURE = FIXTURE_PARAM != null;
const FIXTURE_URL = FIXTURE ? FIXTURES[FIXTURE_PARAM].events : null;
const ANCHORS_FIXTURE_URL = FIXTURE ? FIXTURES[FIXTURE_PARAM].anchors : null;
const POLL_S = clampInt(params.get('poll'), 30, 10, 3600);
const DAYS = clampInt(params.get('days'), DEFAULTS.windowDays, 1, 31);

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
  expandedLanes: new Set(), // done lanes showing every card
  checksExpanded: false,
  kpiSig: null,
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
};

const $ = (id) => document.getElementById(id);
const now = () => Date.now() + state.clockOffset;

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

function prLink(n) {
  return isNum(n) ? link(`${GH}/${REPO}/pull/${n}`, `#${n}`) : '—';
}
function commitLink(sha) {
  return isSha(sha) ? link(`${GH}/${REPO}/commit/${sha}`, h('code', {}, sha.slice(0, 7))) : '—';
}

function timeEl(ts) {
  const ms = parseTime(ts);
  if (ms == null) return '—';
  const iso = new Date(ms).toISOString();
  const sameDay = utcDay(ms) === utcDay(now());
  const text = sameDay ? iso.slice(11, 19) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  return h('time', { datetime: iso, title: iso }, text);
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

// A duration that grows with the clock; clock-only refreshes update just its text.
// Compact cells show one token ("7h"); the exact duration is in the item's tooltip.
function clockCell(sinceMs, compact = false) {
  if (sinceMs == null) return '—';
  return h('span', { 'data-since': String(sinceMs), 'data-compact': compact ? '1' : null }, (compact ? compactAge : formatDuration)(now() - sinceMs));
}

function updateClockCells() {
  for (const el of document.querySelectorAll('[data-since]')) {
    const fmt = el.hasAttribute('data-compact') ? compactAge : formatDuration;
    const text = fmt(now() - Number(el.getAttribute('data-since')));
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of document.querySelectorAll('[data-bar-since]')) setBar(el);
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

async function maybeRefreshPrs(headChanged) {
  const p = state.prs;
  if (headChanged) p.headDirty = true;
  const age = p.fetchedAt == null ? Infinity : Date.now() - p.fetchedAt;
  const due = !p.lastOk || age >= PR_MAX_AGE_MS || (p.headDirty && age >= PR_MIN_AGE_MS);
  if (!due) return;
  if (!p.lastOk && p.attemptedAt && Date.now() - p.attemptedAt < PR_RETRY_MS) return;
  p.attemptedAt = Date.now();
  if (state.rate && state.rate.remaining < PR_REPOS.length + 1) {
    p.lastOk = false;
    p.error = 'GitHub API rate limit is too low to read the PR lists';
    state.dataVersion++;
    return;
  }
  try {
    const lists = await Promise.all(PR_REPOS.map(fetchOpenPrs));
    PR_REPOS.forEach((repo, i) => p.lists.set(repo, lists[i]));
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

function openPrSet() {
  if (FIXTURE) return unmergedPrs(state.events); // sample data: opened and never merged
  return prsKnown() ? new Set((state.prs.lists.get(REPO)?.prs ?? []).map((p) => p.number)) : null;
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

async function tick() {
  clearTimeout(state.timer);
  if (state.busy) return;
  state.busy = true;
  let delayS = POLL_S;
  try {
    if (FIXTURE) {
      if (!state.loaded) await loadFixture();
      await maybeRefreshVerifier();
    } else if (document.visibilityState === 'hidden' && state.loaded) {
      delayS = POLL_S; // don't spend requests on a hidden tab
    } else {
      const headBefore = state.headSha;
      try {
        delayS = await pollGitHub();
      } finally {
        await maybeRefreshPrs(state.headSha !== headBefore);
        await maybeRefreshVerifier();
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

const pctText = (v) => (v == null ? '—' : `${Math.round(v)}%`);
const millions = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** A 7-day trend line. Null values leave a gap rather than a fake zero. */
function sparkline(values, days, { label, tone = 'blue', format = (v) => String(v) } = {}) {
  const w = 200;
  const ht = 96;
  const pad = 4;
  const nums = values.filter(isNum);
  const described = days.map((d, i) => `${d.slice(5)} ${values[i] == null ? 'none' : format(values[i])}`).join(', ');
  const el = svg('svg', {
    class: `spark spark--${tone}`, viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': `${label}, oldest to newest: ${described}`,
  });
  el.append(svg('path', { class: 'spark-base', d: `M0 ${ht - pad} L${w} ${ht - pad}` }));
  if (!nums.length) return el;
  const max = Math.max(...nums);
  const min = Math.min(0, ...nums);
  const x = (i) => (values.length === 1 ? w / 2 : (i * w) / (values.length - 1));
  const y = (v) => ht - pad - ((v - min) / (max - min || 1)) * (ht - 2 * pad);
  const { points, segments } = sparkSegments(values);
  for (const seg of segments) {
    const d = seg.map(({ i, v }, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    el.append(svg('path', { class: 'spark-area', d: `${d} L${x(seg.at(-1).i).toFixed(1)} ${ht - pad} L${x(seg[0].i).toFixed(1)} ${ht - pad} Z` }));
    el.append(svg('path', { class: 'spark-line', d }));
  }
  // A marker for every valid point, so isolated days between gaps stay visible.
  points.forEach(({ i, v }, k) => el.append(svg('circle', {
    class: k === points.length - 1 ? 'spark-dot spark-dot--last' : 'spark-dot', cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: k === points.length - 1 ? 3 : 2,
  })));
  return el;
}

// Clock-dependent parts re-render on every tick; the rest only when data or a selection changes,
// so open selects, expanded rows and text selections aren't disturbed.
function render({ full = false } = {}) {
  let m = null;
  let metricsError = null;
  try {
    m = deriveMetrics(state.events, { now: now() });
  } catch (err) {
    metricsError = err;
  }
  const withMetrics = (fn) => () => {
    if (!m) throw metricsError;
    fn(m);
  };
  let needs = null;
  try {
    if (m) needs = needsView(m);
  } catch (err) {
    console.error('dashboard: deriving Needs you failed', err);
  }
  try {
    renderHeader(m, needs);
  } catch (err) {
    setStatus(`Problem showing the header: ${err?.message ?? err}`);
  }
  safe('kpis', withMetrics(renderKpis)); // rebuilt only when a shown value changes
  const known = FIXTURE || prsKnown();
  if (full || state.renderedVersion !== state.dataVersion || state.prsKnownRendered !== known) {
    state.renderedVersion = state.dataVersion;
    state.prsKnownRendered = known;
    safe('needs', withMetrics((mm) => renderNeeds(mm, needs ?? needsView(mm))));
    safe('pipeline', renderPipeline);
    safe('agents', withMetrics(renderAgents));
    safe('checks', withMetrics(renderChecks));
    safe('stages', withMetrics(renderStages));
    safe('cost', withMetrics(renderCost));
    safe('timeline', withMetrics(renderTimeline));
    safe('events', renderEvents);
  }
  updateClockCells();
  refreshTip();
  // Readiness marker for tests and tools: data (or its error) is shown, and in live mode
  // the open-PR lists have been read or have failed.
  const settled = state.loaded || state.error || state.noLog;
  if (settled && (FIXTURE || state.prs.fetchedAt != null || state.prs.error)) document.documentElement.dataset.ready = '1';
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

function infoButton(label, text) {
  return tip(h('button', { type: 'button', class: 'info', 'aria-label': label }, icon('info')), text);
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
// Header: one glance line (health, needs you, kill switch, dry run)

// "loading" is neutral on purpose: before the first load nothing is known to be wrong.
const TONE = { ok: 'ok', warn: 'warn', alert: 'alert', info: 'info', loading: 'muted' };
const LEVEL_ICON = { ok: 'ok', warn: 'warn', alert: 'fail', info: 'dot', loading: null };
const LEVEL_WORD = { ok: 'ok', warn: 'warning', alert: 'alert', info: 'checking', loading: 'loading' };
const HB_WARN = formatLimit(DEFAULTS.heartbeatWarnMin);
const HB_ALERT = formatLimit(DEFAULTS.heartbeatAlertMin);
const VF_WARN = formatLimit(VERIFIER_LIMITS.warnMin);
const VF_ALERT = formatLimit(VERIFIER_LIMITS.alertMin);
const HEALTH_RULE = `Healthy: fresh data, verified chain, heartbeat within ${HB_WARN}, verifier anchor within ${VF_WARN}.\n`
  + `Degraded: last refresh failed, data over ${STALE_DATA_MIN} min old, heartbeat late (over ${HB_WARN}), chain not verified, verifier late (over ${VF_WARN}) or not set up.\n`
  + `Down: no audit log, broken chain, heartbeat missing or over ${HB_ALERT}, verifier over ${VF_ALERT} or unreadable.`;

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

function renderDispatchBanner() {
  const el = $('dispatch-banner');
  const b = state.loaded ? dispatchBanner(state.events, { now: now() }) : null;
  el.hidden = !b;
  if (!b) return;
  el.className = `banner banner--${b.level} has-tip`;
  el.replaceChildren(icon(b.level === 'warn' ? 'warn' : 'info'), h('span', {}, b.text), h('span', { id: 'dispatch-banner-tip', class: 'tip-src', hidden: true }, b.tip));
  el.setAttribute('aria-describedby', 'dispatch-banner-tip');
}

function renderHeader(m, needs) {
  const chain = state.chain;
  const hb = m?.heartbeat ?? null;
  const dataAgeMin = FIXTURE || state.lastOkAt == null ? null : (Date.now() - state.lastOkAt) / 60000;
  const verifier = verifierStatus(state.verifier, now());
  const health = healthSummary({ loaded: state.loaded, noLog: state.noLog, error: state.error, chain, heartbeat: hb, dataAgeMin, verifier });
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
      ...(state.loaded ? (({ heartbeat, verifier: v }) => ['', `Observed: ${heartbeat}`, `Observed: ${v}`, CADENCE_NOTE])(cadenceLines()) : [])].join('\n'),
  });
  setStatus(`Factory ${health.label}${health.level !== 'ok' && health.reasons.length ? `: ${health.reasons[0]}` : ''}`);

  if (needs && (state.loaded || state.error)) {
    const n = needs.items.length;
    const reviews = needs.items.filter((it) => it.kind === 'review').length;
    const unknown = needs.rs === 'unavailable';
    const lines = [`${n - reviews} audit item${n - reviews === 1 ? '' : 's'}, ${reviews} PR review${reviews === 1 ? '' : 's'}`];
    if (unknown) lines.push(`Review list unavailable: ${state.prs.error ?? 'the PR lists are out of date'}`);
    if (n > DEFAULTS.humanQueueMax) lines.push(`Over the review queue cap of ${DEFAULTS.humanQueueMax}`);
    setChip('needs-link', n
      ? { tone: 'warn', iconName: unknown ? 'warn' : 'person', text: `${n} need${n === 1 ? 's' : ''} you`, tipText: lines.join('\n') }
      : unknown ? { tone: 'warn', iconName: 'question', text: 'Reviews unknown', tipText: lines.join('\n') }
        : needs.rs === 'pending' ? { tone: 'info', iconName: 'dot', text: 'Checking reviews', tipText: 'Reading the open-PR lists' }
          : { tone: 'ok', iconName: 'ok', text: 'Nothing needs you', tipText: lines.join('\n') });
  } else {
    setChip('needs-link', { hidden: true });
  }

  renderVerifierLine(verifier);

  const enabled = m?.killSwitch?.enabled ?? null;
  setChip('kill-chip', {
    // Off is the deliberate, safe state: neutral grey, not red (red means Down).
    hidden: enabled == null, tone: enabled ? 'ok' : 'muted', iconName: 'power', text: enabled ? 'Factory on' : 'Factory off',
    tipText: `factory_enabled from the latest heartbeat${m?.killSwitch?.at ? ` (${m.killSwitch.at})` : ''}; off means no new dispatches`,
  });
  const dryRun = m?.dryRun ?? null;
  const version = m?.factoryVersion ?? null;
  setChip('dry-badge', {
    hidden: dryRun == null, tone: dryRun ? 'warn' : 'ok', iconName: dryRun ? 'info' : 'bolt', text: dryRun ? 'Dry run' : 'Live',
    tipText: `${dryRun ? 'Decisions are logged, not acted on' : 'Decisions take effect'}${version ? `\nFactory version ${version}` : ''}`,
  });
  renderDispatchBanner();
  const clock = new Date(now()).toISOString().slice(11, 16);
  setChip('mode-badge', { hidden: !FIXTURE, tone: 'info', iconName: 'info', text: 'Sample', tipText: `Sample data from ${FIXTURE_URL}, clock pinned at ${clock}Z. Remove ?fixture=${FIXTURE_PARAM} for live data.` });

  const meta = [];
  if (FIXTURE) meta.push(`sample data from ${FIXTURE_URL}`);
  else {
    if (state.lastCheck) meta.push(`checked ${new Date(state.lastCheck).toISOString().slice(11, 19)}Z`);
    if (state.nextCheckAt) meta.push(`next in ${Math.max(0, Math.round((state.nextCheckAt - Date.now()) / 1000))} s`);
    const r = state.rate;
    if (r) meta.push(`API ${r.remaining}/${r.limit} left` + (r.reset ? `, resets ${new Date(r.reset).toISOString().slice(11, 16)}Z` : ''));
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
  $('kpi-days').textContent = String(DAYS);
}

// The independent verifier has no chip of its own: it's part of the health chip (and
// its tooltip) and the "Verified" tile. The audit-log section keeps a muted detail line.
function renderVerifierLine(v) {
  const line = $('verifier-line');
  if (line.textContent !== v.line) line.textContent = v.line;
}

// ---------------------------------------------------------------------------
// KPI tiles: label, big number, trend line; everything else is in the tile's tooltip

const FORMATS = {
  pct: pctText,
  int: (v) => fmtInt(Math.round(v)),
  dur: (v) => formatDuration(v * 60000),
  n: (v) => String(v),
};

function kpi({ title, iconName, value, unit = null, level = null, tipText, spark }) {
  if (level === 'loading') level = null; // neutral "…" until the first load
  const el = h('article', { class: `panel kpi${level ? ` kpi--${level}` : ''}` },
    h('h3', { class: 'kpi-t' }, icon(iconName), title),
    h('p', { class: 'kpi-v' },
      level ? h('span', { class: 'kpi-state', role: 'img', 'aria-label': LEVEL_WORD[level] }, icon(LEVEL_ICON[level])) : null,
      h('span', {}, value),
      unit ? h('small', {}, unit) : null),
    sparkline(spark.values, spark.days, { label: spark.label, tone: spark.tone, format: FORMATS[spark.fmt] }));
  return tip(el, tipText);
}

function verifiedTile() {
  const v = verifierStatus(state.verifier, now());
  const anchors = loadedAnchors();
  const perDay = anchorsPerDay(anchors, { now: now(), days: DAYS });
  return {
    title: 'Verified', iconName: 'shield', value: v.level === 'info' ? '…' : v.ageMin == null ? '—' : compactAge(v.ageMin * 60000),
    level: v.level === 'info' ? null : v.level,
    tipText: [
      verifierReason(v),
      v.line,
      cadenceLines(anchors).verifier,
      `Independent audit-verify run: green up to ${VF_WARN}, ${limitsText(VERIFIER_LIMITS.warnMin, VERIFIER_LIMITS.alertMin)} or if the anchors file is unreadable`,
      CADENCE_NOTE,
      'Trend counts anchors per day (24 scheduled)',
    ].join('\n'),
    spark: { values: perDay.counts, days: perDay.days, label: 'Verifier anchors per day (24 scheduled)', tone: 'green', fmt: 'n' },
  };
}

function renderKpis(m) {
  const s = dailySeries(state.events, { now: now(), days: DAYS });
  const zt = m.zeroTouch;
  const hb = m.heartbeat;
  const aic = m.aicToday;
  const mergedWeek = s.merged.reduce((a, b) => a + b, 0);
  const hbTile = heartbeatTile(hb, state.loaded);
  const hbIso = hb.at ? ` (${hb.at})` : '';
  const tiles = [
    {
      title: 'Zero-touch', iconName: 'ok', value: zt.rate == null ? '—' : pctText(zt.rate * 100),
      tipText: zt.merged ? `${zt.untouched} of ${zt.merged} merged factory PRs had no human action` : 'No merged factory PRs yet',
      spark: { values: s.zeroTouchPct, days: s.days, label: 'Zero-touch rate so far', tone: 'green', fmt: 'pct' },
    },
    {
      title: 'Checks', iconName: 'shield', value: pctText(s.checks.pct),
      tipText: s.checks.total ? `${s.checks.passed} of ${s.checks.total} check runs passed in ${DAYS} days` : 'No check results yet',
      spark: { values: s.checksPassPct, days: s.days, label: 'Share of check runs that passed, by day', tone: 'green', fmt: 'pct' },
    },
    {
      title: 'AIC today', iconName: 'coin', value: fmtInt(Math.round(aic.total)),
      level: aic.level === 'ok' ? null : aic.level,
      tipText: `${fmtInt(Math.round(aic.total))} of ${fmtInt(aic.budget)} AIC today (UTC): ${(aic.pct ?? 0).toFixed(1)}% of the daily budget; amber at ${DEFAULTS.aicAlertPct}%, red at 100%${
        aic.source === 'spend_snapshot'
          ? `\n${aic.measured == null ? `Measured/reserved split unavailable (the snapshot lists ${aic.listed} of ${aic.runs ?? '?'} runs)` : `${fmtInt(Math.round(aic.measured))} measured + ${fmtInt(Math.round(aic.reserved))} reserved for runs in flight (${aic.runs} runs)`}, controller snapshot ${aic.at}`
          : '\nNo spend snapshot today yet'
      }`,
      spark: { values: s.aic, days: s.days, label: 'AIC per day', tone: 'purple', fmt: 'int' },
    },
    {
      title: 'Merged today', iconName: 'branch', value: String(m.mergedToday.count),
      tipText: `${m.mergedToday.count ? `Today (UTC): PR ${m.mergedToday.prs.slice(0, 8).map((n) => `#${n}`).join(', ')}${m.mergedToday.prs.length > 8 ? ` +${m.mergedToday.prs.length - 8} more` : ''}\n` : ''}${mergedWeek} merged in ${DAYS} days`,
      spark: { values: s.merged, days: s.days, label: 'PRs merged per day', tone: 'blue', fmt: 'n' },
    },
    {
      title: 'Merge time', iconName: 'clock', value: s.mergeMedianAllMin == null ? '—' : compactAge(s.mergeMedianAllMin * 60000),
      tipText: s.mergeMedianAllMin == null ? 'No merged PRs with an opened time yet' : `Median from PR opened to merged over ${DAYS} days: ${formatDuration(s.mergeMedianAllMin * 60000)}`,
      spark: { values: s.mergeMedianMin, days: s.days, label: 'Median time to merge, by day', tone: 'blue', fmt: 'dur' },
    },
    {
      title: 'Heartbeat', iconName: 'pulse', value: hbTile.value, level: hbTile.level,
      tipText: [
        hb.ageMin == null ? `No heartbeat in the last ${DAYS} days` : `Last heartbeat ${formatAge(hb.ageMin)} ago${hbIso}`,
        cadenceLines().heartbeat,
        `Green up to ${HB_WARN}, ${limitsText(DEFAULTS.heartbeatWarnMin, DEFAULTS.heartbeatAlertMin)}`,
        CADENCE_NOTE,
        'Trend counts heartbeats per day (24 scheduled)',
      ].join('\n'),
      spark: { values: s.heartbeats, days: s.days, label: 'Heartbeats per day (24 scheduled)', tone: 'green', fmt: 'n' },
    },
  ];
  tiles.push(verifiedTile());
  for (const t of tiles) t.tipText += `\nTrend: last ${DAYS} UTC days`;
  // Rebuild only when something shown changed, so focus and an open tooltip stay put.
  const sig = JSON.stringify(tiles);
  if (sig === state.kpiSig && $('kpis').children.length) return;
  state.kpiSig = sig;
  replaceSection('kpis', tiles.map(kpi));
}

// ---------------------------------------------------------------------------
// Needs you: one line per item

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

// Titles stay at 4 words so a few items fit the fold budget; the full title is in the tooltip.
const NEEDS_TITLE_WORDS = 4;

function needsRow(it) {
  const since = it.since ? parseTime(it.since) : null;
  const waited = since == null ? null : `Waiting ${formatDuration(now() - since)}, since ${new Date(since).toISOString().slice(0, 16)}Z`;
  let iconName;
  let kind;
  let ref;
  let title;
  let lines;
  let action = null;
  if (it.kind === 'review') {
    iconName = 'person';
    kind = 'Review and merge';
    ref = prRef(it.repo, it.number, REPO);
    title = it.title || '(no title)';
    lines = [`Review and merge ${it.repo.split('/')[1]}#${it.number}`, title];
    action = viewLink(it.url, 'View PR');
  } else {
    iconName = it.kind === 'needs_human' ? 'warn' : 'clock';
    kind = it.kind === 'needs_human' ? 'Needs human' : 'Stale contract';
    ref = it.issue != null ? `#${it.issue}` : it.pr != null ? `#${it.pr}` : '—';
    // The icon (and its tooltip) says which kind; the line shows just the task.
    title = it.task ?? (it.pr != null ? `PR #${it.pr}` : `issue #${it.issue ?? '?'}`);
    lines = [`${kind}: ${title}`, it.reason ? `Reason: ${it.reason}` : null, it.effect ? `Effect: ${it.effect}` : null];
    if (it.issue != null) action = viewLink(`${GH}/${REPO}/issues/${it.issue}`, 'View issue');
    else if (it.pr != null) action = viewLink(`${GH}/${REPO}/pull/${it.pr}`, 'View PR');
  }
  return h('li', { 'data-row-key': it.key },
    h('span', { class: `needs-icon${it.kind === 'needs_human' ? ' needs-icon--alert' : ''}`, role: 'img', 'aria-label': kind }, icon(iconName)),
    h('span', { class: 'needs-ref mono' }, ref),
    tip(h('span', { class: 'needs-t' }, shortTitle(title, NEEDS_TITLE_WORDS)), [...lines, waited].filter(Boolean).join('\n')),
    since != null ? h('span', { class: 'age-chip' }, clockCell(since, true)) : h('span'),
    action ?? h('span'));
}

function renderNeeds(m, view = needsView(m)) {
  const cap = DEFAULTS.humanQueueMax;
  const { rs, items } = view;
  if (!state.loaded && !state.error) {
    $('needs-panel').classList.remove('needs--clear');
    replaceSection('needs', h('p', { class: 'needs-note' }, '… Loading'));
    return;
  }
  setTip('needs-info', [
    'Needs-human items, stale contracts and human-tier PRs waiting for your review, oldest first.',
    'Review items: open, non-draft PRs in either repo whose body says "Tier: human" or "Tier: owner", or with an owner-review, human-tier or needs-human label.',
    `Above ${cap}, the controller stops admitting new human-tier work.`,
    rs === 'sample' ? 'Sample data: review items are read live from GitHub, so none are shown here.' : null,
  ].filter(Boolean).join('\n'));
  const reviewNote = rs === 'unavailable'
    ? tip(h('p', { class: 'needs-note needs-note--warn' }, icon('warn'), 'Review list unavailable'),
      `${state.prs.error ?? 'The PR lists are out of date'}, so PRs waiting for your review aren't shown.`)
    : rs === 'pending' ? h('p', { class: 'needs-note' }, icon('dot'), 'Checking reviews…') : null;
  const clear = !items.length && (rs === 'ok' || rs === 'sample');
  $('needs-panel').classList.toggle('needs--clear', clear);
  if (!items.length) {
    // The header chip already says "Nothing needs you", so the panel shows just the count.
    // It keeps its place (and its height), so the page doesn't jump when an item arrives,
    // and so the detail panels below don't rise above the fold.
    replaceSection('needs', clear
      ? tip(h('p', { class: 'needs-head needs-head--clear' },
        h('span', { class: 'needs-ok', role: 'img', 'aria-label': 'Nothing needs you' }, icon('ok')),
        h('span', { class: 'big' }, '0')),
      'Nothing needs you: no needs-human items, stale contracts or PRs waiting for your review.')
      : reviewNote);
    return;
  }
  replaceSection('needs',
    h('div', { class: 'needs-head' },
      h('span', { class: 'big' }, String(items.length)),
      items.length > cap ? tip(h('span', { class: 'needs-cap' }, icon('warn'), 'Over cap'), `More than ${cap} items: the controller stops admitting new human-tier work until you catch up.`) : null),
    reviewNote,
    h('ul', { class: 'needs-list' }, items.map((it) => {
      try {
        return needsRow(it);
      } catch (err) {
        return h('li', { class: 'problem', 'data-row-key': it.key ?? '?' }, `Couldn't show this item: ${err?.message ?? err}`);
      }
    })));
}

// ---------------------------------------------------------------------------
// Pipeline: lanes of cards; done lanes show the latest few

const DONE_SHOWN = 3;
const DONE_UI = new Set(['merged', 'deployed']);
const SIDE_ICONS = { 'needs human': 'person', 'stale contract': 'clock', blocked: 'warn' };

function tagIcon(t) {
  if (SIDE_ICONS[t.text]) return SIDE_ICONS[t.text];
  if (t.text.startsWith('repair')) return 'refresh';
  if (t.text === 'dry-run plan') return 'info';
  return 'fail';
}

function laneCard(c) {
  const pr = c.prs.length ? c.prs[c.prs.length - 1] : null;
  const ref = pr != null ? `#${pr}` : c.issue != null ? `#${c.issue}` : c.label;
  const href = pr != null ? `${GH}/${REPO}/pull/${pr}` : c.issue != null ? `${GH}/${REPO}/issues/${c.issue}` : null;
  const lines = [href ? `View ${pr != null ? 'PR' : 'issue'} ${ref} on GitHub` : 'Show the timeline'];
  lines.push(c.kind === 'task' ? `Task ${c.label}` : c.label);
  if (c.issue != null && pr != null) lines.push(`Issue #${c.issue}`);
  if (c.prs.length > 1) lines.push(`PRs ${c.prs.map((n) => `#${n}`).join(', ')}`);
  const run = [c.workflow, c.attempt != null ? `attempt ${c.attempt}` : null, c.model].filter(Boolean).join(' · ');
  if (run) lines.push(run);
  for (const t of c.tags) lines.push(t.title ? `${t.text}: ${t.title}` : t.text);
  if (c.enteredAt != null) lines.push(`In this stage for ${formatDuration(now() - c.enteredAt)}`);
  const main = href ? link(href, ref) : h('button', { type: 'button', class: 'linklike', onclick: () => showTimeline(c.key) }, ref);
  return h('div', { class: 'task', 'data-row-key': c.key },
    tip(main, lines.join('\n')),
    c.tags.map((t) => h('span', { class: `flag tag--${t.tone}`, role: 'img', 'aria-label': t.text }, icon(tagIcon(t)))),
    c.enteredAt != null ? h('span', { class: 'age-chip' }, clockCell(c.enteredAt, true)) : null);
}

function renderPipeline() {
  const pl = pipeline(state.events, { openPrs: openPrSet() });
  const closedEl = $('pipe-closed');
  closedEl.hidden = !pl.closed.length;
  closedEl.replaceChildren(`Closed ${pl.closed.length}`, h('span', { id: 'pipe-closed-tip', class: 'tip-src', hidden: true }, `Closed without merging: ${pl.closed.map((c) => c.label).join(', ')}`));
  setTip('pipe-info', `One card per task, or per PR without a task, in the lane of its latest stage, with how long it has been there. Icons on a card: needs human, stale contract, failed check, repair, dry-run plan; hover or focus a card for details.\nMerged and Deployed show the latest ${DONE_SHOWN}.\nWIP limit ${DEFAULTS.wipLimit} · review queue cap ${DEFAULTS.humanQueueMax}.`);
  if (!pl.total) {
    replaceSection('pipeline', empty(state.noLog ? 'No audit log yet' : 'No tasks or PRs yet'));
    return;
  }
  const lanes = pl.lanes.map((l) => {
    const n = l.cards.length;
    const capped = DONE_UI.has(l.key) && n > DONE_SHOWN;
    const expanded = capped && state.expandedLanes.has(l.key);
    const shown = capped && !expanded ? l.cards.slice(0, DONE_SHOWN) : l.cards;
    const more = capped ? tip(h('button', {
      type: 'button', class: 'more', 'aria-expanded': String(expanded), 'aria-controls': `lane-${l.key}`,
      onclick: () => {
        if (state.expandedLanes.has(l.key)) state.expandedLanes.delete(l.key);
        else state.expandedLanes.add(l.key);
        safe('pipeline', renderPipeline); // restores focus to this button
      },
    }, expanded ? 'Fewer' : `+${n - DONE_SHOWN}`), expanded ? `Show only the latest ${DONE_SHOWN}` : `Show ${n - DONE_SHOWN} more`) : null;
    return h('div', { class: `lane st-${l.key}${n ? '' : ' lane--empty'}`, role: 'group', 'aria-label': `${l.label}: ${n}` },
      h('h3', { class: 'lane-h' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'lane-name' }, SHORT_STAGE[l.key] ?? l.label),
        // Active lanes show every card and an empty lane shows none, so only done lanes
        // with cards (capped at the latest few) need a count. The group's label has it.
        n && DONE_UI.has(l.key) ? h('span', { class: 'n' }, String(n)) : null),
      l.prStateUnknown ? tip(h('span', { class: 'lane-note', role: 'img', 'aria-label': 'PR state unknown' }, icon('question')), "PR state unknown: the open-PR list couldn't be read, so these PRs may have been closed.") : null,
      n ? h('div', { class: 'lane-cards', id: `lane-${l.key}` }, shown.map((c) => {
        try {
          return laneCard(c);
        } catch (err) {
          return h('p', { class: 'problem' }, `Couldn't show this card: ${err?.message ?? err}`);
        }
      }), more) : null);
  });
  replaceSection('pipeline', h('div', { class: 'lanes-wrap', role: 'region', 'aria-label': 'Pipeline lanes', tabindex: '0', 'data-focus-key': 'table' },
    h('div', { class: 'lanes' }, lanes)));
}

function setBar(el) {
  const since = Number(el.getAttribute('data-bar-since'));
  const span = Number(el.getAttribute('data-bar-span'));
  const elapsed = now() - since;
  withWidth(el, (elapsed / span) * 100);
  el.classList.toggle('late', elapsed > span / 2);
}

function renderAgents(m) {
  const r = m.running;
  const typical = typicalRunMs(state.events);
  const wip = isNum(r.wipLimit) ? r.wipLimit : null;
  // Without run_finished or the controller's task_done in the window, completion is unknown, so a
  // count of listed attempts would be a guess: show "—" then. With nothing listed, nothing runs.
  const count = r.available ? r.count : r.rows.length ? null : 0;
  setTip('agents-info', [
    `Dispatched tasks in flight (not yet merged, done, handed to a person or cancelled), against the WIP limit${wip == null ? '' : ` of ${wip}`}.`,
    r.available ? null : "Completion isn't in the log yet (no run_finished or task_done events), so listed attempts are the ones not superseded, merged, escalated or cancelled; some may already have finished.",
    r.dryRunPlanned ? `${r.dryRunPlanned} dry-run dispatch${r.dryRunPlanned === 1 ? '' : 'es'} planned, not running.` : null,
  ].filter(Boolean).join('\n'));
  const slotCount = Math.max(wip ?? 0, count ?? 0);
  const line = h('div', { class: 'agents-line' },
    h('span', { class: 'agents-n' }, `${count ?? '—'} of ${wip ?? '—'} agents running`),
    h('span', { class: 'slots', 'aria-hidden': 'true' }, Array.from({ length: slotCount }, (_, i) => h('span', {
      class: `slot${count == null ? ' slot--unknown' : wip != null && i >= wip ? ' slot--over' : i < count ? ' slot--on' : ''}`,
    }))));
  if (!r.rows.length) {
    $('agents').classList.add('panel--compact');
    replaceSection('agents', line);
    return;
  }
  $('agents').classList.remove('panel--compact');
  const cards = r.rows.map((a) => {
    const repair = a.workflow === 'repair';
    const bar = typical && a.startedAt != null
      ? h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { 'data-bar-since': String(a.startedAt), 'data-bar-span': String(typical * 2) }))
      : null;
    const lines = [
      [a.task, a.issue != null ? `issue #${a.issue}` : null].filter(Boolean).join(' · ') || 'Attempt',
      [`${a.workflow}${a.attempt != null ? ` attempt ${a.attempt}` : ''}`, a.state, a.model].filter(Boolean).join(' · '),
      a.runId != null ? `Run ${a.runId}` : null,
      a.startedAt != null ? `Started ${new Date(a.startedAt).toISOString().slice(0, 16)}Z` : null,
      typical ? `Typical run ${formatDuration(typical)}; the bar fills at twice that` : null,
    ].filter(Boolean).join('\n');
    const label = a.task ?? (a.issue != null ? `#${a.issue}` : 'attempt');
    return h('div', { class: 'agent', 'data-row-key': a.key },
      r.available
        ? h('span', { class: `spin${repair ? ' spin--repair' : ''}`, role: 'img', 'aria-label': repair ? 'repairing' : 'running' })
        : h('span', { class: 'agent-unknown', role: 'img', 'aria-label': 'status unknown' }, icon('question')),
      h('div', { class: 'agent-main' },
        h('p', { class: 'n1' }, a.task ? subjectButton(`task:${a.task}`, label, lines) : tip(h('span', {}, label), lines),
          repair ? h('span', { class: 'flag tag--warn', role: 'img', 'aria-label': `repair${a.attempt != null ? ` attempt ${a.attempt}` : ''}` }, icon('refresh')) : null),
        bar),
      h('div', { class: 'el' }, clockCell(a.startedAt, true)));
  });
  replaceSection('agents', line, h('div', { class: 'agents' }, cards));
  for (const el of $('agents').querySelectorAll('[data-bar-since]')) setBar(el);
}

function shortTimeEl(ts) {
  const ms = parseTime(ts);
  if (ms == null) return '—';
  const iso = new Date(ms).toISOString();
  return h('time', { datetime: iso }, utcDay(ms) === utcDay(now()) ? iso.slice(11, 16) : iso.slice(5, 10));
}

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
      h('span', { class: 'mono muted' }, shortTimeEl(at)));
  } catch (err) {
    return h('li', { class: 'chk problem', 'data-row-key': key }, `Couldn't show this check: ${err?.message ?? err}`);
  }
}

function renderChecks(m) {
  const passed = m.checks.filter((ev) => ev.payload?.conclusion === 'success').length;
  $('checks-count').textContent = m.checks.length ? `${passed}/${m.checks.length}` : '';
  setTip('checks-info', `Newest check runs first: pass or fail, workflow, PR and time (UTC). ${m.checks.length ? `${passed} of ${m.checks.length} passed in ${DAYS} days. ` : ''}Hover or focus a workflow for its run, held-out seed and failure signature.`);
  $('checks').classList.toggle('panel--compact', !m.checks.length);
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

function stackRow(r, maxMs, isAverage = false) {
  const desc = r.segments.map((sg) => `${STAGE_LABELS[sg.stage]} ${formatDuration(sg.ms)}`).join(', ');
  const stack = withWidth(h('div', { class: 'stack', role: 'img', 'aria-label': `${r.label}: ${desc}; total ${formatDuration(r.totalMs)}` },
    r.segments.map((sg) => withWidth(h('i', { class: `seg st-${sg.stage}` }), (sg.ms / r.totalMs) * 100))),
  (r.totalMs / maxMs) * 100);
  const lines = `${isAverage ? `Average per task or PR over ${DAYS} days` : r.label}\n${r.segments.map((sg) => `${STAGE_LABELS[sg.stage]}: ${formatDuration(sg.ms)}`).join('\n')}\nTotal ${formatDuration(r.totalMs)}`;
  return h('div', { class: `srow${isAverage ? ' srow--avg' : ''}`, 'data-row-key': r.key },
    h('span', { class: 'srow-label' }, isAverage ? tip(h('b', {}, 'Average'), lines) : subjectButton(r.key, r.label.replace(/^PR /, ''), `Show the timeline\n${lines}`)),
    h('div', { class: 'track' }, stack),
    h('span', { class: 'mono muted num' }, compactAge(r.totalMs)));
}

function renderStages(m) {
  const sb = stageBreakdown(m.stageTimes);
  const shown = sb.rows.slice(-10);
  setTip('stages-info', `Time from each stage to the next, per task or PR (first arrival at each stage). Bars share one scale; hover or focus a label for the breakdown.${sb.rows.length > shown.length ? `\nShowing the latest ${shown.length} of ${sb.rows.length}.` : ''}`);
  $('stages').classList.toggle('panel--compact', !sb.rows.length);
  if (!sb.rows.length) {
    replaceSection('stages', empty('No stage data yet'));
    return;
  }
  const used = STAGES.filter((st) => sb.rows.some((r) => r.segments.some((sg) => sg.stage === st)));
  const ins = sb.insight;
  replaceSection('stages',
    sb.rows.length > 1 ? stackRow(sb.average, sb.maxMs, true) : null,
    shown.map((r) => stackRow(r, sb.maxMs)),
    h('p', { class: 'legend' }, used.map((st) => h('span', {}, h('i', { class: `st-${st}`, 'aria-hidden': 'true' }), SHORT_STAGE[st]))),
    ins ? tip(h('p', { class: 'insight' }, icon('info'), h('span', {}, `${INSIGHT_STAGE[ins.stage]} is ${Math.round(ins.pct)}% of the time`)),
      `${ins.label} takes the largest share of the time: ${Math.round(ins.pct)}% of ${formatDuration(ins.totalMs)} measured across ${ins.tasks} task${ins.tasks === 1 ? '' : 's'} and PRs.`) : null);
}

function renderCost(m) {
  const c = costSummary(m.tokensPerTask, DEFAULTS.perTaskAic);
  $('cost').classList.toggle('panel--compact', !c.rows.length);
  if (!c.rows.length) {
    replaceSection('cost', empty('No cost data yet'));
    return;
  }
  const rows = c.rows.slice(0, 10).map((r) => h('div', { class: 'crow', 'data-row-key': r.task },
    h('span', { class: 'srow-label' }, subjectButton(`task:${r.task}`, r.task,
      `Show the timeline\n${fmtInt(Math.round(r.aic))} AIC over ${r.runs} run${r.runs === 1 ? '' : 's'}\nTokens: input ${fmtInt(r.tokens_input)}, output ${fmtInt(r.tokens_output)}, cache ${fmtInt(r.tokens_cache)} (${millions(r.tokens_input + r.tokens_output)} in + out)`)),
    h('div', { class: 'track' }, withWidth(h('div', { class: `cbar${r.aic > DEFAULTS.perTaskAic ? ' cbar--over' : ''}`, role: 'img', 'aria-label': `${r.task}: ${fmtInt(Math.round(r.aic))} AIC` }), (r.aic / c.maxAic) * 100)),
    h('span', { class: 'num' }, fmtInt(Math.round(r.aic)))));
  const total = m.tokensPerTask.total;
  replaceSection('cost',
    rows,
    tip(h('p', { class: `insight${c.overBudget.length ? ' insight--warn' : ''}` }, icon(c.overBudget.length ? 'warn' : 'info'),
      h('span', {}, `Average ${fmtInt(Math.round(c.avgAic))} AIC`),
      h('span', {}, `${Math.round(c.pct)}% of budget`),
      c.overBudget.length ? h('span', {}, `${c.overBudget.length} over budget`) : null),
    [`Average ${fmtInt(Math.round(c.avgAic))} AIC per task: ${Math.round(c.pct)}% of the ${fmtInt(DEFAULTS.perTaskAic)} AIC per-task budget.`,
      `Total ${fmtInt(Math.round(total.aic))} AIC over ${total.runs} finished run${total.runs === 1 ? '' : 's'}.`,
      c.overBudget.length ? `Over budget: ${c.overBudget.join(', ')}.` : null].filter(Boolean).join('\n')));
}

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

  $('events-sum').textContent = records.length ? `· ${records.length} events` : '';
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
