// Control-room UI (v2). Fetches the audit branch from GitHub, verifies it with lib.js
// and renders the panels. All DOM writes use textContent or createElement(NS), never
// innerHTML, and widths go through the CSSOM, so the strict CSP holds.
import {
  DEFAULTS, STAGES, STAGE_LABELS, canonicalize, combineNeedsYou, costSummary, dailySeries, dayPaths, deriveMetrics, existingDayPaths, formatAge,
  formatDuration, parseJsonl, parseTime, pipeline, sparkSegments, shortSha, stageBreakdown, statusSummary, subjectLabel,
  reviewItems, summarizePr, timelineFor, typicalRunMs, unmergedPrs, utcDay, verifyChain,
} from './lib.js';

const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
const BRANCH = 'audit';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const GH = 'https://github.com';
const TOKEN_KEY = 'factory-dashboard.github-token';
const THEME_KEY = 'factory-dashboard.theme';
const FIXTURE_URL = 'test/fixtures/sample.jsonl'; // relative, so it works locally and on Pages
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

const params = new URLSearchParams(location.search);
const FIXTURE = params.get('fixture') === '1';
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
  nextCheckAt: null,
  clockOffset: 0,
  expanded: new Set(),
  subject: '',
  typeFilter: '',
  timer: null,
  busy: false,
  dataVersion: 0,
  renderedVersion: -1,
  prs: { fetchedAt: null, lastOk: false, error: null, lists: new Map() }, // repo -> { etag, prs }
  prsKnownRendered: null,
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
function issueLink(n) {
  return isNum(n) ? link(`${GH}/${REPO}/issues/${n}`, `#${n}`) : null;
}
function commitLink(sha) {
  return isSha(sha) ? link(`${GH}/${REPO}/commit/${sha}`, h('code', {}, sha.slice(0, 7))) : '—';
}
function runLink(id, attempt) {
  if (!isNum(id)) return '—';
  const href = `${GH}/${REPO}/actions/runs/${id}` + (isNum(attempt) ? `/attempts/${attempt}` : '');
  return link(href, isNum(attempt) && attempt > 1 ? `${id} (#${attempt})` : String(id));
}

function timeEl(ts) {
  const ms = parseTime(ts);
  if (ms == null) return '—';
  const iso = new Date(ms).toISOString();
  const sameDay = utcDay(ms) === utcDay(now());
  const text = sameDay ? iso.slice(11, 19) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  return h('time', { datetime: iso, title: iso }, text);
}

function subjectButton(key, label) {
  return h('button', {
    type: 'button',
    class: 'linklike',
    title: 'Show the timeline',
    onclick: () => {
      state.subject = key;
      $('timeline-fold').open = true;
      safe('timeline', () => renderTimeline(deriveMetrics(state.events, { now: now() })));
      $('timeline-fold').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('subject').focus({ preventScroll: true });
    },
  }, label);
}

function taskCell(task, issue) {
  if (!task) return issue != null ? issueLink(issue) : '—';
  return h('span', {}, subjectButton(`task:${task}`, task), issue != null ? [' ', issueLink(issue)] : null);
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
function clockCell(sinceMs) {
  if (sinceMs == null) return '—';
  return h('span', { 'data-since': String(sinceMs) }, formatDuration(now() - sinceMs));
}

function updateClockCells() {
  for (const el of document.querySelectorAll('[data-since]')) {
    const text = formatDuration(now() - Number(el.getAttribute('data-since')));
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

async function tick() {
  clearTimeout(state.timer);
  if (state.busy) return;
  state.busy = true;
  let delayS = POLL_S;
  try {
    if (FIXTURE) {
      if (!state.loaded) await loadFixture();
    } else if (document.visibilityState === 'hidden' && state.loaded) {
      delayS = POLL_S; // don't spend requests on a hidden tab
    } else {
      const headBefore = state.headSha;
      try {
        delayS = await pollGitHub();
      } finally {
        await maybeRefreshPrs(state.headSha !== headBefore);
      }
    }
    state.error = null;
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

const pctText = (v) => (v == null ? 'n/a' : `${Math.round(v)}%`);
const millions = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** A 7-day trend line. Null values leave a gap rather than a fake zero. */
function sparkline(values, days, { label, tone = 'blue', format = (v) => String(v) } = {}) {
  const w = 200;
  const ht = 36;
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
  try {
    renderHeader(m);
  } catch (err) {
    setStatus(`Problem showing the header: ${err?.message ?? err}`, 'alert');
  }
  safe('kpis', withMetrics(renderKpis)); // KPI tiles hold no focusable elements
  const known = FIXTURE || prsKnown();
  if (full || state.renderedVersion !== state.dataVersion || state.prsKnownRendered !== known) {
    state.renderedVersion = state.dataVersion;
    state.prsKnownRendered = known;
    safe('needs', withMetrics(renderNeeds));
    safe('pipeline', renderPipeline);
    safe('agents', withMetrics(renderAgents));
    safe('checks', withMetrics(renderChecks));
    safe('stages', withMetrics(renderStages));
    safe('cost', withMetrics(renderCost));
    safe('timeline', withMetrics(renderTimeline));
    safe('events', renderEvents);
  }
  updateClockCells();
}

function setStatus(text, level = 'warn') {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text; // only real changes are announced
  el.className = `chip status status--${level}`;
}

function setChip(id, { hidden = false, tone = null, iconName = null, text = '', title = null }) {
  const el = $(id);
  el.hidden = hidden;
  if (hidden) return;
  el.className = `chip${tone ? ` chip--${tone}` : ''}`;
  el.replaceChildren(...(iconName ? [icon(iconName)] : []), text);
  if (title) el.title = title;
  else el.removeAttribute('title');
}

function renderHeader(m) {
  const chain = state.chain;
  if (!chain || chain.status === 'empty') {
    setChip('chain-badge', { iconName: 'shield', text: state.loaded ? 'Chain: no events' : 'Chain: not loaded' });
  } else if (chain.status === 'verified') {
    setChip('chain-badge', {
      tone: 'ok', iconName: 'shield',
      text: `Chain verified · ${chain.total} event${chain.total === 1 ? '' : 's'}`,
      title: chain.windowStart === 'genesis' ? 'Every hash and parent link checks out, back to the first event of the log.' : 'Every hash and parent link in the loaded window checks out.',
    });
  } else {
    setChip('chain-badge', { tone: 'alert', iconName: 'warn', text: `Chain broken at event ${chain.brokenAt}`, title: `${chain.brokenSource}: ${chain.brokenReason}` });
  }

  const enabled = m?.killSwitch?.enabled ?? null;
  setChip('kill-chip', {
    hidden: enabled == null, tone: enabled ? 'ok' : 'alert', iconName: 'power',
    text: enabled ? 'Factory on' : 'Factory off', title: 'factory_enabled from the latest heartbeat; off means no new dispatches',
  });
  const dryRun = m?.dryRun ?? null;
  setChip('dry-badge', {
    hidden: dryRun == null, tone: dryRun ? 'warn' : 'ok', iconName: dryRun ? 'info' : 'bolt',
    text: dryRun ? 'Dry run' : 'Live mode', title: dryRun ? 'Decisions are logged, not acted on' : 'Decisions take effect',
  });
  const version = m?.factoryVersion ?? null;
  setChip('version-chip', { hidden: !version, iconName: 'branch', text: `factory ${shortSha(version)}`, title: `Factory version ${version}` });
  setChip('mode-badge', { hidden: !FIXTURE, tone: 'info', iconName: 'info', text: `Sample data · clock ${new Date(now()).toISOString().slice(11, 16)}Z` });

  const summary = statusSummary({
    loaded: state.loaded,
    noLog: state.noLog,
    error: state.error,
    fixture: FIXTURE,
    eventCount: state.events.length,
    headSha: state.headSha,
    days: DAYS,
    heartbeat: m?.heartbeat ?? null,
  });
  setStatus(summary.text, summary.level);

  const meta = [];
  if (FIXTURE) meta.push(`sample data from ${FIXTURE_URL}`);
  else {
    if (state.lastCheck) meta.push(`checked ${new Date(state.lastCheck).toISOString().slice(11, 19)}Z`);
    if (state.nextCheckAt) meta.push(`next in ${Math.max(0, Math.round((state.nextCheckAt - Date.now()) / 1000))} s`);
    const r = state.rate;
    if (r) meta.push(`API ${r.remaining}/${r.limit} left` + (r.reset ? `, resets ${new Date(r.reset).toISOString().slice(11, 16)}Z` : ''));
    meta.push(getToken() ? 'your token' : 'no token');
  }
  $('meta').textContent = meta.join(' · ');
  $('meta-settings').textContent = meta.length ? `Now: ${meta.join(' · ')}.` : '';
  $('poll-hint').textContent = `Checks every ${POLL_S} s at most (?poll=N), spread out to stay within the rate limit: about once a minute without a token. Window: ${DAYS} days (?days=N).`;
  $('window-days').textContent = String(DAYS);
  $('kpi-days').textContent = String(DAYS);
}

function kpi({ title, iconName, value, unit = null, detail, level = null, levelText = null, extra = null, spark }) {
  return h('article', { class: `panel kpi${level ? ` kpi--${level}` : ''}` },
    h('h3', { class: 'kpi-t' }, icon(iconName), title),
    h('p', { class: 'kpi-v' }, value, unit ? h('small', {}, ` ${unit}`) : null, levelText ? h('span', { class: 'kpi-level' }, levelText) : null),
    h('p', { class: 'kpi-d' }, detail),
    extra,
    spark);
}

function renderKpis(m) {
  const s = dailySeries(state.events, { now: now(), days: DAYS });
  const zt = m.zeroTouch;
  const hb = m.heartbeat;
  const aic = m.aicToday;
  const meter = withWidth(h('i'), aic.pct ?? 0);
  const mergedWeek = s.merged.reduce((a, b) => a + b, 0);
  const hbLevel = hb.level === 'alert' ? 'alert' : hb.level === 'ok' ? null : 'warn';
  replaceSection('kpis',
    kpi({
      title: 'Zero-touch rate', iconName: 'ok', value: zt.rate == null ? 'n/a' : pctText(zt.rate * 100),
      detail: zt.merged ? `${zt.untouched} of ${zt.merged} merged factory PRs had no human action` : 'no merged factory PRs yet',
      spark: sparkline(s.zeroTouchPct, s.days, { label: 'Zero-touch rate so far', tone: 'green', format: pctText }),
    }),
    kpi({
      title: 'Checks passed', iconName: 'shield', value: pctText(s.checks.pct),
      detail: s.checks.total ? `${s.checks.passed} of ${s.checks.total} check runs passed` : 'no check results yet',
      spark: sparkline(s.checksPassPct, s.days, { label: 'Share of check runs that passed, by day', tone: 'green', format: pctText }),
    }),
    kpi({
      title: 'AIC today (UTC)', iconName: 'coin', value: fmtInt(Math.round(aic.total)), unit: `/ ${fmtInt(aic.budget)}`,
      detail: `${(aic.pct ?? 0).toFixed(1)}% of the daily budget${m.tokensPerTask.total.runs ? '' : ' · no run_finished events yet'}`,
      level: aic.level === 'ok' ? null : aic.level, levelText: aic.level === 'alert' ? 'budget reached' : aic.level === 'warn' ? '≥ 80%' : null,
      extra: h('div', { class: 'meter', role: 'meter', 'aria-label': 'AIC today vs. daily budget', 'aria-valuemin': '0', 'aria-valuemax': String(aic.budget), 'aria-valuenow': String(Math.round(aic.total)) }, meter),
      spark: sparkline(s.aic, s.days, { label: 'AIC per day', tone: 'purple', format: (v) => fmtInt(Math.round(v)) }),
    }),
    kpi({
      title: 'Merged today (UTC)', iconName: 'branch', value: String(m.mergedToday.count),
      detail: `${m.mergedToday.count ? `PR ${m.mergedToday.prs.slice(0, 5).map((n) => `#${n}`).join(', ')}${m.mergedToday.prs.length > 5 ? ` +${m.mergedToday.prs.length - 5} more` : ''} · ` : ''}${mergedWeek} in ${DAYS} days`,
      spark: sparkline(s.merged, s.days, { label: 'PRs merged per day' }),
    }),
    kpi({
      title: 'Median time to merge', iconName: 'clock', value: s.mergeMedianAllMin == null ? 'n/a' : formatDuration(s.mergeMedianAllMin * 60000),
      detail: 'from PR opened to merged',
      spark: sparkline(s.mergeMedianMin, s.days, { label: 'Median time to merge, by day', format: (v) => formatDuration(v * 60000) }),
    }),
    kpi({
      title: 'Heartbeat', iconName: 'pulse', value: hb.ageMin == null ? 'none' : formatAge(hb.ageMin), unit: hb.ageMin == null ? null : 'ago',
      detail: `amber after ${DEFAULTS.heartbeatWarnMin} min, red after ${DEFAULTS.heartbeatAlertMin} min`,
      level: hbLevel, levelText: hb.level === 'alert' ? 'stale' : hb.level === 'warn' ? 'late' : hb.level === 'none' ? 'missing' : null,
      spark: sparkline(s.heartbeats, s.days, { label: 'Heartbeats per day (24 expected)', tone: 'green' }),
    }),
  );
}

function needsSubject(it) {
  if (it.task) return subjectButton(`task:${it.task}`, it.task);
  if (it.pr != null) return subjectButton(`pr:${it.pr}`, `PR #${it.pr}`);
  return it.issue != null ? `issue #${it.issue}` : '—';
}

function reviewState() {
  if (FIXTURE) return 'sample';
  if (prsKnown()) return 'ok';
  return state.prs.fetchedAt == null && !state.prs.error ? 'pending' : 'unavailable';
}

function reviewItem(it) {
  const repoShort = it.repo.split('/')[1];
  const action = link(it.url, 'Open PR →');
  action.classList.add('btn', 'btn--small');
  return h('li', { 'data-row-key': it.key },
    icon('person', 'needs-icon'),
    h('div', { class: 'needs-main' },
      h('p', { class: 'needs-title' }, h('b', {}, 'Review and merge'), ' · ', link(it.url, `${repoShort}#${it.number}`)),
      h('p', { class: 'why' }, it.title || '(no title)')),
    h('div', { class: 'needs-side' },
      it.since ? h('p', { class: 'age' }, 'waiting ', clockCell(parseTime(it.since))) : null,
      action));
}

function renderNeeds(m) {
  const cap = DEFAULTS.humanQueueMax;
  const rs = reviewState();
  const reviews = rs === 'ok' ? reviewItems(PR_REPOS.map((repo) => ({ repo, prs: state.prs.lists.get(repo)?.prs ?? [] })), now()) : [];
  const items = combineNeedsYou(m.needsYou.items, reviews, REPO);
  const reviewNote = rs === 'unavailable'
    ? h('p', { class: 'problem' }, icon('warn'), ` Review list unavailable (${state.prs.error ?? 'the PR lists are out of date'}), so PRs waiting for your review aren't shown.`)
    : rs === 'pending' ? h('p', { class: 'hint' }, 'Checking GitHub for PRs waiting for your review…')
      : rs === 'sample' ? h('p', { class: 'hint' }, 'Sample data: PRs waiting for your review are read live from GitHub, so none are shown here.')
        : null;
  const clear = !items.length && (rs === 'ok' || rs === 'sample');
  $('needs').classList.toggle('needs--clear', clear);
  if (!items.length) {
    replaceSection('needs',
      clear ? h('p', { class: 'needs-clear' }, icon('ok'), 'Nothing needs you right now.') : h('p', { class: 'needs-unknown' }, icon('question'), 'No audit items need you, but the review list is incomplete.'),
      reviewNote,
      h('p', { class: 'hint' }, `Needs-human items, stale contracts and human-tier PRs waiting for review show up here, oldest first. Above ${cap}, the controller stops admitting new human-tier work.`));
    return;
  }
  const list = h('ul', { class: 'needs-list' }, items.map((it) => {
    if (it.kind === 'review') return reviewItem(it);
    const action = it.issue != null ? link(`${GH}/${REPO}/issues/${it.issue}`, `Open issue #${it.issue} →`)
      : it.pr != null ? link(`${GH}/${REPO}/pull/${it.pr}`, `Open PR #${it.pr} →`) : null;
    action?.classList.add('btn', 'btn--small');
    const why = [];
    if (it.reason) why.push(h('code', {}, it.reason));
    if (it.effect) why.push(`effect: ${it.effect}`);
    if (it.since) why.push(h('span', {}, 'since ', timeEl(it.since)));
    return h('li', { 'data-row-key': it.key },
      icon('warn', 'needs-icon'),
      h('div', { class: 'needs-main' },
        h('p', { class: 'needs-title' }, h('b', {}, it.kind === 'needs_human' ? 'Needs human' : 'Stale contract'), ' · ', needsSubject(it)),
        h('p', { class: 'why' }, why.flatMap((x, i) => (i ? [' · ', x] : [x])))),
      h('div', { class: 'needs-side' },
        it.since ? h('p', { class: 'age' }, 'waiting ', clockCell(parseTime(it.since))) : null,
        action));
  }));
  replaceSection('needs',
    h('div', { class: 'needs-head' },
      h('span', { class: 'big' }, String(items.length)),
      h('span', { class: 'lbl' }, items.length === 1 ? 'item is waiting for you' : 'items are waiting for you'),
      h('span', { class: 'cap' }, `review queue cap ${cap}`)),
    items.length > cap ? h('p', { class: 'problem' }, 'Over the cap: the controller stops admitting new human-tier work until you catch up.') : null,
    reviewNote,
    list,
    rs === 'ok' ? h('p', { class: 'hint' }, 'Review items come from the open, non-draft PRs of both repos whose body says "Tier: human" or "Tier: owner", or that carry an owner-review label.') : null);
}

function laneCard(c) {
  const n1 = [subjectButton(c.key, c.label)];
  if (c.issue != null) n1.push(' ', issueLink(c.issue));
  if (c.kind === 'task') c.prs.forEach((pr) => n1.push(' ', link(`${GH}/${REPO}/pull/${pr}`, `PR #${pr}`)));
  else if (c.prs[0] != null) {
    const a = link(`${GH}/${REPO}/pull/${c.prs[0]}`, '↗');
    a.setAttribute('aria-label', `PR #${c.prs[0]} on GitHub`);
    n1.push(' ', a);
  }
  const n2 = [];
  if (c.attempt != null) n2.push(h('span', {}, `a${c.attempt}`));
  if (c.model) n2.push(h('span', {}, c.model));
  if (c.enteredAt != null) n2.push(h('span', { title: 'time in this stage' }, clockCell(c.enteredAt)));
  return h('div', { class: 'task', 'data-row-key': c.key },
    h('p', { class: 'n1' }, n1),
    n2.length ? h('p', { class: 'n2' }, n2) : null,
    c.tags.length ? h('p', { class: 'tags' }, c.tags.map((t) => h('span', { class: `tag tag--${t.tone}`, title: t.title }, t.text))) : null);
}

function renderPipeline() {
  const pl = pipeline(state.events, { openPrs: openPrSet() });
  $('pipe-count').textContent = `${pl.total} item${pl.total === 1 ? '' : 's'}`;
  const closedEl = $('pipe-closed');
  closedEl.hidden = !pl.closed.length;
  closedEl.textContent = `Closed ${pl.closed.length}`;
  closedEl.title = `Closed without merging: ${pl.closed.map((c) => c.label).join(', ')}`;
  $('pipe-foot').textContent = `One card per task, or per PR without a task, in the lane of its latest stage; the time shown is how long it has been there. WIP limit ${DEFAULTS.wipLimit} · review queue cap ${DEFAULTS.humanQueueMax}.`;
  if (!pl.total) {
    replaceSection('pipeline', empty(state.noLog ? 'No audit log yet, so the pipeline is empty.' : 'No tasks or PRs in the window yet.'));
    return;
  }
  const lanes = pl.lanes.map((l) => h('div', { class: `lane st-${l.key}`, role: 'group', 'aria-label': `${l.label}: ${l.cards.length}` },
    h('h3', { class: 'lane-h' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), l.label, h('span', { class: 'n' }, String(l.cards.length))),
    l.prStateUnknown ? h('p', { class: 'lane-note', title: "The open-PR list couldn't be read, so these PRs may have been closed." }, icon('question'), 'PR state unknown') : null,
    l.cards.length ? h('div', { class: 'lane-cards' }, l.cards.map((c) => {
      try {
        return laneCard(c);
      } catch (err) {
        return h('p', { class: 'problem' }, `Couldn't show this card: ${err?.message ?? err}`);
      }
    })) : h('p', { class: 'lane-empty' }, 'none')));
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
  $('agents-count').textContent = r.available ? `${r.count} of ${r.wipLimit}` : 'status unavailable';
  const slotCount = Math.max(r.wipLimit, r.available ? r.count : 0);
  const slots = h('div', { class: 'slots' },
    h('span', {}, r.available ? `WIP ${r.count}/${r.wipLimit}` : `WIP ?/${r.wipLimit}`),
    Array.from({ length: slotCount }, (_, i) => h('span', {
      class: `slot${!r.available ? ' slot--unknown' : i >= r.wipLimit ? ' slot--over' : i < r.count ? ' slot--on' : ''}`,
      'aria-hidden': 'true',
    })),
    r.dryRunPlanned ? h('span', { class: 'muted' }, `· ${r.dryRunPlanned} dry-run dispatch${r.dryRunPlanned === 1 ? '' : 'es'} planned, not running`) : null);

  if (!r.rows.length) {
    replaceSection('agents', h('div', { class: 'agents' }, empty(r.available ? 'No agents running.' : 'No runs yet.')), slots);
    return;
  }
  const cards = r.rows.map((a) => {
    const repair = a.workflow === 'repair';
    const bar = typical && a.startedAt != null
      ? h('div', { class: 'bar', title: 'elapsed vs. twice the typical run' }, h('i', { 'data-bar-since': String(a.startedAt), 'data-bar-span': String(typical * 2) }))
      : null;
    const meta = [a.state, a.model].filter(Boolean).join(' · ');
    return h('div', { class: 'agent', 'data-row-key': a.key },
      r.available
        ? h('span', { class: `spin${repair ? ' spin--repair' : ''}`, role: 'img', 'aria-label': repair ? 'repairing' : 'running' })
        : h('span', { class: 'agent-unknown', role: 'img', 'aria-label': 'status unknown' }, icon('question')),
      h('div', { class: 'agent-main' },
        h('p', { class: 'n1' }, taskCell(a.task, a.issue), ' ', h('span', { class: `tag${repair ? ' tag--warn' : ''}` }, `${a.workflow}${a.attempt != null ? ` a${a.attempt}` : ''}`)),
        h('p', { class: 'n2' }, meta, a.runId != null ? [meta ? ' · run ' : 'run ', runLink(a.runId)] : null),
        bar),
      h('div', { class: 'el' }, clockCell(a.startedAt), typical ? h('small', {}, `typical ${formatDuration(typical)}`) : null));
  });
  replaceSection('agents',
    h('div', { class: 'agents' }, cards),
    r.available ? null : h('p', { class: 'hint pad' }, "Run completion isn't logged yet (no run_finished events), so these are dispatched attempts that haven't been superseded, merged, escalated or cancelled. Some may already have finished."),
    slots);
  for (const el of $('agents').querySelectorAll('[data-bar-since]')) setBar(el);
}

function renderChecks(m) {
  const passed = m.checks.filter((ev) => ev.payload?.conclusion === 'success').length;
  $('checks-count').textContent = m.checks.length ? `${passed} of ${m.checks.length} passed` : '';
  const checks = m.checks.slice(0, 8);
  if (!checks.length) {
    replaceSection('checks', empty('No check results yet.'));
    return;
  }
  const items = checks.map((ev, i) => {
    const key = typeof ev.id === 'string' ? ev.id : `#${i}`;
    try {
      const p = ev.payload;
      const tone = p.conclusion === 'success' ? 'ok' : p.conclusion === 'failure' ? 'fail' : 'other';
      const prs = Array.isArray(p.prs) ? p.prs.filter(isNum) : [];
      const seed = typeof p.heldout_seed === 'string' ? p.heldout_seed : null;
      return h('li', { class: `chk chk--${tone}`, 'data-row-key': key },
        h('span', { class: 'chk-icon' }, icon(tone === 'ok' ? 'ok' : tone === 'fail' ? 'fail' : 'dot')),
        h('span', { class: 'mono muted' }, timeEl(p.completed_at ?? ev.timestamp)),
        h('div', { class: 'chk-main' },
          h('p', {}, h('b', {}, String(p.workflow ?? 'check')),
            prs.length ? [' on ', prs.flatMap((n, j) => [j ? ', ' : '', link(`${GH}/${REPO}/pull/${n}`, `PR #${n}`)])]
              : typeof p.event === 'string' ? h('span', { class: 'muted' }, ` on ${p.event}`) : null),
          typeof p.failure_signature === 'string' ? h('p', { class: 'sig' }, 'signature ', h('code', {}, p.failure_signature)) : null,
          seed ? h('p', { class: 'seed muted' }, 'held-out seed ', h('code', { title: seed }, seed.length > 10 ? `${seed.slice(0, 8)}…` : seed)) : null),
        h('span', { class: 'chk-run' }, isNum(p.run_id) ? ['run ', runLink(p.run_id, p.run_attempt)] : null),
        h('span', { class: 'chk-concl' }, String(p.conclusion ?? 'unknown')));
    } catch (err) {
      return h('li', { class: 'chk problem', 'data-row-key': key }, `Couldn't show this check: ${err?.message ?? err}`);
    }
  });
  replaceSection('checks', h('ul', { class: 'checks' }, items));
}

function stackRow(r, maxMs, isAverage = false) {
  const desc = r.segments.map((sg) => `${STAGE_LABELS[sg.stage]} ${formatDuration(sg.ms)}`).join(', ');
  const stack = withWidth(h('div', { class: 'stack', role: 'img', 'aria-label': `${r.label}: ${desc}; total ${formatDuration(r.totalMs)}` },
    r.segments.map((sg) => withWidth(h('i', { class: `seg st-${sg.stage}`, title: `${STAGE_LABELS[sg.stage]}: ${formatDuration(sg.ms)}` }), (sg.ms / r.totalMs) * 100))),
  (r.totalMs / maxMs) * 100);
  return h('div', { class: `srow${isAverage ? ' srow--avg' : ''}`, 'data-row-key': r.key },
    h('span', { class: 'srow-label' }, isAverage ? h('b', {}, `Average (${DAYS} days)`) : subjectButton(r.key, r.label)),
    h('div', { class: 'track' }, stack),
    h('span', { class: 'mono muted num' }, formatDuration(r.totalMs)));
}

function renderStages(m) {
  const sb = stageBreakdown(m.stageTimes);
  if (!sb.rows.length) {
    replaceSection('stages', empty('No task or PR has moved through two stages yet.'));
    return;
  }
  const shown = sb.rows.slice(-10);
  const used = STAGES.filter((st) => sb.rows.some((r) => r.segments.some((sg) => sg.stage === st)));
  const ins = sb.insight;
  replaceSection('stages',
    sb.rows.length > 1 ? stackRow(sb.average, sb.maxMs, true) : null,
    shown.map((r) => stackRow(r, sb.maxMs)),
    sb.rows.length > shown.length ? h('p', { class: 'hint' }, `Showing the latest ${shown.length} of ${sb.rows.length}.`) : null,
    h('p', { class: 'legend' }, used.map((st) => h('span', {}, h('i', { class: `st-${st}`, 'aria-hidden': 'true' }), STAGE_LABELS[st]))),
    ins ? h('p', { class: 'insight' }, icon('info'), h('span', {},
      h('b', {}, ins.label), ` takes the largest share of the time: ${Math.round(ins.pct)}% of ${formatDuration(ins.totalMs)} measured across ${ins.tasks} task${ins.tasks === 1 ? '' : 's'} and PRs.`)) : null);
}

function renderCost(m) {
  const c = costSummary(m.tokensPerTask, DEFAULTS.perTaskAic);
  if (!c.rows.length) {
    replaceSection('cost', empty('No run_finished events yet, so there is no cost data.'));
    return;
  }
  const rows = c.rows.slice(0, 10).map((r) => {
    const tokens = r.tokens_input + r.tokens_output;
    return h('div', { class: 'crow', 'data-row-key': r.task },
      h('span', { class: 'srow-label' }, subjectButton(`task:${r.task}`, r.task)),
      h('div', { class: 'track' }, withWidth(h('div', { class: `cbar${r.aic > DEFAULTS.perTaskAic ? ' cbar--over' : ''}`, role: 'img', 'aria-label': `${r.task}: ${fmtInt(Math.round(r.aic))} AIC` }), (r.aic / c.maxAic) * 100)),
      h('span', { class: 'num' }, `${fmtInt(Math.round(r.aic))} AIC`,
        h('small', { class: 'muted', title: `input ${fmtInt(r.tokens_input)}, output ${fmtInt(r.tokens_output)}, cache ${fmtInt(r.tokens_cache)}` }, ` · ${millions(tokens)} tokens`)));
  });
  const total = m.tokensPerTask.total;
  replaceSection('cost',
    rows,
    h('p', { class: 'hint' }, `Total ${fmtInt(Math.round(total.aic))} AIC over ${total.runs} finished run${total.runs === 1 ? '' : 's'}.`),
    h('p', { class: `insight${c.overBudget.length ? ' insight--warn' : ''}` }, icon('info'), h('span', {},
      'Average ', h('b', {}, `${fmtInt(Math.round(c.avgAic))} AIC per task`),
      `: ${Math.round(c.pct)}% of the ${fmtInt(DEFAULTS.perTaskAic)} AIC per-task budget.`,
      c.overBudget.length ? ` Over budget: ${c.overBudget.join(', ')}.` : '')));
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

  $('events-sum').textContent = records.length ? `· ${records.length} events, newest first` : '';
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
  $('theme-label').textContent = next === 'dark' ? 'Dark theme' : 'Light theme';
  $('theme').setAttribute('aria-label', `Switch to the ${next} theme`);
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
