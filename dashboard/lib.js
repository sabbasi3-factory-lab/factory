// Pure logic for the factory control room. No DOM access, no network.
// Runs unchanged in the browser and in Node (>= 20) for the tests.

export const EVENT_FIELDS = ['id', 'parents', 'payload', 'sha', 'timestamp', 'type', 'version'];

export const DEFAULTS = Object.freeze({
  wipLimit: 3, // policies/limits.yaml wip.start
  aicBudget: 10000, // policies/budgets.yaml factory_per_day.max_aic
  aicAlertPct: 80,
  heartbeatWarnMin: 70,
  heartbeatAlertMin: 120, // DESIGN §11: alert after 2 h without a heartbeat
  windowDays: 7,
});

// Task stages in DESIGN §7 order, up to deployed.
export const STAGES = ['ready', 'picked', 'running', 'pr-open', 'checks', 'queued', 'merged', 'deployed'];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA_REF = /^sha256:[0-9a-f]{64}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v !== '';

// ---------------------------------------------------------------------------
// Canonical JSON and hashing

/**
 * Canonical JSON: object keys sorted by UTF-16 code units (the default
 * Array#sort order), recursively; no whitespace; primitives as JSON.stringify
 * prints them.
 */
export function canonicalize(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  switch (typeof value) {
    case 'object': {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
    }
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number in canonical JSON');
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    default:
      throw new TypeError(`unsupported type in canonical JSON: ${typeof value}`);
  }
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "sha256:<hex>" over the canonical JSON of the event without its `sha` field. */
export async function computeEventSha(event) {
  const { sha: _omit, ...rest } = event;
  return 'sha256:' + (await sha256Hex(canonicalize(rest)));
}

// ---------------------------------------------------------------------------
// Parsing and schema

/** Parse one day file. Returns records in line order; bad lines keep an error. */
export function parseJsonl(text, source = '') {
  const records = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    try {
      records.push({ source, line: i + 1, raw: line, event: JSON.parse(line), error: null });
    } catch (err) {
      records.push({ source, line: i + 1, raw: line, event: null, error: `invalid JSON: ${err.message}` });
    }
  });
  return records;
}

export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return ['not an object'];
  const errors = [];
  const keys = Object.keys(event);
  const missing = EVENT_FIELDS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !EVENT_FIELDS.includes(k));
  if (missing.length) errors.push(`missing ${missing.join(', ')}`);
  if (extra.length) errors.push(`unexpected ${extra.join(', ')}`);
  if (event.version !== 1) errors.push('version is not 1');
  if (typeof event.id !== 'string' || !UUID_V4.test(event.id)) errors.push('id is not a UUID v4');
  if (!isStr(event.type)) errors.push('type is empty');
  if (typeof event.timestamp !== 'string' || !TIMESTAMP.test(event.timestamp)) errors.push('timestamp is not UTC seconds');
  if (!Array.isArray(event.parents) || event.parents.length > 1 || !event.parents.every((p) => SHA_REF.test(p))) {
    errors.push('parents is not [] or ["sha256:<hex>"]');
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) errors.push('payload is not an object');
  if (typeof event.sha !== 'string' || !SHA_REF.test(event.sha)) errors.push('sha is not sha256:<hex>');
  return errors;
}

// ---------------------------------------------------------------------------
// Integrity

/**
 * Recompute every sha and check the parent chain across the loaded window.
 * The first event may point outside the window ("window-start"); a first event
 * with no parent is the start of the whole log ("genesis").
 */
export async function verifyChain(records) {
  const results = [];
  let prevSha = null;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const res = { index: i + 1, source: rec.source, line: rec.line, ok: true, link: 'ok', problems: [], expectedSha: null };
    if (rec.error || !rec.event) {
      res.ok = false;
      res.link = 'unknown';
      res.problems.push(rec.error || 'no event');
      results.push(res);
      prevSha = null;
      continue;
    }
    const ev = rec.event;
    for (const s of validateEvent(ev)) res.problems.push(`schema: ${s}`);
    try {
      res.expectedSha = await computeEventSha(ev);
      if (res.expectedSha !== ev.sha) res.problems.push('sha mismatch');
    } catch (err) {
      res.problems.push(`hash: ${err.message}`);
    }
    const parent = Array.isArray(ev.parents) ? ev.parents[0] ?? null : null;
    if (i === 0) {
      res.link = parent ? 'window-start' : 'genesis';
    } else if (!parent) {
      res.link = 'broken';
      res.problems.push('no parent (unexpected second genesis)');
    } else if (parent !== prevSha) {
      res.link = 'broken';
      res.problems.push('parent does not match previous event');
    }
    res.ok = res.problems.length === 0;
    results.push(res);
    prevSha = typeof ev.sha === 'string' ? ev.sha : null;
  }
  const firstBad = results.find((r) => !r.ok);
  return {
    status: records.length === 0 ? 'empty' : firstBad ? 'broken' : 'verified',
    total: records.length,
    problemCount: results.filter((r) => !r.ok).length,
    brokenAt: firstBad ? firstBad.index : null,
    brokenReason: firstBad ? firstBad.problems.join('; ') : null,
    brokenSource: firstBad ? `${firstBad.source}:${firstBad.line}` : null,
    windowStart: results[0]?.link ?? null,
    results,
  };
}

// ---------------------------------------------------------------------------
// Time helpers

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Day-file paths for the last `days` UTC days ending at `now`, oldest first. */
export function dayPaths(now, days = DEFAULTS.windowDays) {
  const end = Date.parse(utcDay(now) + 'T00:00:00Z');
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = utcDay(end - i * 86400000);
    out.push(`audit/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}.jsonl`);
  }
  return out;
}

export function parseTime(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const TIME_FIELD = {
  pr_opened: 'opened_at',
  check_result: 'completed_at',
  queued: 'at',
  dequeued: 'at',
  merged: 'merged_at',
  human_action: 'submitted_at',
};

/** When the fact happened: the payload's own time if it has one, else the event time. */
export function eventTime(ev) {
  const field = TIME_FIELD[ev.type];
  return (field && parseTime(ev.payload?.[field])) ?? parseTime(ev.timestamp);
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(Math.abs(ms) / 1000);
  let out;
  if (s < 60) out = `${s}s`;
  else if (s < 3600) out = `${Math.floor(s / 60)}m ${s % 60}s`;
  else if (s < 172800) out = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  else out = `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  return ms < 0 ? `-${out}` : out;
}

export function heartbeatLevel(ageMin, opts = DEFAULTS) {
  if (ageMin == null) return 'none';
  if (ageMin > opts.heartbeatAlertMin) return 'alert';
  if (ageMin > opts.heartbeatWarnMin) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Subjects (tasks and PRs)

export function eventPrs(ev) {
  const p = ev.payload || {};
  const prs = [];
  if (isNum(p.pr)) prs.push(p.pr);
  if (Array.isArray(p.prs)) for (const n of p.prs) if (isNum(n) && !prs.includes(n)) prs.push(n);
  return prs;
}

/** PR number -> task slug, from any event that carries both. */
export function prTaskMap(events) {
  const map = new Map();
  for (const ev of events) {
    const t = ev.payload?.task;
    if (isStr(t)) for (const pr of eventPrs(ev)) if (!map.has(pr)) map.set(pr, t);
  }
  return map;
}

/** Subject keys an event belongs to: "task:<slug>", "pr:<n>", "issue:<n>". */
export function eventSubjects(ev, prTask) {
  const p = ev.payload || {};
  const keys = new Set();
  if (isStr(p.task)) keys.add(`task:${p.task}`);
  if (isNum(p.issue)) keys.add(`issue:${p.issue}`);
  for (const pr of eventPrs(ev)) {
    keys.add(`pr:${pr}`);
    const t = prTask?.get(pr);
    if (t) keys.add(`task:${t}`);
  }
  return keys;
}

export function subjectLabel(ev) {
  const p = ev.payload || {};
  const parts = [];
  if (isStr(p.task)) parts.push(isNum(p.attempt) ? `${p.task}#a${p.attempt}` : p.task);
  const prs = eventPrs(ev);
  if (prs.length) parts.push(prs.map((n) => `PR #${n}`).join(', '));
  else if (isNum(p.issue)) parts.push(`issue #${p.issue}`);
  return parts.join(' · ');
}

// Latest lifecycle state per task, from the event type.
const STATE_OF = {
  ready: 'ready',
  picked: 'picked',
  dispatched: 'running',
  run_started: 'running',
  run_finished: 'run finished',
  repair_dispatched: 'repairing',
  pr_opened: 'pr-open',
  check_result: 'checks',
  queued: 'queued',
  dequeued: 'dequeued',
  merged: 'merged',
  deployed: 'deployed',
  accepted: 'accepted',
  rejected: 'rejected',
  needs_human: 'needs-human',
  stale_contract: 'stale-contract',
  blocked: 'blocked',
  cancelled: 'cancelled',
  reverted: 'reverted',
};

// A later event of one of these types for the same task/PR/issue closes a needs-you item.
const RESOLVES_NEEDS_YOU = new Set([
  'ready', 'picked', 'dispatched', 'repair_dispatched', 'run_started', 'contract_pinned',
  'human_action', 'merged', 'cancelled', 'accepted', 'rejected',
]);

// Controller decisions (as opposed to facts it observed on GitHub).
const DECISION_TYPES = new Set([
  'ready', 'picked', 'dispatched', 'repair_dispatched', 'needs_human', 'stale_contract', 'blocked',
  'cancelled', 'budget_alert', 'budget_pause', 'kill_switch',
]);

/**
 * A decision logged in dry-run mode is only a plan: nothing was launched or changed.
 * Observed facts (human_action, merged, check_result, ...) still count even though
 * their payload carries dry_run: true, as every v1 event does.
 */
export function isPlanOnly(ev) {
  const p = ev?.payload || {};
  return p.dry_run === true && (DECISION_TYPES.has(ev.type) || typeof p.effect === 'string');
}

// ---------------------------------------------------------------------------
// Metrics

/**
 * Derive tiles and tables from the ordered events of the window.
 * `now` is epoch ms. Pure: the same input always gives the same output.
 */
export function deriveMetrics(events, { now = Date.now(), ...overrides } = {}) {
  const opts = { ...DEFAULTS, ...overrides };
  const today = utcDay(now);
  const prTask = prTaskMap(events);
  const latest = events.length ? events[events.length - 1] : null;

  // Latest heartbeat with a usable timestamp; a malformed one is flagged by verifyChain.
  let lastHeartbeat = null;
  for (const ev of events) if (ev.type === 'heartbeat' && parseTime(ev.timestamp) != null) lastHeartbeat = ev;
  const hbAt = lastHeartbeat ? parseTime(lastHeartbeat.timestamp) : null;
  const ageMin = hbAt == null ? null : Math.max(0, (now - hbAt) / 60000);
  const heartbeat = {
    at: hbAt == null ? null : lastHeartbeat.timestamp,
    ageMin,
    level: heartbeatLevel(ageMin, opts),
    payload: lastHeartbeat?.payload ?? null,
  };
  const fe = lastHeartbeat?.payload?.factory_enabled;
  const fv = latest?.payload?.factory_version;
  const dr = latest?.payload?.dry_run;

  const taskState = new Map();
  const runs = new Map();
  const finished = [];
  let dryRunPlanned = 0;
  let retired = 0;
  const retire = (task, belowAttempt = Infinity) => {
    for (const [key, r] of runs) {
      if (r.task === task && (r.attempt ?? 1) < belowAttempt) {
        runs.delete(key);
        retired++;
      }
    }
  };
  const tasksOf = (subjects) => [...subjects].filter((s) => s.startsWith('task:')).map((s) => s.slice(5));
  const queue = new Map();
  const merged = [];
  const touched = new Set();
  const needs = new Map();
  const checks = [];

  for (const ev of events) {
    const p = ev.payload || {};
    const subjects = eventSubjects(ev, prTask);
    const state = STATE_OF[ev.type];
    if (state) for (const s of subjects) if (s.startsWith('task:')) taskState.set(s.slice(5), { state, at: ev.timestamp });

    switch (ev.type) {
      case 'dispatched':
      case 'repair_dispatched': {
        // A dry-run dispatch is only a plan: nothing runs, so it never gets a run_finished.
        if (p.dry_run === true) {
          dryRunPlanned++;
          break;
        }
        // A later attempt supersedes earlier ones for the same task.
        if (isStr(p.task)) retire(p.task, isNum(p.attempt) ? p.attempt : 1);
        const key = runKey(p, ev);
        runs.set(key, {
          key,
          task: isStr(p.task) ? p.task : null,
          issue: isNum(p.issue) ? p.issue : null,
          attempt: isNum(p.attempt) ? p.attempt : null,
          workflow: isStr(p.workflow) ? p.workflow : ev.type === 'repair_dispatched' ? 'repair' : 'implement',
          model: isStr(p.model) ? p.model : null,
          runId: isNum(p.run_id) ? p.run_id : null,
          startedAt: parseTime(ev.timestamp),
        });
        break;
      }
      case 'run_started': {
        const r = runs.get(runKey(p, ev));
        if (r) {
          if (isStr(p.model)) r.model = p.model;
          if (isNum(p.run_id)) r.runId = p.run_id;
        }
        break;
      }
      case 'run_finished':
        runs.delete(runKey(p, ev));
        finished.push(ev);
        break;
      case 'queued':
        if (isNum(p.pr)) queue.set(p.pr, { pr: p.pr, at: p.at ?? ev.timestamp, actor: p.actor ?? null });
        break;
      case 'dequeued':
        if (isNum(p.pr)) queue.delete(p.pr);
        break;
      case 'merged':
        if (isNum(p.pr)) queue.delete(p.pr);
        merged.push(ev);
        for (const t of tasksOf(subjects)) retire(t);
        break;
      case 'needs_human':
      case 'cancelled':
        if (!isPlanOnly(ev)) for (const t of tasksOf(subjects)) retire(t);
        break;
      case 'human_action':
        if (isNum(p.pr)) touched.add(p.pr);
        break;
      case 'check_result':
        checks.push(ev);
        break;
      default:
        break;
    }

    if (ev.type === 'needs_human' || ev.type === 'stale_contract') {
      const key = primarySubject(ev);
      needs.set(key, {
        key,
        kind: ev.type,
        task: isStr(p.task) ? p.task : null,
        issue: isNum(p.issue) ? p.issue : null,
        pr: isNum(p.pr) ? p.pr : null,
        reason: isStr(p.reason) ? p.reason : null,
        effect: isStr(p.effect) ? p.effect : null,
        since: parseTime(ev.timestamp) == null ? null : ev.timestamp,
        ageMs: parseTime(ev.timestamp) == null ? null : now - parseTime(ev.timestamp),
        subjects,
      });
    } else if (RESOLVES_NEEDS_YOU.has(ev.type) && !isPlanOnly(ev)) {
      for (const [key, item] of needs) {
        if ([...subjects].some((s) => item.subjects.has(s))) needs.delete(key);
      }
    }
  }

  const runningRows = [...runs.values()].map((r) => ({
    ...r,
    state: (r.task && taskState.get(r.task)?.state) || 'running',
    elapsedMs: r.startedAt == null ? null : now - r.startedAt,
    tokens: null, // known only from run_finished
    aic: null,
  }));

  const mergedToday = merged.filter((ev) => utcDay(eventTime(ev)) === today);
  const factoryMerged = merged.filter((ev) => isStr(ev.payload?.task) || prTask.has(ev.payload?.pr));
  const untouched = factoryMerged.filter((ev) => !touched.has(ev.payload?.pr));

  let aicTotal = 0;
  for (const ev of finished) {
    if (utcDay(parseTime(ev.timestamp)) === today && isNum(ev.payload?.aic)) aicTotal += ev.payload.aic;
  }
  const aicPct = opts.aicBudget > 0 ? (aicTotal / opts.aicBudget) * 100 : null;

  const needsItems = [...needs.values()]
    .map(({ subjects: _s, ...rest }) => rest)
    .sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));

  // Without any run_finished in the window, completion is unknown: v1 doesn't log it,
  // so a dispatched attempt may have ended long ago. Report "unavailable", not a count.
  const runStatusAvailable = finished.length > 0;

  return {
    now,
    today,
    eventCount: events.length,
    latestAt: parseTime(latest?.timestamp) == null ? null : latest.timestamp,
    heartbeat,
    killSwitch: { enabled: typeof fe === 'boolean' ? fe : null, at: heartbeat.at },
    factoryVersion: isStr(fv) ? fv : null,
    dryRun: typeof dr === 'boolean' ? dr : null,
    running: {
      available: runStatusAvailable,
      count: runStatusAvailable ? runningRows.length : null,
      wipLimit: opts.wipLimit,
      rows: runningRows,
      dryRunPlanned,
      retired,
    },
    queue: { count: queue.size, items: [...queue.values()] },
    mergedToday: { count: mergedToday.length, prs: mergedToday.map((ev) => ev.payload?.pr).filter(isNum) },
    zeroTouch: {
      merged: factoryMerged.length,
      untouched: untouched.length,
      rate: factoryMerged.length ? untouched.length / factoryMerged.length : null,
    },
    aicToday: {
      total: aicTotal,
      budget: opts.aicBudget,
      pct: aicPct,
      level: aicPct == null ? 'ok' : aicPct >= 100 ? 'alert' : aicPct >= opts.aicAlertPct ? 'warn' : 'ok',
    },
    needsYou: { count: needsItems.length, items: needsItems, humanTierDerivable: false },
    tokensPerTask: tokensPerTask(finished),
    stageTimes: stageTimes(events, prTask),
    checks: checks.slice().reverse(),
    subjects: listSubjects(events, prTask),
  };
}

function runKey(p, ev) {
  if (isStr(p.task)) return `${p.task}#a${isNum(p.attempt) ? p.attempt : 1}`;
  if (isNum(p.run_id)) return `run:${p.run_id}`;
  return `event:${ev.id}`;
}

function primarySubject(ev) {
  const p = ev.payload || {};
  if (isStr(p.task)) return `task:${p.task}`;
  if (isNum(p.pr)) return `pr:${p.pr}`;
  if (isNum(p.issue)) return `issue:${p.issue}`;
  return `event:${ev.id}`;
}

const TOKEN_FIELDS = ['tokens_input', 'tokens_output', 'tokens_cache', 'aic', 'duration_ms'];

function tokensPerTask(finished) {
  const blank = (task) => ({ task, runs: 0, tokens_input: 0, tokens_output: 0, tokens_cache: 0, aic: 0, duration_ms: 0, models: [] });
  const rows = new Map();
  const total = blank('Total');
  for (const ev of finished) {
    const p = ev.payload || {};
    const task = isStr(p.task) ? p.task : '(no task)';
    if (!rows.has(task)) rows.set(task, blank(task));
    for (const row of [rows.get(task), total]) {
      row.runs++;
      for (const f of TOKEN_FIELDS) if (isNum(p[f])) row[f] += p[f];
      if (isStr(p.model) && !row.models.includes(p.model)) row.models.push(p.model);
    }
  }
  return { rows: [...rows.values()], total };
}

const STAGE_OF = {
  ready: 'ready',
  picked: 'picked',
  dispatched: 'running',
  run_started: 'running',
  pr_opened: 'pr-open',
  check_result: 'checks',
  queued: 'queued',
  merged: 'merged',
  deployed: 'deployed',
};

/**
 * First time each stage was reached, per task (and per PR without a task),
 * and the time spent before the next reached stage.
 */
export function stageTimes(events, prTask = prTaskMap(events)) {
  const subjects = new Map();
  const get = (key, label) => {
    if (!subjects.has(key)) subjects.set(key, { key, label, reached: {} });
    return subjects.get(key);
  };
  for (const ev of events) {
    const stage = STAGE_OF[ev.type];
    if (!stage) continue;
    if (ev.type === 'dispatched' && ev.payload?.dry_run === true) continue; // planned, not running
    const p = ev.payload || {};
    const ms = eventTime(ev);
    if (ms == null) continue;
    const tasks = new Set();
    if (isStr(p.task)) tasks.add(p.task);
    const prs = eventPrs(ev);
    for (const pr of prs) if (prTask.has(pr)) tasks.add(prTask.get(pr));
    const targets = tasks.size ? [...tasks].map((t) => get(`task:${t}`, t)) : prs.map((pr) => get(`pr:${pr}`, `PR #${pr}`));
    for (const s of targets) if (s.reached[stage] == null) s.reached[stage] = ms;
  }
  const rows = [];
  for (const s of subjects.values()) {
    const reachedStages = STAGES.filter((st) => s.reached[st] != null);
    const durations = {};
    for (let i = 0; i < reachedStages.length - 1; i++) {
      const from = reachedStages[i];
      const to = reachedStages[i + 1];
      durations[from] = { to, ms: s.reached[to] - s.reached[from] };
    }
    const first = reachedStages.length ? s.reached[reachedStages[0]] : null;
    const last = reachedStages.length ? s.reached[reachedStages[reachedStages.length - 1]] : null;
    rows.push({
      key: s.key,
      label: s.label,
      reached: s.reached,
      durations,
      current: reachedStages[reachedStages.length - 1] ?? null,
      totalMs: first != null ? last - first : null,
    });
  }
  return rows;
}

export function listSubjects(events, prTask = prTaskMap(events)) {
  const seen = new Map();
  for (const ev of events) {
    for (const key of eventSubjects(ev, prTask)) {
      if (key.startsWith('issue:') || seen.has(key)) continue;
      seen.set(key, key.startsWith('task:') ? key.slice(5) : `PR #${key.slice(3)}`);
    }
  }
  return [...seen].map(([key, label]) => ({ key, label })).sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}

/** Events of one subject in order, with the gap since the previous one. */
export function timelineFor(events, subjectKey) {
  const prTask = prTaskMap(events);
  const out = [];
  let prev = null;
  for (const ev of events) {
    if (!eventSubjects(ev, prTask).has(subjectKey)) continue;
    const ms = parseTime(ev.timestamp);
    out.push({ event: ev, gapMs: prev == null || ms == null ? null : ms - prev });
    prev = ms;
  }
  return out;
}
