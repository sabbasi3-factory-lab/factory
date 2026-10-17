// Control-room UI. Fetches the audit branch from GitHub, verifies it with lib.js
// and renders tiles and tables. All DOM writes use textContent, never innerHTML.
import {
  DEFAULTS, STAGES, canonicalize, dayPaths, deriveMetrics, formatDuration, parseJsonl,
  parseTime, statusSummary, subjectLabel, timelineFor, utcDay, verifyChain,
} from './lib.js';

const REPO = 'sabbasi3-factory-lab/chrono-node-rs';
const BRANCH = 'audit';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const GH = 'https://github.com';
const TOKEN_KEY = 'factory-dashboard.github-token';
const FIXTURE_URL = 'test/fixtures/sample.jsonl'; // relative, so it works locally and on Pages
const MISSING_BRANCH_POLL_S = 300;

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
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
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
      render({ full: true });
      $('timeline-h').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
// with the same key in the same section (or on its table if that row is gone).
function replaceSection(id, ...nodes) {
  const el = $(id);
  const active = document.activeElement;
  const key = active && active !== document.body && el.contains(active) ? active.getAttribute('data-focus-key') : null;
  el.replaceChildren(...nodes.filter((n) => n != null));
  assignFocusKeys(el);
  if (key) (el.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) ?? el.querySelector('.table-wrap'))?.focus({ preventScroll: true });
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

async function fetchDayFiles(sha) {
  const paths = dayPaths(now(), DAYS);
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
      delayS = await pollGitHub();
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
  safe('tiles', withMetrics(renderTiles)); // tiles hold no focusable elements
  if (full || state.renderedVersion !== state.dataVersion) {
    state.renderedVersion = state.dataVersion;
    safe('needs', withMetrics(renderNeeds));
    safe('running', withMetrics(renderRunning));
    safe('tokens', withMetrics(renderTokens));
    safe('stages', withMetrics(renderStages));
    safe('checks', withMetrics(renderChecks));
    safe('timeline', withMetrics(renderTimeline));
    safe('events', renderEvents);
  } else {
    updateClockCells();
  }
}

function setStatus(text, level = 'warn') {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text; // only real changes are announced
  el.className = `status status--${level}`;
}

function renderHeader(m) {
  const chain = state.chain;
  const badge = $('chain-badge');
  if (!chain || chain.status === 'empty') {
    badge.className = 'badge';
    badge.textContent = state.loaded ? 'Chain: no events' : 'Chain: not loaded';
  } else if (chain.status === 'verified') {
    badge.className = 'badge badge--ok';
    badge.textContent = `✓ Chain verified · ${chain.total} event${chain.total === 1 ? '' : 's'}` + (chain.windowStart === 'genesis' ? ' from genesis' : '');
  } else {
    badge.className = 'badge badge--alert';
    badge.textContent = `✗ Chain broken at event ${chain.brokenAt} (${chain.brokenSource}): ${chain.brokenReason}`;
  }

  const dryRun = m?.dryRun ?? null;
  const dry = $('dry-badge');
  dry.hidden = dryRun == null;
  dry.className = dryRun ? 'badge badge--warn' : 'badge';
  dry.textContent = dryRun ? 'Dry run: decisions are logged, not acted on' : 'Live mode (not dry run)';

  const mode = $('mode-badge');
  mode.hidden = !FIXTURE;
  mode.textContent = `Fixture mode · sample data · clock pinned at ${new Date(now()).toISOString().slice(0, 16)}Z`;

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
  if (!FIXTURE) {
    if (state.lastCheck) meta.push(`Last checked ${new Date(state.lastCheck).toISOString().slice(11, 19)}Z`);
    if (state.nextCheckAt) meta.push(`next in ${Math.max(0, Math.round((state.nextCheckAt - Date.now()) / 1000))} s`);
    const r = state.rate;
    if (r) meta.push(`GitHub API: ${r.remaining} of ${r.limit} requests left` + (r.reset ? `, resets ${new Date(r.reset).toISOString().slice(11, 16)}Z` : ''));
    meta.push(getToken() ? 'using your token' : 'no token');
  }
  $('meta').textContent = meta.join(' · ');
  $('poll-hint').textContent = `Checks every ${POLL_S} s at most (?poll=N), spread out to stay within the rate limit: about once a minute without a token. Window: ${DAYS} days (?days=N).`;
  $('window-days').textContent = String(DAYS);
}

function tile(label, value, note, level = null, levelText = null) {
  return h('article', { class: `tile${level ? ` tile--${level}` : ''}` },
    h('h3', {}, label),
    h('p', { class: 'value' }, value, levelText ? h('span', { class: 'level' }, levelText) : null),
    note ? h('p', { class: 'note' }, note) : null);
}

function runningTile(r) {
  const planned = r.dryRunPlanned ? `; ${r.dryRunPlanned} dry-run dispatch${r.dryRunPlanned === 1 ? '' : 'es'} planned, not running` : '';
  if (!r.available) {
    const open = r.rows.length ? `; ${r.rows.length} dispatched attempt${r.rows.length === 1 ? '' : 's'} not yet retired` : '';
    return tile('Agents running', 'unavailable', `run completion isn't logged yet (no run_finished events)${open}${planned}`);
  }
  const over = r.count > r.wipLimit;
  return tile('Agents running', `${r.count} / ${r.wipLimit}`, `WIP limit ${r.wipLimit}${planned}`, over ? 'alert' : null, over ? 'over limit' : null);
}

function renderTiles(m) {
  const hb = m.heartbeat;
  const r = m.running;
  const tiles = [
    runningTile(r),
    tile('Merge queue', String(m.queue.count), m.queue.count ? `PR ${m.queue.items.map((q) => `#${q.pr}`).join(', ')}` : 'empty'),
    tile('Merged today (UTC)', String(m.mergedToday.count), m.mergedToday.count ? `PR ${m.mergedToday.prs.map((n) => `#${n}`).join(', ')}` : 'nothing yet today'),
    tile(`Zero-touch rate (${DAYS} d)`, m.zeroTouch.rate == null ? 'n/a' : `${Math.round(m.zeroTouch.rate * 100)}%`,
      m.zeroTouch.merged ? `${m.zeroTouch.untouched} of ${m.zeroTouch.merged} merged factory PRs had no human action` : 'no merged factory PRs yet'),
    tile('AIC today (UTC)', `${fmtInt(Math.round(m.aicToday.total))} / ${fmtInt(m.aicToday.budget)}`,
      `${(m.aicToday.pct ?? 0).toFixed(1)}% of the daily budget` + (m.tokensPerTask.total.runs ? '' : ' · no run_finished events yet'),
      m.aicToday.level === 'ok' ? null : m.aicToday.level, m.aicToday.level === 'alert' ? 'budget reached' : m.aicToday.level === 'warn' ? '≥ 80%' : null),
    tile('Needs you', String(m.needsYou.count), 'open needs-human and stale contracts (human-tier PRs aren\'t in v1 events)',
      m.needsYou.count ? 'warn' : null, m.needsYou.count ? 'action' : null),
    tile('Kill switch', m.killSwitch.enabled == null ? 'unknown' : m.killSwitch.enabled ? 'Factory on' : 'Factory off',
      m.killSwitch.enabled == null ? 'no heartbeat yet' : `factory_enabled = ${m.killSwitch.enabled}, from the last heartbeat`,
      m.killSwitch.enabled === false ? 'alert' : null, m.killSwitch.enabled === false ? 'no new dispatches' : null),
    tile('Factory version', m.factoryVersion ? h('code', {}, m.factoryVersion) : '—', m.factoryVersion ? 'from the latest event' : 'no events yet'),
    tile('Heartbeat age', hb.ageMin == null ? 'none' : `${Math.floor(hb.ageMin)} min`,
      typeof hb.at === 'string' ? `last at ${hb.at.slice(0, 16).replace('T', ' ')}Z · amber after ${DEFAULTS.heartbeatWarnMin} min, red after ${DEFAULTS.heartbeatAlertMin} min` : 'no heartbeat in the window',
      hb.level === 'alert' ? 'alert' : hb.level === 'warn' || hb.level === 'none' ? 'warn' : 'ok',
      hb.level === 'alert' ? 'controller may be down' : hb.level === 'warn' ? 'late' : hb.level === 'none' ? 'missing' : 'ok'),
    tile('Dry run', m.dryRun == null ? 'unknown' : m.dryRun ? 'Yes' : 'No',
      m.dryRun ? 'the controller plans and logs, but does not act' : m.dryRun === false ? 'decisions take effect' : 'no events yet',
      m.dryRun ? 'info' : null),
  ];
  replaceSection('tiles', ...tiles);
}

function renderNeeds(m) {
  const items = m.needsYou.items;
  if (!items.length) {
    replaceSection('needs', empty('Nothing needs you right now.'));
    return;
  }
  const rows = items.map((it) => row(it.key,
    it.kind === 'needs_human' ? 'needs-human' : 'stale contract',
    it.task ? taskCell(it.task, it.issue) : it.pr != null ? subjectButton(`pr:${it.pr}`, `PR #${it.pr}`) : issueLink(it.issue),
    it.pr != null ? prLink(it.pr) : '—',
    it.reason ? h('code', {}, it.reason) : '—',
    it.effect ?? '—',
    timeEl(it.since),
    clockCell(parseTime(it.since)),
  ));
  replaceSection('needs', table('Needs you', ['Kind', 'Task', 'PR', 'Reason', 'Effect', 'Since', 'Waiting'], rows, { numeric: [6] }));
}

function renderRunning(m) {
  const rows = m.running.rows;
  if (!rows.length) {
    replaceSection('running', empty(m.running.available ? 'No agents running.' : 'No runs yet.'));
    return;
  }
  const trs = rows.map((r) => row(r.key,
    taskCell(r.task, r.issue),
    r.attempt != null ? `a${r.attempt}` : '—',
    r.workflow,
    r.state,
    r.model ? h('code', {}, r.model) : '—',
    clockCell(r.startedAt),
    r.tokens == null ? '—' : fmtInt(r.tokens),
    r.aic == null ? '—' : fmtInt(r.aic),
    runLink(r.runId),
  ));
  replaceSection('running', 
    table('Running now', ['Task', 'Attempt', 'Workflow', 'Step / state', 'Model', 'Elapsed', 'Tokens', 'AIC', 'Run'], trs, { numeric: [5, 6, 7] }),
    h('p', { class: 'hint' }, m.running.available
      ? 'Tokens and AIC appear when the run_finished event arrives.'
      : "Run completion isn't logged yet (no run_finished events), so these are dispatched attempts that haven't been superseded, merged, escalated or cancelled. Some may already have finished."),
  );
}

function renderTokens(m) {
  const { rows, total } = m.tokensPerTask;
  if (!rows.length) {
    replaceSection('tokens', empty('No finished runs yet. Tokens and AIC come from run_finished events.'));
    return;
  }
  const cells = (r, label) => [label, fmtInt(r.runs), fmtInt(r.tokens_input), fmtInt(r.tokens_output), fmtInt(r.tokens_cache),
    fmtInt(Math.round(r.aic)), formatDuration(r.duration_ms), r.models.length ? r.models.join(', ') : '—'];
  const trs = rows.map((r) => row(r.task, ...cells(r, r.task === '(no task)' ? r.task : subjectButton(`task:${r.task}`, r.task))));
  const foot = h('tfoot', {}, h('tr', {}, cells(total, 'Total').map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', {}, c)))));
  replaceSection('tokens', table('Tokens and AIC per task',
    ['Task', 'Runs', 'Input tokens', 'Output tokens', 'Cache tokens', 'AIC', 'Run time', 'Models'], trs, { foot, numeric: [1, 2, 3, 4, 5, 6] }));
}

function renderStages(m) {
  const rows = m.stageTimes;
  if (!rows.length) {
    replaceSection('stages', empty('No task or PR has moved through a stage yet.'));
    return;
  }
  const transitions = STAGES.slice(0, -1);
  const trs = rows.map((r) => row(r.key,
    subjectButton(r.key, r.label),
    ...transitions.map((st) => {
      const d = r.durations[st];
      if (!d) return '—';
      const next = STAGES[STAGES.indexOf(st) + 1];
      return d.to === next ? formatDuration(d.ms) : `${formatDuration(d.ms)} (to ${d.to})`;
    }),
    formatDuration(r.totalMs),
    r.current ?? '—',
  ));
  const headers = ['Task / PR', ...transitions.map((st, i) => `${st} → ${STAGES[i + 1]}`), 'Total', 'Latest stage'];
  replaceSection('stages', 
    table('Time per stage', headers, trs, { numeric: transitions.map((_, i) => i + 1).concat(transitions.length + 1) }),
    h('p', { class: 'hint' }, 'Time from reaching each stage to reaching the next one, from event times. A stage that was skipped shows where the time went instead.'),
  );
}

function renderChecks(m) {
  const checks = m.checks.slice(0, 25);
  if (!checks.length) {
    replaceSection('checks', empty('No check results yet.'));
    return;
  }
  const trs = checks.map((ev, i) => safeRow(typeof ev.id === 'string' ? ev.id : `#${i}`, 9, () => {
    const p = ev.payload;
    const ok = p.conclusion === 'success';
    return row(typeof ev.id === 'string' ? ev.id : `#${i}`,
      timeEl(p.completed_at ?? ev.timestamp),
      p.workflow ?? '—',
      h('span', { class: `pill ${ok ? 'pill--ok' : p.conclusion === 'failure' ? 'pill--alert' : ''}` }, p.conclusion ?? '—'),
      p.event ?? '—',
      Array.isArray(p.prs) && p.prs.length ? p.prs.flatMap((n, i) => (i ? [', ', prLink(n)] : [prLink(n)])) : '—',
      commitLink(p.head_sha),
      runLink(p.run_id, p.run_attempt),
      typeof p.heldout_seed === 'string' ? h('code', {}, p.heldout_seed) : '—',
      typeof p.failure_signature === 'string' ? h('code', {}, p.failure_signature) : '—',
    );
  }));
  replaceSection('checks', table('Latest check results',
    ['Completed', 'Workflow', 'Conclusion', 'Event', 'PRs', 'Head', 'Run', 'Held-out seed', 'Failure signature'], trs));
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
