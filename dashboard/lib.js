// Pure logic for the factory control room. No DOM access, no network.
// Runs unchanged in the browser and in Node (>= 20) for the tests.

export const EVENT_FIELDS = ['id', 'parents', 'payload', 'sha', 'timestamp', 'type', 'version'];

export const DEFAULTS = Object.freeze({
  wipLimit: 3, // policies/limits.yaml wip.start
  aicBudget: 10000, // policies/budgets.yaml factory_per_day.max_aic
  aicAlertPct: 80,
  // The controller is scheduled hourly, but GitHub's cron on a Free-plan org runs it only
  // every 2 to 8 h (measured: median gap 2.4 h, p90 4.4 h, worst 7.6 h), so the limits
  // sit above the observed worst case: amber after 8 h, alert after 12 h. The watchdog
  // imports heartbeatAlertMin.
  heartbeatWarnMin: 480,
  heartbeatAlertMin: 720,
  windowDays: 7,
  perTaskAic: 1000, // policies/budgets.yaml per_task.max_aic
  humanQueueMax: 5, // policies/limits.yaml human_queue.max_items
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

const DAY_FILE = /^\d{4}\/\d{2}\/\d{2}\.jsonl$/;

/**
 * Every day file in a recursive git tree listing of `audit/` (entries like "2026/10/16.jsonl"),
 * oldest first, as "audit/2026/10/16.jsonl": the whole log, for lifetime numbers.
 */
export function allDayPaths(treeEntries) {
  return (treeEntries || []).filter((t) => t && t.type === 'blob' && typeof t.path === 'string' && DAY_FILE.test(t.path))
    .map((t) => `audit/${t.path}`).sort();
}

/** The events of the last `days` UTC days before `now` (for the windowed operations views). */
export function eventsInWindow(events, { now = Date.now(), days = DEFAULTS.windowDays } = {}) {
  const from = Date.parse(utcDay(now) + 'T00:00:00Z') - (days - 1) * 86400000;
  return (events || []).filter((ev) => {
    const t = parseTime(ev?.timestamp);
    return t != null && t >= from;
  });
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

/** A limit in minutes as people say it: "8 h" for whole hours, else "90 min". */
export function formatLimit(min) {
  if (!isNum(min)) return '—';
  return min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

export function heartbeatLevel(ageMin, opts = DEFAULTS) {
  if (ageMin == null) return 'none';
  if (ageMin > opts.heartbeatAlertMin) return 'alert';
  if (ageMin > opts.heartbeatWarnMin) return 'warn';
  return 'ok';
}

/** Coarse age for an aria-live line: whole hours from 2 h, so it changes at most hourly. */
export function formatAge(ageMin) {
  if (ageMin == null || !Number.isFinite(ageMin)) return 'unknown';
  if (ageMin < 120) return `${Math.floor(ageMin)} min`;
  if (ageMin < 48 * 60) return `${Math.floor(ageMin / 60)} h`;
  return `${Math.floor(ageMin / 1440)} d`;
}

const LEVEL_RANK = { ok: 0, info: 0, warn: 1, alert: 2 };

/**
 * The header status line: data freshness plus controller liveness, so it never reads as
 * healthy while the heartbeat is late or missing. Returns { text, level } where level is
 * "info", "ok", "warn" or "alert". Fails closed: unknown heartbeat state is a warning.
 */
export function statusSummary({ loaded = false, noLog = false, error = null, fixture = false, eventCount = 0, headSha = null, days = DEFAULTS.windowDays, heartbeat = null } = {}) {
  if (!loaded && !error) return { text: 'Loading the audit log…', level: 'info' };
  if (noLog && !error) {
    return { text: 'No audit log yet: the audit branch does not exist, so there is no controller heartbeat.', level: 'warn' };
  }

  let data;
  let dataLevel = 'ok';
  const head = typeof headSha === 'string' ? headSha.slice(0, 7) : null;
  if (error) {
    data = `Problem: ${error}${loaded ? ' Showing the last data loaded' : ''}`;
    dataLevel = 'alert';
  } else if (fixture) data = `Sample data · ${eventCount} events`;
  else if (!eventCount) data = `Audit branch found${head ? ` (head ${head})` : ''}, but no events in the last ${days} days`;
  else data = `Data fresh · ${eventCount} events${head ? ` · audit head ${head}` : ''}`;
  if (!loaded) return { text: data, level: dataLevel };

  let hb;
  let hbLevel;
  const level = heartbeat?.level ?? 'unknown';
  if (level === 'ok') [hb, hbLevel] = ['controller heartbeat ok', 'ok'];
  else if (level === 'warn') [hb, hbLevel] = [`controller heartbeat late (over ${formatLimit(DEFAULTS.heartbeatWarnMin)})`, 'warn'];
  else if (level === 'alert') [hb, hbLevel] = [`controller heartbeat stale (${formatAge(heartbeat.ageMin)})`, 'alert'];
  else if (level === 'none') [hb, hbLevel] = [`no controller heartbeat in the last ${days} days`, 'alert'];
  else [hb, hbLevel] = ['controller heartbeat unknown', 'warn'];

  return { text: `${data} · ${hb}`, level: LEVEL_RANK[hbLevel] > LEVEL_RANK[dataLevel] ? hbLevel : dataLevel };
}

// ---------------------------------------------------------------------------
// Glance view: one health word, compact ages, short titles

export const HEALTH_LABELS = Object.freeze({ ok: 'Healthy', warn: 'Degraded', alert: 'Down', loading: 'Loading', paused: 'Paused' });
export const STALE_DATA_MIN = 10; // live data older than this is not fresh

/**
 * The single health chip, from data freshness, the controller heartbeat, the chain check
 * and the independent verifier (`verifier` is a verifierStatus() result; omit it to leave
 * the verifier out). Returns { level, label, reasons } with level "ok" (Healthy), "warn"
 * (Degraded), "alert" (Down) or "loading" (neutral: nothing loaded yet and no error, so
 * nothing is known to be wrong). The worst condition wins:
 *
 * - Down: no audit log; nothing loaded because of an error; the chain is broken; the
 *   heartbeat is missing from the window or stale (over 12 h); the verifier is stale
 *   (over 26 h) or unknown (unreadable, empty, malformed, out of order or in the
 *   future).
 * - Degraded: the last refresh failed, so older data is shown; the data is over
 *   10 min old (`dataAgeMin`); the heartbeat is late (over 8 h) or unknown; the chain
 *   isn't verified (not loaded or empty); the verifier is late (over 8 h) or not set up.
 * - Paused (amber, the warn level): dispatch is held by a gate (`dispatch`, a
 *   dispatchBanner() result; not the kill switch, which has its own chip) and nothing
 *   else is wrong. With other warn conditions it reads Degraded, with the pause listed.
 * - Healthy: fresh data, a verified chain, a heartbeat within 8 h and, when given, a
 *   verifier anchor within 8 h. A verifier still being checked doesn't count either way.
 *
 * The limits (DEFAULTS.heartbeatWarnMin/AlertMin, VERIFIER_LIMITS) sit above the cadence
 * GitHub's scheduler really delivers on a Free plan, every 2 to 8 h for hourly jobs, so
 * a normal late run doesn't read as Degraded.
 *
 * `reasons` lists every condition that isn't healthy, worst first, for the tooltip; `problems`
 * has the same as { level, code, text }, so the status line can say it in plain words.
 */
export function healthSummary({ loaded = false, noLog = false, error = null, chain = null, heartbeat = null, dataAgeMin = null, verifier = null, dispatch = null } = {}) {
  if (!loaded && !error) return { level: 'loading', label: HEALTH_LABELS.loading, reasons: ['Loading the audit log'], problems: [] };
  const found = [];
  const add = (level, text, code) => found.push({ level, text, code });
  if (noLog) add('alert', 'No audit log yet', 'no-log');
  if (error) add(loaded ? 'warn' : 'alert', `${loaded ? 'Last refresh failed' : "Couldn't load the audit log"}: ${error}`, loaded ? 'refresh-failed' : 'load-failed');
  if (!error && isNum(dataAgeMin) && dataAgeMin > STALE_DATA_MIN) add('warn', `Data is ${formatAge(dataAgeMin)} old`, 'data-stale');
  if (loaded && !noLog) {
    if (chain?.status === 'broken') add('alert', `Chain broken at event ${chain.brokenAt}`, 'chain-broken');
    else if (chain?.status !== 'verified') add('warn', 'Chain not verified', 'chain-unverified');
    const level = heartbeat?.level ?? 'unknown';
    if (level === 'alert') add('alert', `Heartbeat stale (${formatAge(heartbeat.ageMin)})`, 'hb-stale');
    else if (level === 'none') add('alert', 'No heartbeat in the window', 'hb-none');
    else if (level === 'warn') add('warn', `Heartbeat late (${formatAge(heartbeat.ageMin)})`, 'hb-late');
    else if (level !== 'ok') add('warn', 'Heartbeat unknown', 'hb-unknown');
  }
  if (verifier && (verifier.level === 'warn' || verifier.level === 'alert')) add(verifier.level, verifierReason(verifier), `verifier:${verifier.reason}`);
  // Dispatch held by a gate (a dispatchBanner() result) is never "Healthy". The kill switch is
  // the deliberate safe state with its own chip, so it doesn't count.
  const paused = dispatch?.state === 'paused' && dispatch.reason !== 'kill_switch';
  if (paused) add('warn', dispatch.text, 'paused');
  const worst = found.reduce((a, f) => (LEVEL_RANK[f.level] > LEVEL_RANK[a] ? f.level : a), 'ok');
  found.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const reasons = found.map((f) => f.text);
  // Paused and nothing else wrong: say "Paused", not "Degraded".
  const label = paused && worst === 'warn' && found.length === 1 ? HEALTH_LABELS.paused : HEALTH_LABELS[worst];
  return { level: worst, label, reasons, problems: found.map(({ level, code, text }) => ({ level, code, text })) };
}

/** One-token age: "45s", "12m", "7h", "3d"; "—" when unknown. */
export function compactAge(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---------------------------------------------------------------------------
// Independent verifier anchors
//
// The factory's audit-verify workflow fully re-verifies the audit log and, on success,
// appends one canonical-JSON line to anchors/chrono-node-rs.jsonl on the `anchors` branch
// of the factory repo. The page only checks the shape and order of those lines; it doesn't
// recompute any hash.

export const ANCHOR_FIELDS = ['at', 'audit_head', 'events', 'last_sha', 'run_id', 'source', 'v'];
export const ANCHOR_SOURCE = 'sabbasi3-factory-lab/chrono-node-rs';
export const VERIFIER_LIMITS = Object.freeze({
  warnMin: 8 * 60, // scheduled hourly, but GitHub runs it every 2 to 8 h: amber after 8 h
  alertMin: 26 * 60, // red after 26 h, the same limit as the watchdog
});

/** Exact UTC second-precision time ("2026-10-17T05:47:12Z") that round-trips, or null. */
export function parseUtcSeconds(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value) return null;
  return ms;
}

/** Problems with one parsed anchor line (an empty list means valid). */
export function validateAnchor(anchor, source = ANCHOR_SOURCE) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return ['not an object'];
  const errors = [];
  const keys = Object.keys(anchor);
  const missing = ANCHOR_FIELDS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !ANCHOR_FIELDS.includes(k));
  if (missing.length) errors.push(`missing ${missing.join(', ')}`);
  if (extra.length) errors.push(`unexpected ${extra.join(', ')}`);
  if (anchor.v !== 1) errors.push('v is not 1');
  if (parseUtcSeconds(anchor.at) == null) errors.push('at is not a UTC time with seconds');
  if (anchor.audit_head !== null && !(typeof anchor.audit_head === 'string' && /^[0-9a-f]{40}$/.test(anchor.audit_head))) {
    errors.push('audit_head is not a 40-character commit SHA or null');
  }
  const eventsOk = Number.isSafeInteger(anchor.events) && anchor.events >= 0;
  if (!eventsOk) errors.push('events is not an integer ≥ 0');
  if (eventsOk && anchor.events === 0 ? anchor.last_sha !== null : !(typeof anchor.last_sha === 'string' && SHA_REF.test(anchor.last_sha))) {
    errors.push(eventsOk && anchor.events === 0 ? 'last_sha is not null with 0 events' : 'last_sha is not sha256:<hex>');
  }
  if (!(Number.isSafeInteger(anchor.run_id) && anchor.run_id > 0)) errors.push('run_id is not a positive integer');
  if (anchor.source !== source) errors.push(`source is not ${source}`);
  return errors;
}

/**
 * Parses the whole anchors file. Every line must be valid, canonical JSON (sorted keys, no
 * whitespace) and the lines must not go back in `at` or `events`. A trailing newline is
 * allowed; any other blank line is a problem.
 * Returns { anchors, problem } where problem is null or { line, reason }.
 */
export function parseAnchors(text, source = ANCHOR_SOURCE) {
  const lines = String(text ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fail = (reason) => ({ anchors, problem: { line: i + 1, reason } });
    let anchor;
    try {
      anchor = JSON.parse(raw);
    } catch {
      return fail(raw.trim() === '' ? 'blank line' : 'invalid JSON');
    }
    const errors = validateAnchor(anchor, source);
    if (errors.length) return fail(errors.join('; '));
    if (canonicalize(anchor) !== raw) return fail('not canonical JSON');
    const prev = anchors.at(-1);
    if (prev && anchor.at < prev.at) return fail('at goes back in time');
    if (prev && anchor.events < prev.events) return fail('events goes down');
    anchors.push(anchor);
  }
  return { anchors, problem: null };
}

/**
 * The verifier chip, from the result of reading the anchors file:
 * fetched: { status: 'pending' | 'ok' | 'missing' | 'error', text?, detail? }.
 * Returns { level, reason, chip, title, line, count, newest, ageMin }. Only a readable,
 * fully valid file whose newest anchor is recent reads as "ok"; anything unreadable is
 * "unknown" and alerts. A 404 (the branch or file isn't created yet) is a warning.
 */
export function verifierStatus(fetched, now, limits = VERIFIER_LIMITS) {
  const base = { count: 0, newest: null, ageMin: null };
  const status = fetched?.status;
  if (status === 'pending') {
    return { ...base, level: 'info', reason: 'verifier-loading', chip: 'Verifier: checking…', title: null, line: 'Independent verifier: checking…' };
  }
  if (status === 'missing') {
    return {
      ...base, level: 'warn', reason: 'verifier-not-set-up', chip: 'Verifier not set up yet',
      title: 'No anchors file yet: the audit-verify workflow creates it on its first successful run.',
      line: 'Independent verifier: not set up yet. The audit-verify workflow creates its anchors file on the first successful run.',
    };
  }
  const unknown = (reason, short, why) => ({
    ...base, level: 'alert', reason, chip: `Verifier unknown · ${short}`, title: why, line: `Independent verifier: unknown (${why}).`,
  });
  if (status !== 'ok') return unknown('verifier-unreadable', 'unreadable', `couldn't read the anchors file${fetched?.detail ? `: ${fetched.detail}` : ''}`);

  const { anchors, problem } = parseAnchors(fetched.text);
  if (problem) {
    const reason = /goes (back|down)/.test(problem.reason) ? 'verifier-out-of-order' : 'verifier-malformed';
    return unknown(reason, `bad anchor line ${problem.line}`, `anchor line ${problem.line}: ${problem.reason}`);
  }
  if (!anchors.length) return unknown('verifier-empty', 'no anchors', 'the anchors file is empty');

  const newest = anchors.at(-1);
  const ms = parseUtcSeconds(newest.at);
  if (ms > now) {
    return { ...unknown('verifier-future', 'anchor in the future', `the newest anchor (${newest.at}) is in the future`), count: anchors.length, newest };
  }
  const ageMin = (now - ms) / 60000;
  const level = ageMin > limits.alertMin ? 'alert' : ageMin > limits.warnMin ? 'warn' : 'ok';
  const n = anchors.length;
  const plural = `${n.toLocaleString('en-US')} anchor${n === 1 ? '' : 's'}`;
  const head = newest.audit_head ? `audit head ${newest.audit_head.slice(0, 7)}` : 'no audit head';
  return {
    count: n, newest, ageMin, level,
    reason: level === 'ok' ? 'verifier-fresh' : level === 'warn' ? 'verifier-late' : 'verifier-stale',
    chip: `Verified ${formatAge(ageMin)} ago · ${plural}`,
    title: `Last independent verification ${newest.at} (run ${newest.run_id}). Amber after ${formatLimit(limits.warnMin)}, red after ${formatLimit(limits.alertMin)}.`,
    line: `Independent verifier: last run ${formatAge(ageMin)} ago, ${plural}, newest covers ${newest.events.toLocaleString('en-US')} event${newest.events === 1 ? '' : 's'} (${head}).`,
  };
}

const AGED_REASONS = new Set(['verifier-fresh', 'verifier-late', 'verifier-stale']);

/** A short line for the health tooltip: "Verified 23m ago · 41 anchors", "Verifier not set up", … */
export function verifierReason(v) {
  if (!v) return 'Verifier: unknown';
  if (v.reason === 'verifier-not-set-up') return 'Verifier not set up';
  if (v.level === 'info') return 'Verifier: checking';
  if (AGED_REASONS.has(v.reason) && isNum(v.ageMin)) {
    return `Verified ${compactAge(v.ageMin * 60000)} ago · ${v.count.toLocaleString('en-US')} anchor${v.count === 1 ? '' : 's'}`;
  }
  return `Verifier unknown: ${v.title ?? v.reason}`;
}

// ---------------------------------------------------------------------------
// Observed cadence: how often scheduled jobs really ran. GitHub's cron runs "hourly"
// schedules late, often by hours, on Free plans, so tooltips show the measured gaps next
// to the limits.

export const CADENCE_NOTE = 'GitHub runs scheduled jobs late on Free plans';

/**
 * The gaps between consecutive times (epoch ms or ISO strings; invalid ones are ignored,
 * the rest sorted). Returns { count, medianH, maxH } where count is the number of times
 * and the gaps are in hours, or null with fewer than 2 times.
 */
export function observedCadence(timestamps) {
  const times = (timestamps || [])
    .map((t) => (typeof t === 'string' ? parseTime(t) : t))
    .filter(isNum)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gapsH = times.slice(1).map((t, i) => (t - times[i]) / 3600000);
  return { count: times.length, medianH: median(gapsH), maxH: Math.max(...gapsH) };
}

/** Hours to one decimal ("2.4 h"), or whole minutes under an hour ("45 min"). */
export function formatHours(h) {
  if (!isNum(h) || h < 0) return '—';
  return h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
}

/**
 * One tooltip line: "Heartbeats: median every 2.4 h, longest gap 7.6 h (7 days)", or
 * "Heartbeats: too few to measure (7 days)" when observedCadence() returned null.
 */
export function cadenceText(label, cadence, days = DEFAULTS.windowDays) {
  const span = `(${days} day${days === 1 ? '' : 's'})`;
  if (!cadence) return `${label}: too few to measure ${span}`;
  return `${label}: median every ${formatHours(cadence.medianH)}, longest gap ${formatHours(cadence.maxH)} ${span}`;
}

/** "amber after 8 h, red after 12 h" */
export function limitsText(warnMin, alertMin) {
  return `amber after ${formatLimit(warnMin)}, red after ${formatLimit(alertMin)}`;
}

/** Times of the heartbeats in the loaded events (epoch ms), oldest first. */
export function heartbeatTimes(events) {
  return (events || []).filter((ev) => ev?.type === 'heartbeat').map((ev) => parseTime(ev.timestamp)).filter(isNum);
}

/** Times of the anchors (epoch ms) within the last `days` days before `now`. */
export function anchorTimes(anchors, { now = Date.now(), days = DEFAULTS.windowDays } = {}) {
  const from = now - days * 86400000;
  return (anchors || []).map((a) => parseUtcSeconds(a?.at)).filter((ms) => ms != null && ms >= from && ms <= now);
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
  // Live task_done events mean the controller closes the lifecycle of every task it dispatched
  // (merged → task_done, or a needs_human hand-off), so attempts that are still listed are live.
  let liveTaskDone = 0;
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
          pr: isNum(p.pr) ? p.pr : null,
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
        for (const t of tasksOf(subjects)) retire(t);
        break;
      case 'needs_human':
      case 'cancelled':
        if (!isPlanOnly(ev)) for (const t of tasksOf(subjects)) retire(t);
        break;
      case 'task_done':
        if (!isPlanOnly(ev)) {
          liveTaskDone++;
          for (const t of tasksOf(subjects)) retire(t);
        }
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


  let finishedToday = 0;
  for (const ev of finished) {
    if (utcDay(parseTime(ev.timestamp)) === today && isNum(ev.payload?.aic)) finishedToday += ev.payload.aic;
  }
  // The controller's spend_snapshot (measured + reserved for runs in flight) is the source of
  // truth; run_finished events, where present, can only raise it (as the controller does).
  const snap = spendSnapshots(events).get(today) ?? null;
  const aicTotal = snap ? Math.max(snap.total, finishedToday) : finishedToday;
  const aicPct = opts.aicBudget > 0 ? (aicTotal / opts.aicBudget) * 100 : null;

  const needsItems = [...needs.values()]
    .map(({ subjects: _s, ...rest }) => rest)
    .sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));

  // Completion is known when runs log run_finished, or when the controller records task_done (it
  // then retires every dispatched task by merge, task_done or a hand-off). Without either, a
  // dispatched attempt may have ended long ago: report "unavailable", not a count.
  const runStatusAvailable = finished.length > 0 || liveTaskDone > 0;

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
    aicToday: {
      total: aicTotal,
      source: snap ? 'spend_snapshot' : finished.length ? 'run_finished' : null,
      measured: snap ? snap.measured : null,
      reserved: snap ? snap.reserved : null,
      runs: snap ? snap.runs : null,
      listed: snap ? snap.listed : null,
      at: snap ? snap.at : null,
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

/**
 * The audit log only says what happened; an issue or PR closed by hand (or long ago) never gets
 * an event that clears it. Given the numbers of the source repo's issues and PRs that are open now,
 * drop Needs-you items and running rows that reference a closed one. `open` null = current state
 * unknown: change nothing (never hide on a guess). `asOf` (ms) is when `open` was read: an item or
 * run that started after it may reference an issue or PR the snapshot can't know, so it stays.
 * Returns a new metrics object.
 */
export function dropClosed(m, open, asOf = null) {
  if (!m || !(open instanceof Set) || !isNum(asOf)) return m;
  const closed = (x) => isClosedRef({ issue: x.issue, pr: x.pr, at: x.since != null ? parseTime(x.since) : x.startedAt }, open, asOf);
  const items = m.needsYou.items.filter((i) => !closed(i));
  const rows = m.running.rows.filter((r) => !closed(r));
  return {
    ...m,
    needsYou: { ...m.needsYou, count: items.length, items, closedDropped: m.needsYou.items.length - items.length },
    running: {
      ...m.running,
      rows,
      count: m.running.count == null ? null : rows.length,
      closedDropped: m.running.rows.length - rows.length,
    },
  };
}

/**
 * The one "closed" rule for in-flight work (Needs-you items, running rows, the task board): a
 * reference `{ issue, pr, at }` is closed when its issue, or the PR it points at, is not in `open`
 * (the source repo's open issue and PR numbers, read at `asOf`, ms). Never closed when the open set
 * is unknown, or when `at` (when the item started) is missing or newer than the snapshot.
 */
export function isClosedRef(ref, open, asOf) {
  if (!ref || !(open instanceof Set) || !isNum(asOf) || !isNum(ref.at) || ref.at > asOf) return false;
  return (isNum(ref.issue) && !open.has(ref.issue)) || (isNum(ref.pr) && !open.has(ref.pr));
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
  auto_ready: 'ready',
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

// ---------------------------------------------------------------------------
// Short SHAs, medians and spend snapshots

/** First 7 characters of a hex SHA; anything else is returned unchanged. */
export function shortSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{8,64}$/i.test(value) ? value.slice(0, 7) : value;
}

function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * The newest real (non-dry-run) `spend_snapshot` per UTC day: the controller's spend for that
 * day, measured from gh-aw usage artifacts plus reservations for runs still going.
 */
export function spendSnapshots(events) {
  const byDay = new Map();
  for (const ev of events) {
    if (ev.type !== 'spend_snapshot') continue;
    const p = ev.payload || {};
    const t = parseTime(ev.timestamp);
    if (p.dry_run !== false || !isStr(p.day) || !isNum(p.aic_today) || t == null || utcDay(t) !== p.day) continue;
    const prev = byDay.get(p.day);
    if (prev && prev.t > t) continue;
    let measured = 0;
    let reserved = 0;
    const list = Array.isArray(p.runs) ? p.runs : [];
    for (const r of list) {
      if (!isNum(r?.aic)) continue;
      if (r.status === 'reserved') reserved += r.aic;
      else measured += r.aic;
    }
    const runs = isNum(p.runs_total) ? p.runs_total : null;
    // The controller lists at most 50 runs; with more, the split covers only part of the total.
    const complete = runs != null && runs === list.length;
    byDay.set(p.day, { t, at: ev.timestamp, total: p.aic_today, measured: complete ? measured : null, reserved: complete ? reserved : null, runs, listed: list.length });
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Owner reviews: open human-tier PRs, read from GitHub's open-PR lists until the
// audit log records human-tier PR events.

export const HUMAN_TIER_LABELS = Object.freeze(['owner-review', 'human-tier', 'needs-human']);
// "Tier:" then "human" or "owner", allowing markdown bold/italics around either part.
const TIER_LINE = /(?<![A-Za-z0-9])Tier(?![A-Za-z0-9])\s*(?:\*\*|__|\*|_)?\s*:\s*(?:\*\*|__|\*|_|`)?\s*(human|owner)\b/i;

/** True for an open, non-draft PR whose body has a human/owner tier line or a human-tier label. */
export function isHumanTierPr(pr) {
  if (!pr || pr.draft === true) return false;
  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase());
  if (labels.some((l) => HUMAN_TIER_LABELS.includes(l))) return true;
  return typeof pr.body === 'string' && TIER_LINE.test(pr.body);
}

/**
 * The fields the dashboard keeps from a GitHub PR-list entry. The body is used only for
 * the tier match and then dropped; it is never rendered.
 */
export function summarizePr(pr) {
  return {
    number: isNum(pr?.number) ? pr.number : null,
    title: typeof pr?.title === 'string' ? pr.title : '',
    draft: pr?.draft === true,
    createdAt: typeof pr?.created_at === 'string' && parseTime(pr.created_at) != null ? pr.created_at : null,
    humanTier: isHumanTierPr(pr),
  };
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** "Review and merge" items from summarized open-PR lists ([{ repo, prs }]), oldest first. */
export function reviewItems(lists, now = Date.now()) {
  const items = [];
  for (const { repo, prs } of lists || []) {
    if (typeof repo !== 'string' || !REPO_NAME.test(repo)) continue;
    for (const pr of prs || []) {
      if (!pr || pr.draft || !pr.humanTier || !isNum(pr.number)) continue;
      items.push({
        key: `review:${repo}#${pr.number}`,
        kind: 'review',
        repo,
        number: pr.number,
        title: pr.title,
        url: `https://github.com/${repo}/pull/${pr.number}`,
        since: pr.createdAt,
        ageMs: pr.createdAt ? now - parseTime(pr.createdAt) : null,
      });
    }
  }
  return items.sort(bySince);
}

function bySince(a, b) {
  if (a.since == null || b.since == null) return a.since == null ? (b.since == null ? 0 : 1) : -1;
  return a.since.localeCompare(b.since) || String(a.key).localeCompare(String(b.key));
}

/**
 * The Needs-you list: audit items plus owner reviews, oldest first. A review of a
 * product-repo PR that already has an audit item isn't listed twice.
 */
export function combineNeedsYou(auditItems, reviews, sourceRepo) {
  const auditPrs = new Set((auditItems || []).map((i) => i.pr).filter(isNum));
  const extra = (reviews || []).filter((r) => !(r.repo === sourceRepo && auditPrs.has(r.number)));
  return [...(auditItems || []), ...extra].sort(bySince);
}

export const STAGE_LABELS = Object.freeze({
  ready: 'Ready', picked: 'Picked', running: 'Agent running', 'pr-open': 'PR open',
  checks: 'Checks', queued: 'Merge queue', merged: 'Merged, not yet deployed', deployed: 'Deployed',
});

// ---------------------------------------------------------------------------
// Dispatch state

/** Why the controller isn't dispatching, in words (planner.ts globalGate). */
export const PAUSE_TEXT = {
  kill_switch: 'factory off (kill switch)',
  budget_unknown: 'spend unknown',
  budget_pause: 'daily AI budget reached',
  busy_jobs_unknown: 'Actions load unknown',
  actions_busy: 'Actions busy',
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One token, so the banner stays within the glance line's 8-word budget.
function sinceText(ms, now) {
  const iso = new Date(ms).toISOString();
  return utcDay(ms) === utcDay(now) ? `${iso.slice(11, 16)}Z` : `${iso.slice(0, 16)}Z`;
}

/**
 * The banner for the controller's last recorded dispatch state, or null when it is running or
 * the window has no dispatch_state event. "Since" is the payload's `since` (the controller
 * carries it across re-records); without one, the first of the newest run of events with the
 * same state and reason (a changed unreadable-run count doesn't reset it).
 */
export function dispatchBanner(events, { now = Date.now() } = {}) {
  const states = (events || []).filter((ev) => ev?.type === 'dispatch_state' && parseTime(ev.timestamp) != null && isStr(ev.payload?.state));
  if (!states.length) return null;
  const last = states[states.length - 1];
  const p = last.payload;
  if (p.state === 'running') return null;
  let first = last;
  for (let i = states.length - 2; i >= 0; i--) {
    const q = states[i].payload;
    if (q.state !== p.state || q.reason !== p.reason) break;
    first = states[i];
  }
  // The controller carries `since` across re-records; older events fall back to the walk-back.
  const since = typeof p.since === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.since) && parseTime(p.since) <= parseTime(last.timestamp) ? p.since : first.timestamp;
  const sinceMs = parseTime(since);
  const n = isNum(p.unreadable_runs) ? p.unreadable_runs : 0;
  const spendUnknown = p.spend_known === false;
  const unreadable = n ? `, ${plural(n, 'unreadable run')}` : '';
  const ready = isNum(p.ready) ? p.ready : null;
  let level;
  let head;
  let why;
  if (p.state === 'paused') {
    level = 'warn';
    head = 'Paused';
    why = p.reason === 'budget_unknown' ? `spend unknown${unreadable}` : PAUSE_TEXT[p.reason] ?? 'unknown gate';
  } else if (p.state === 'waiting') {
    level = 'info';
    head = 'Waiting';
    why = `${ready == null ? 'work' : ready} ready, ${p.reason === 'deps' ? 'dependencies not merged' : 'held by limits'}`;
  } else if (p.state === 'idle') {
    level = 'info';
    head = 'Idle';
    why = spendUnknown ? 'nothing ready; spend unknown' : 'nothing ready';
  } else {
    return null;
  }
  const tip = [
    `The controller's last poll result: ${p.state}${p.reason && p.reason !== 'none' ? ` (${p.reason})` : ''}.`,
    `Ready ${ready ?? '?'}, in flight ${isNum(p.in_flight) ? p.in_flight : '?'}.`,
    spendUnknown ? `Spend unknown${n ? `: ${plural(n, 'run')} of today unreadable` : ''}.` : 'Spend known.',
    ...(p.state === 'waiting' ? [p.reason === 'deps' ? 'Waiting: ready work whose dependencies are not merged yet.' : 'Waiting: ready work held by the WIP, area or human-queue limits.'] : []),
    null, // the start line, filled in below once it's known how `since` is known
    `Last recorded ${last.timestamp}. The controller records the state when it changes, and daily.`,
    ...(p.dry_run === true ? ['Dry run: the controller logs decisions without acting.'] : []),
  ];
  // Only evidence (the cause's own time) or a seen transition says when it began; a first record
  // only says when the controller first noticed it.
  const sinceKnown = p.since_source === 'evidence' || p.since_source === 'transition';
  const when = sinceKnown ? `since ${sinceText(sinceMs, now)}` : `(recorded ${sinceText(sinceMs, now)})`;
  tip[tip.indexOf(null)] = sinceKnown
    ? `In this state since ${since}${p.since_source === 'evidence' ? ' (from the cause: when the first unreadable run of today ended)' : ''}.`
    : `First recorded ${since}; when it began is unknown (it was already in place).`;
  return { level, state: p.state, reason: p.reason ?? null, since, sinceKnown, text: `${head} ${when}: ${why}`, tip: tip.join('\n') };
}

// ---------------------------------------------------------------------------
// One-screen view: relative times, the task catalog and board, cost, quality, human touch,
// liveness and recent activity. Drill tasks (drill/*) were fire drills of the factory itself:
// they're kept out of every task aggregate.

export const MEDIAN_DAYS = 14;
export const HUMAN_DAYS = 7;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export const isDrill = (task) => typeof task === 'string' && task.startsWith('drill/');

/**
 * A relative time in the page's compact style (like "updated 12s ago"): "just now", "23m ago",
 * "5h ago", "3d ago"; "in 23m" for a future time; "—" when unknown.
 */
export function relativeTime(ms, now) {
  if (!isNum(ms) || !isNum(now)) return '—';
  const d = now - ms;
  const a = Math.abs(d);
  if (a < 45000) return 'just now';
  let t;
  if (a < HOUR_MS) t = `${Math.max(1, Math.floor(a / 60000))}m`;
  else if (a < 48 * HOUR_MS) t = `${Math.floor(a / HOUR_MS)}h`;
  else t = `${Math.floor(a / DAY_MS)}d`;
  return d >= 0 ? `${t} ago` : `in ${t}`;
}

/** A duration in at most two units: "45s", "42m", "5h 12m", "3d 4h"; "—" when unknown. */
export function shortDuration(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** AIC as dollars (1 AIC = $0.01): "$0.62", "$16.32", and whole dollars from $100 ("$100", "$1,234"). */
export function formatUsd(aic) {
  if (!isNum(aic)) return '—';
  const usd = aic / 100;
  return usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`;
}

// --- Task catalog: scripts/seed-backlog/taskmap.yaml and contracts/<id>.yaml -------------
// A deliberately small YAML reader for these generated files: top-level keys, flow maps and
// lists on one line, block lists and block maps of scalars. Anything else is ignored.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function yamlScalar(v) {
  const t = String(v ?? '').trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) return t.slice(1, -1);
  return t;
}

// Splits "a: b, c: { d, e }" at its top-level commas.
function splitFlow(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function flowMap(s) {
  const out = {};
  for (const part of splitFlow(s.trim().replace(/^\{/, '').replace(/\}$/, ''))) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const v = part.slice(i + 1).trim();
    out[part.slice(0, i).trim()] = /^[{[]/.test(v) ? null : yamlScalar(v); // nested values are skipped
  }
  return out;
}

function flowList(s) {
  return splitFlow(s.trim().replace(/^\[/, '').replace(/\]$/, '')).map(yamlScalar).filter(Boolean);
}

const yamlLines = (text) => String(text ?? '').split('\n').map((l) => stripComment(l.replace(/\r$/, '')).replace(/\s+$/, '')).filter((l) => l.trim());

/**
 * The tasks of the task map, in file order: [{ id, area }]. Entries may be flow maps
 * (`- { id: x, area: y }`) or block maps (`- id: x` then `area: y` on the following lines).
 */
export function parseTaskmap(text) {
  const tasks = [];
  let section = null;
  let itemIndent = null;
  let block = null; // the block-style entry being read: { keyIndent, fields }
  for (const line of yamlLines(text)) {
    const top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (top) {
      section = top[1];
      block = null;
      continue;
    }
    if (section !== 'tasks') continue;
    const indent = line.length - line.trimStart().length;
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item && (itemIndent == null || indent === itemIndent)) {
      itemIndent = indent;
      block = null;
      const body = item[2].trim();
      if (body.startsWith('{')) tasks.push(flowMap(body));
      else {
        const kv = /^([\w-]+):\s*(.*)$/.exec(body);
        if (kv) {
          block = { keyIndent: indent + 2, fields: { [kv[1]]: yamlScalar(kv[2]) } };
          tasks.push(block.fields);
        }
      }
      continue;
    }
    if (block && indent === block.keyIndent) {
      const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
      if (kv && !/^[>|]/.test(kv[2])) block.fields[kv[1]] = kv[2] === '' ? null : yamlScalar(kv[2]);
    }
  }
  return tasks.filter((t) => isStr(t.id)).map((t) => ({ id: t.id, area: isStr(t.area) ? t.area : null }));
}

const CONTRACT_FIELDS = { id: 'id', title: 'title', tier: 'tier', area: 'area', upstream_class: 'upstreamClass' };

/** The top-level fields of a generated contract: { id, title, tier, area, dependsOn, upstreamClass }. */
export function parseContract(text) {
  const out = { id: null, title: null, tier: null, area: null, dependsOn: [], upstreamClass: null };
  let inDeps = false;
  for (const line of yamlLines(text)) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      inDeps = false;
      const [, key, value] = top;
      if (key === 'depends_on') {
        if (value.startsWith('[')) out.dependsOn = flowList(value);
        else inDeps = value === '';
      } else if (CONTRACT_FIELDS[key] && value !== '') out[CONTRACT_FIELDS[key]] = yamlScalar(value);
      continue;
    }
    const dep = inDeps ? /^\s+-\s+(.+)$/.exec(line) : null;
    if (dep) out.dependsOn.push(yamlScalar(dep[1]));
  }
  return out;
}

/** "common/iso-format-parser" → "iso-format-parser": the area label carries the prefix. */
export function shortTaskName(id) {
  return String(id ?? '').split('/').pop();
}

export const AREA_LABELS = Object.freeze({
  'common-parsers': 'Common parsers',
  'common-refiners': 'Common refiners',
  'en-casual': 'Casual',
  'en-month-names': 'Months',
  'en-numeric-dates': 'Numeric',
  'en-relative': 'Relative',
  'en-refiners': 'English refiners',
  other: 'Other',
});

/** A readable group label for a contract area ("en-month-names" → "Month names"). */
export function areaLabel(area) {
  if (!isStr(area)) return AREA_LABELS.other;
  if (AREA_LABELS[area]) return AREA_LABELS[area];
  const words = area.replace(/^en-/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : AREA_LABELS.other;
}

/**
 * The tasks to show: the task map's entries joined with their contracts (a Map id → parsed
 * contract; a missing contract leaves tier and dependencies unknown). Drill tasks are dropped.
 */
export function taskCatalog(entries, contracts = new Map()) {
  return (entries || []).filter((e) => isStr(e?.id) && !isDrill(e.id)).map((e) => {
    const c = contracts.get(e.id) ?? null;
    return {
      id: e.id,
      short: shortTaskName(e.id),
      area: c?.area ?? e.area ?? 'other',
      tier: c?.tier ?? null,
      dependsOn: c?.dependsOn ?? [],
      title: c?.title ?? null,
      contract: c != null,
    };
  });
}

/** Without the task map: the non-drill tasks seen in the events, grouped by their prefix. */
export function fallbackCatalog(events) {
  const ids = [];
  for (const ev of events || []) {
    const t = ev?.payload?.task;
    if (isStr(t) && !isDrill(t) && !ids.includes(t)) ids.push(t);
  }
  return ids.map((id) => ({ id, short: shortTaskName(id), area: id.includes('/') ? `${id.split('/')[0]}-tasks` : 'other', tier: null, dependsOn: [], title: null, contract: false }));
}

// --- Task board ---------------------------------------------------------------------

// --- Task issues: GET /issues?state=all&labels=factory:task ---------------------------------

const TASK_MARKER = /<!--\s*factory-task:\s*([^\s>]+?)\s*-->/;
const TASK_TITLE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):\s/;

/**
 * The fields kept from one task-issue list entry: { task, number, state, stateReason, closedAt },
 * or null for a PR or an issue that names no task. The task id comes from the body's hidden
 * marker (<!-- factory-task: <id> -->), else the title prefix ("<id>: Port <Class>"). The body
 * isn't kept.
 */
export function summarizeTaskIssue(issue) {
  if (!issue || typeof issue !== 'object' || issue.pull_request != null || !isNum(issue.number)) return null;
  const task = TASK_MARKER.exec(typeof issue.body === 'string' ? issue.body : '')?.[1] ?? TASK_TITLE.exec(typeof issue.title === 'string' ? issue.title : '')?.[1] ?? null;
  if (!task) return null;
  return {
    task,
    number: issue.number,
    state: issue.state === 'closed' ? 'closed' : 'open',
    stateReason: isStr(issue.state_reason) ? issue.state_reason : null,
    closedAt: parseTime(issue.closed_at),
  };
}

/** Task id → { number, state, stateReason, closedAt } from summarized task issues; the newest issue wins. */
export function taskIssueMap(summaries) {
  const map = new Map();
  for (const s of summaries || []) {
    if (!s?.task) continue;
    const prev = map.get(s.task);
    if (!prev || s.number > prev.number) map.set(s.task, { number: s.number, state: s.state, stateReason: s.stateReason, closedAt: s.closedAt });
  }
  return map;
}


export const TASK_STATES = Object.freeze(['done', 'running', 'needs', 'waiting']);
export const TASK_STATE_LABELS = Object.freeze({ done: 'done', running: 'running', needs: 'needs you', waiting: 'waiting' });
const AGENT_EVENTS = new Set(['dispatched', 'repair_dispatched', 'review_dispatched']);
const REOPENS_TASK = new Set(['ready', 'auto_ready', 'dispatched', 'repair_dispatched']);
const STEP_TEXT = {
  ready: 'ready', auto_ready: 'ready', picked: 'picked', dispatched: 'implement agent running', repair_dispatched: 'repair agent running',
  review_dispatched: 'review agent running', pr_opened: 'PR open', check_result: 'checks', queued: 'in the merge queue', auto_merge: 'in the merge queue',
  dequeued: 'PR open', run_finished: 'agent finished',
};

/**
 * One tile per catalog task, in catalog order, each in one state:
 *
 * - done: a `merged` or `task_done` for the task, not followed by a reopening `ready`,
 *   `auto_ready`, `dispatched` or `repair_dispatched`;
 * - needs: an open Needs-you item for the task (`needsItems`, already filtered by dropClosed);
 * - running: work started (a real `dispatched`, `repair_dispatched` or `review_dispatched`) and
 *   not done, unless its issue or current PR is closed now (isClosedRef: never on an unknown
 *   open set, never for work newer than the snapshot);
 * - waiting: everything else: a dependency not done, ready but no free slot, not started, closed
 *   without a merge, or no events in the loaded window.
 *
 * Dry-run decisions are plans and never start or reopen a task. `since` is when the task
 * entered its state (ms), `issue` the task's issue number.
 *
 * `issues` (taskIssueMap(), or null when the task-issue list couldn't be read) takes precedence
 * over the audit window: an issue closed as "completed" is done even with no events loaded; an
 * issue closed otherwise is not done; while the issue is open, only a `task_done` (the
 * controller closing it) makes the task done, not a merge alone. Tasks without a known issue keep
 * the audit-derived state. The issue's number is the tile's link.
 */
export function taskBoard(events, catalog, { open = null, asOf = null, needsItems = [], issues = null } = {}) {
  const prTask = prTaskMap(events || []);
  const info = new Map((catalog || []).map((t) => [t.id, { issue: null, prs: [], pr: null, seen: false, readyAt: null, started: null, doneAt: null, taskDoneAt: null, step: null, stepAt: null }]));
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const p = ev.payload || {};
    const ids = [...eventSubjects(ev, prTask)].filter((s) => s.startsWith('task:')).map((s) => s.slice(5)).filter((id) => info.has(id));
    if (!ids.length) continue;
    const t = eventTime(ev);
    const plan = isPlanOnly(ev);
    for (const id of ids) {
      const s = info.get(id);
      s.seen = true;
      if (isNum(p.issue) && isStr(p.task)) s.issue = p.issue;
      for (const pr of eventPrs(ev)) if (!s.prs.includes(pr)) s.prs.push(pr);
      if (plan || t == null) continue;
      if (REOPENS_TASK.has(ev.type)) [s.doneAt, s.taskDoneAt] = [null, null];
      if (ev.type === 'ready' || ev.type === 'auto_ready') s.readyAt = t;
      if (AGENT_EVENTS.has(ev.type)) s.started ??= t;
      if (ev.type === 'dispatched') s.pr = null; // a new attempt has no PR yet
      if (isNum(p.pr) && ev.type !== 'merged') s.pr = p.pr;
      if (STEP_TEXT[ev.type]) [s.step, s.stepAt] = [STEP_TEXT[ev.type], t];
      if ((ev.type === 'merged' || ev.type === 'task_done') && s.doneAt == null) s.doneAt = t;
      if (ev.type === 'task_done') s.taskDoneAt ??= t;
    }
  }
  // The task issue, when known, decides done-ness (see above).
  for (const [id, s] of info) {
    const iss = issues instanceof Map ? issues.get(id) : null;
    s.issueState = iss ? (iss.state === 'closed' ? (iss.stateReason === 'completed' ? 'completed' : 'closed') : 'open') : null;
    if (!iss) continue;
    s.issue = iss.number;
    if (s.issueState === 'completed') s.doneAt = iss.closedAt ?? s.doneAt ?? s.taskDoneAt;
    else if (s.issueState === 'closed') s.doneAt = null;
    else s.doneAt = s.taskDoneAt;
  }
  const needsByTask = new Map();
  for (const it of needsItems || []) if (isStr(it?.task) && !needsByTask.has(it.task)) needsByTask.set(it.task, it);
  const doneIds = new Set([...info].filter(([, s]) => s.doneAt != null).map(([id]) => id));

  const tasks = (catalog || []).map((c) => {
    const s = info.get(c.id);
    const base = { ...c, issue: s.issue, prs: s.prs.slice(), step: s.step, issueState: s.issueState };
    if (s.issueState === 'completed') return { ...base, state: 'done', since: s.doneAt, reason: 'issue closed as completed' };
    if (s.doneAt != null) return { ...base, state: 'done', since: s.doneAt, reason: 'merged' };
    const need = needsByTask.get(c.id);
    if (need) return { ...base, state: 'needs', since: parseTime(need.since), reason: need.reason ?? need.kind ?? null };
    const closed = s.issueState === 'closed' || (s.started != null && isClosedRef({ issue: s.issue, pr: s.pr, at: s.stepAt }, open, asOf));
    if (s.started != null && !closed) return { ...base, state: 'running', since: s.stepAt ?? s.started, reason: s.step };
    const blockedBy = c.dependsOn.filter((d) => !doneIds.has(d));
    let reason;
    if (s.issueState === 'closed') reason = 'issue closed, not completed';
    else if (closed) reason = 'issue or PR closed without a merge';
    else if (blockedBy.length) reason = `waiting on ${blockedBy.map(shortTaskName).join(', ')}`;
    else if (s.readyAt != null) reason = 'ready, waiting for a free slot';
    else if (!s.seen) reason = 'no events in the loaded window';
    else reason = 'not started';
    return { ...base, state: 'waiting', since: s.readyAt ?? null, reason, blockedBy, ready: !closed && !blockedBy.length && s.readyAt != null };
  });

  const counts = Object.fromEntries(TASK_STATES.map((st) => [st, tasks.filter((t) => t.state === st).length]));
  const byTier = {};
  for (const t of tasks) {
    const tier = t.tier ?? 'unknown';
    byTier[tier] ??= { done: 0, total: 0 };
    byTier[tier].total++;
    if (t.state === 'done') byTier[tier].done++;
  }
  const groups = [];
  for (const t of tasks) {
    let g = groups.find((x) => x.area === t.area);
    if (!g) groups.push((g = { area: t.area, label: areaLabel(t.area), tasks: [] }));
    g.tasks.push(t);
  }
  return { tasks, counts, byTier, groups, total: tasks.length, readyWaiting: tasks.filter((t) => t.ready).length };
}

/** The newest dispatch_state payload with a usable timestamp, or null. */
export function latestDispatchState(events) {
  let last = null;
  for (const ev of events || []) if (ev?.type === 'dispatch_state' && parseTime(ev.timestamp) != null && isStr(ev.payload?.state)) last = ev.payload;
  return last;
}

// --- Medians over the last 14 days ---------------------------------------------------

/**
 * Issue → merged per non-drill task merged in the last `days` days: from the task's first real
 * `auto_ready` (else its first real `dispatched`) to its last `merged`; `days: Infinity` takes every
 * merge in the events, and `tasks` (a Set) keeps only those tasks. Returns
 * { medianMs, count, items: [{ task, ms }] }.
 */
export function issueToMerged(events, { now = Date.now(), days = MEDIAN_DAYS, tasks = null } = {}) {
  const from = now - days * DAY_MS;
  const per = new Map();
  const get = (t) => per.get(t) ?? per.set(t, { ready: null, dispatched: null, merged: null }).get(t);
  const prTask = prTaskMap(events || []);
  for (const ev of events || []) {
    const p = ev?.payload || {};
    const task = isStr(p.task) ? p.task : prTask.get(p.pr) ?? null;
    if (!task || isDrill(task) || isPlanOnly(ev)) continue;
    const t = eventTime(ev);
    if (t == null) continue;
    if (ev.type === 'auto_ready') get(task).ready ??= t;
    else if (ev.type === 'dispatched') get(task).dispatched ??= t;
    else if (ev.type === 'merged') get(task).merged = t;
  }
  const items = [];
  for (const [task, s] of per) {
    const start = s.ready ?? s.dispatched;
    if (start == null || s.merged == null || s.merged < from || s.merged > now || s.merged < start) continue;
    if (tasks && !tasks.has(task)) continue;
    items.push({ task, ms: s.merged - start });
  }
  return { medianMs: median(items.map((i) => i.ms)), count: items.length, items };
}

/**
 * "Where the time goes": stacked stage bars for the non-drill tasks merged in the last `days`
 * days (plain PRs without a task are left out), labelled with the short task name, and the
 * MEDIAN time per stage over those tasks (each stage's median among the tasks that went
 * through it). `rows` come from stageTimes(). The insight names the stage with the largest
 * median.
 */
export function stageSummary(rows, { now = Date.now(), days = MEDIAN_DAYS } = {}) {
  const from = now - days * DAY_MS;
  const out = [];
  for (const r of rows || []) {
    if (!String(r?.key).startsWith('task:') || isDrill(r.key.slice(5))) continue;
    const merged = r.reached?.merged;
    if (!isNum(merged) || merged < from || merged > now) continue;
    const segments = [];
    for (const st of STAGES) {
      const d = r.durations?.[st];
      if (d && isNum(d.ms) && d.ms > 0) segments.push({ stage: st, ms: d.ms, to: d.to });
    }
    const totalMs = segments.reduce((a, s) => a + s.ms, 0);
    if (totalMs > 0) out.push({ key: r.key, task: r.key.slice(5), label: shortTaskName(r.key.slice(5)), segments, totalMs, mergedAt: merged });
  }
  out.sort((a, b) => a.mergedAt - b.mergedAt);
  const segments = [];
  for (const st of STAGES) {
    const values = out.map((r) => r.segments.find((s) => s.stage === st)?.ms).filter(isNum);
    if (values.length) segments.push({ stage: st, ms: median(values), tasks: values.length });
  }
  const totalMs = segments.reduce((a, s) => a + s.ms, 0);
  const med = out.length ? { key: 'median', label: 'Median', segments, totalMs } : null;
  let insight = null;
  if (totalMs > 0) {
    const top = segments.slice().sort((a, b) => b.ms - a.ms)[0];
    insight = { stage: top.stage, label: STAGE_LABELS[top.stage], pct: (top.ms / totalMs) * 100, ms: top.ms, tasks: out.length };
  }
  return { rows: out, median: med, maxMs: Math.max(0, totalMs, ...out.map((r) => r.totalMs)), insight, days };
}

// --- Cost: spend snapshots (full cost) joined to tasks through the gh-aw Outcomes snapshot -----

export const AGENT_WORKFLOWS = Object.freeze(['implement', 'repair', 'review']);

/**
 * The latest measured value per run id across the real (`dry_run: false`) spend snapshots, in
 * log order: Map run_id → { aic, status, day, at }. A "reserved" entry is a placeholder for a run
 * still going, not a measurement, so it never replaces one; `reservedOnly` lists the runs that
 * were never measured.
 */
export function runSpend(events) {
  const measured = new Map();
  const seen = new Set();
  for (const ev of events || []) {
    if (ev?.type !== 'spend_snapshot' || ev.payload?.dry_run !== false) continue;
    const p = ev.payload;
    const at = parseTime(ev.timestamp);
    for (const r of Array.isArray(p.runs) ? p.runs : []) {
      if (!isNum(r?.run_id) || !isNum(r.aic)) continue;
      seen.add(r.run_id);
      if (r.status === 'reserved') continue;
      measured.set(r.run_id, { aic: r.aic, status: isStr(r.status) ? r.status : 'measured', day: isStr(p.day) ? p.day : at == null ? null : utcDay(at), at });
    }
  }
  return { measured, reservedOnly: [...seen].filter((id) => !measured.has(id)), seen };
}

/**
 * The full cost per task: every run's latest measured AI credits from the spend snapshots (agent
 * plus threat detection), joined by run id to the runs of the newest gh-aw Outcomes snapshot
 * (`outcomeRuns`: its normalized `runs`, or null without one). A run is a safety drill when the
 * snapshot says so (or its task is drill/*); a run the snapshot doesn't list, or that names no
 * task (review runs today), counts as real work not tied to a task.
 *
 * Returns { known (a snapshot was given), total, perTask: [{ task, aic, runs }] (non-drill, highest
 * first), drillAic, unattributed, unattributedRuns, perDay: { days, aic }, byWorkflow: { implement,
 * repair, review, unknown: { runs, measured, aic } }, unknownRunIds, measuredRuns, agentAic: { real,
 * drills } (gh-aw's agent-only figures of the same runs) }. `total` is every measured run.
 */
export function costJoin(events, outcomeRuns, { now = Date.now(), days = MEDIAN_DAYS } = {}) {
  const { measured } = runSpend(events);
  const known = Array.isArray(outcomeRuns);
  const byId = new Map((known ? outcomeRuns : []).filter((r) => isNum(r?.runId)).map((r) => [r.runId, r]));
  const byWorkflow = Object.fromEntries([...AGENT_WORKFLOWS, 'unknown'].map((w) => [w, { runs: 0, measured: 0, aic: 0 }]));
  for (const r of byId.values()) if (byWorkflow[r.workflow]) byWorkflow[r.workflow].runs++;
  const perTask = new Map();
  let total = 0;
  let drillAic = 0;
  let unattributed = 0;
  let unattributedRuns = 0;
  const agentAic = { real: 0, drills: 0 };
  const unknownRunIds = [];
  const end = Date.parse(utcDay(now) + 'T00:00:00Z');
  const dayLabels = [];
  for (let i = days - 1; i >= 0; i--) dayLabels.push(utcDay(end - i * DAY_MS));
  const dayIndex = new Map(dayLabels.map((d, i) => [d, i]));
  const perDay = dayLabels.map(() => 0);

  for (const [id, m] of measured) {
    total += m.aic;
    const di = dayIndex.get(m.day);
    if (di != null) perDay[di] += m.aic;
    const run = byId.get(id);
    const wf = run && byWorkflow[run.workflow] ? run.workflow : 'unknown';
    byWorkflow[wf].measured++;
    byWorkflow[wf].aic += m.aic;
    if (!run) unknownRunIds.push(id);
    const drill = !!run && (run.drill === true || isDrill(run.task));
    if (run && isNum(run.aic)) agentAic[drill ? 'drills' : 'real'] += run.aic;
    if (drill) drillAic += m.aic;
    else if (run && isStr(run.task)) {
      const row = perTask.get(run.task) ?? perTask.set(run.task, { task: run.task, aic: 0, runs: 0 }).get(run.task);
      row.aic += m.aic;
      row.runs++;
    } else {
      unattributed += m.aic;
      unattributedRuns++;
    }
  }
  return {
    known,
    total,
    perTask: [...perTask.values()].sort((a, b) => b.aic - a.aic || a.task.localeCompare(b.task)),
    drillAic,
    unattributed,
    unattributedRuns,
    perDay: { days: dayLabels, aic: perDay },
    byWorkflow,
    unknownRunIds,
    measuredRuns: measured.size,
    agentAic,
  };
}

/** Median AIC over the given (done) tasks that have attributed cost: { medianAic, count }. */
export function medianTaskCost(cost, taskIds) {
  const want = new Set(taskIds || []);
  const values = (cost?.perTask ?? []).filter((r) => want.has(r.task)).map((r) => r.aic);
  return { medianAic: median(values), count: values.length };
}

// --- Quality and human touch ---------------------------------------------------------

/**
 * Quality over the loaded window, drills excluded: `reverts`, the real `auto_revert` events, and
 * `objections`, the real `needs_human` with reason "review_objected" (the reviewer agent blocked a
 * change before merge).
 */
export function qualityStats(events) {
  const list = (events || []).filter((e) => e && typeof e === 'object');
  const prTask = prTaskMap(list);
  const taskOf = (ev) => (isStr(ev.payload?.task) ? ev.payload.task : prTask.get(ev.payload?.pr) ?? null);
  let reverts = 0;
  let objections = 0;
  for (const ev of list) {
    if (isPlanOnly(ev) || isDrill(taskOf(ev))) continue;
    if (ev.type === 'auto_revert') reverts++;
    if (ev.type === 'needs_human' && ev.payload?.reason === 'review_objected') objections++;
  }
  return { reverts, objections };
}

const isBot = (actor) => /\[bot\]$/.test(String(actor ?? ''));

/**
 * Human touch: `human_action` events in the last `days` days by action (reviews and others),
 * plus PRs a person put in the merge queue (`queued` by an actor that isn't a [bot]); and the
 * median time from a non-drill `needs_human` to its resolution: the next real event for the same
 * task, PR or issue that resolves a Needs-you item (ready, dispatched, human_action, merged, …)
 * or closes the task (`task_done`), over the loaded window.
 */
export function humanTouch(events, { now = Date.now(), days = HUMAN_DAYS } = {}) {
  const list = (events || []).filter((e) => e && typeof e === 'object');
  const from = now - days * DAY_MS;
  const inWindow = (ev) => {
    const t = eventTime(ev);
    return t != null && t >= from && t <= now;
  };
  let reviews = 0;
  let other = 0;
  let enqueues = 0;
  for (const ev of list) {
    if (!inWindow(ev)) continue;
    if (ev.type === 'human_action') {
      if (ev.payload?.action === 'review') reviews++;
      else other++;
    } else if (ev.type === 'queued' && isStr(ev.payload?.actor) && !isBot(ev.payload.actor)) enqueues++;
  }
  const prTask = prTaskMap(list);
  const durations = [];
  let open = 0;
  list.forEach((ev, i) => {
    if (ev.type !== 'needs_human' || isPlanOnly(ev)) return;
    const task = isStr(ev.payload?.task) ? ev.payload.task : null;
    if (isDrill(task)) return;
    const start = parseTime(ev.timestamp);
    if (start == null) return;
    const subjects = eventSubjects(ev, prTask);
    const end = list.slice(i + 1).find((x) => (RESOLVES_NEEDS_YOU.has(x.type) || x.type === 'task_done') && !isPlanOnly(x)
      && [...eventSubjects(x, prTask)].some((s) => subjects.has(s)));
    const t = end ? eventTime(end) : null;
    if (t != null && t >= start) durations.push(t - start);
    else open++;
  });
  return { total: reviews + other + enqueues, reviews, other, enqueues, days, medianResolveMs: median(durations), resolved: durations.length, unresolved: open };
}

// --- Liveness ------------------------------------------------------------------------

// Events only the controller writes, on its polls.
const POLL_TYPES = new Set([
  'heartbeat', 'spend_snapshot', 'dispatch_state', 'dispatched', 'repair_dispatched', 'review_dispatched', 'auto_ready', 'auto_merge',
  'needs_human', 'task_done', 'handoff_done', 'auto_revert', 'main_ci_rerun', 'ready', 'picked', 'stale_contract', 'cancelled',
]);
export const FOLLOW_UP_MIN = 10;

/**
 * The controller's last poll (the newest heartbeat or other controller event) and when the next
 * is expected: with work in flight or dispatch paused by a gate (not the kill switch), the
 * follow-up chain polls again about 10 min after the last poll; otherwise, or when that time
 * has passed without a poll, the next scheduled (hourly) run: the next full hour after the later
 * of the last poll and now. Returns { lastAt, lastType, nextAt, mode: 'follow-up' | 'cron' | null,
 * followUpMissed }.
 */
export function liveness(events, { now = Date.now(), inFlight = false, dispatch = null } = {}) {
  let last = null;
  for (const ev of events || []) {
    if (!POLL_TYPES.has(ev?.type)) continue;
    const t = parseTime(ev.timestamp);
    if (t != null && (last == null || t >= last.at)) last = { at: t, type: ev.type };
  }
  if (!last) return { lastAt: null, lastType: null, nextAt: null, mode: null, followUpMissed: false };
  const ds = dispatch ?? latestDispatchState(events);
  const pausedByGate = ds?.state === 'paused' && isStr(ds.reason) && ds.reason !== 'kill_switch';
  const chain = inFlight || (isNum(ds?.in_flight) && ds.in_flight > 0) || pausedByGate;
  if (chain) {
    const next = last.at + FOLLOW_UP_MIN * 60000;
    if (next >= now) return { lastAt: last.at, lastType: last.type, nextAt: next, mode: 'follow-up', followUpMissed: false };
  }
  const base = Math.max(last.at, now);
  return { lastAt: last.at, lastType: last.type, nextAt: Math.floor(base / HOUR_MS) * HOUR_MS + HOUR_MS, mode: 'cron', followUpMissed: chain };
}

// --- Recent activity -----------------------------------------------------------------

// Noise, or the same fact as a neighbouring event (task_done ~ merged, auto_merge ~ queued).
const RECENT_SKIP = new Set(['heartbeat', 'spend_snapshot', 'dispatch_state', 'dequeued', 'task_done', 'handoff_done', 'auto_merge', 'run_started']);
const RECENT_VERB = {
  merged: () => 'merged',
  pr_opened: () => 'PR opened',
  dispatched: (p) => (isNum(p.attempt) && p.attempt > 1 ? `started, attempt ${p.attempt}` : 'started'),
  repair_dispatched: () => 'repairing',
  review_dispatched: () => 'in review',
  needs_human: () => 'needs you',
  stale_contract: () => 'contract changed',
  auto_ready: () => 'ready',
  ready: () => 'ready',
  picked: () => 'picked',
  queued: (p) => (isStr(p.actor) && !isBot(p.actor) ? 'queued by hand' : 'queued'),
  human_action: (p) => (p.action === 'review' ? 'reviewed' : isStr(p.action) ? p.action : 'touched by a person'),
  check_result: (p) => `${isStr(p.workflow) ? p.workflow : 'check'} failed${p.event === 'push' ? ' on main' : ''}`,
  auto_revert: () => 'reverted',
  main_ci_rerun: () => 'main CI re-run',
  cancelled: () => 'cancelled',
  deployed: () => 'deployed',
  run_finished: () => 'agent finished',
};

/**
 * The newest `limit` meaningful events as short sentences, newest first, ONE line per subject
 * (its latest event), so the lines cover different tasks: [{ text, at, type, task, issue, pr }],
 * e.g. "#29 iso-format-parser merged". The subject is the task, else the PR, else the sentence
 * itself (e.g. "ci failed on main"). The reference is the task's issue (else the PR). Skips
 * heartbeats, spend snapshots, dispatch states, dequeues, dry-run plans, passing checks and
 * bookkeeping duplicates (task_done, handoff_done, auto_merge).
 */
export function recentActivity(events, { limit = 5 } = {}) {
  const list = (events || []).filter((e) => e && typeof e === 'object');
  const prTask = prTaskMap(list);
  const issueOf = new Map();
  for (const ev of list) if (isStr(ev.payload?.task) && isNum(ev.payload?.issue)) issueOf.set(ev.payload.task, ev.payload.issue);
  const out = [];
  const seen = new Set();
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const ev = list[i];
    const p = ev.payload || {};
    const verb = RECENT_VERB[ev.type];
    if (!verb || RECENT_SKIP.has(ev.type) || isPlanOnly(ev)) continue;
    if (ev.type === 'check_result' && p.conclusion !== 'failure') continue;
    const pr = eventPrs(ev)[0] ?? null;
    const task = isStr(p.task) ? p.task : prTask.get(pr) ?? null;
    const issue = isNum(p.issue) ? p.issue : task ? issueOf.get(task) ?? null : null;
    const ref = issue ?? pr;
    const text = [ref != null ? `#${ref}` : null, task ? shortTaskName(task) : null, verb(p)].filter(Boolean).join(' ');
    const subject = task ? `task:${task}` : pr != null ? `pr:${pr}` : `text:${text}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    out.push({ text, at: eventTime(ev), type: ev.type, task, issue, pr });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The results scoreboard and the status line. Builders return "segments", so the page can render
// each number and link as its own inline-block run and the tests can read the sentence:
//   { t: 'text', text } · { t: 'big', text } (the sentence's one big number) · { t: 'num', text }
//   · { t: 'link', text, href } · { t: 'time', at } (a relative time) · { t: 'sep' } (" · ")

export const SOURCE_REPO = 'sabbasi3-factory-lab/chrono-node-rs';
export const JOURNAL_URL = 'https://github.com/sabbasi3-factory-lab/factory/blob/main/docs/JOURNAL.md';
const ghIssue = (n) => `https://github.com/${SOURCE_REPO}/issues/${n}`;
const ghPull = (n) => `https://github.com/${SOURCE_REPO}/pull/${n}`;
const T = (text) => ({ t: 'text', text });
const NUM = (text) => ({ t: 'num', text });
const BIG = (text) => ({ t: 'big', text });
const SEP = { t: 'sep' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The plain text of segments (relative times against `now`), as a person reads it. */
export function segText(segs, now = Date.now()) {
  let out = '';
  for (const s of segs || []) {
    const text = s.t === 'sep' ? '·' : s.t === 'time' ? relativeTime(s.at, now) : s.text;
    if (!out || /^[,.:;)]/.test(text) || out.endsWith('(')) out += text;
    else out += ` ${text}`;
  }
  return out;
}

/** "Oct 22" (UTC) from epoch ms or "YYYY-MM-DD"; "—" when unknown. */
export function shortDate(value) {
  const ms = typeof value === 'string' ? Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value) : value;
  if (!isNum(ms)) return '—';
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A typical duration in plain words: "9 min" up to 90 minutes, then "2.5 hours". */
export function plainDuration(ms) {
  if (!isNum(ms) || ms < 0) return '—';
  const min = ms / 60000;
  if (min < 90) return `${Math.max(1, Math.round(min))} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** The earliest day ("YYYY-MM-DD") of a real spend snapshot, or null. */
export function earliestSpendDay(events) {
  let first = null;
  for (const ev of events || []) {
    const p = ev?.payload;
    if (ev?.type === 'spend_snapshot' && p?.dry_run === false && isStr(p.day) && /^\d{4}-\d{2}-\d{2}$/.test(p.day) && (first == null || p.day < first)) first = p.day;
  }
  return first;
}

// --- Static files deployed with the page: build-cost.json and drills.json --------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v) => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
};
const keyProblems = (obj, required, optional = []) => {
  const keys = Object.keys(obj);
  const missing = required.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !required.includes(k) && !optional.includes(k));
  return [missing.length ? `missing ${missing.join(', ')}` : null, extra.length ? `unexpected ${extra.join(', ')}` : null].filter(Boolean);
};
const plainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * build-cost.json: exactly { ai_units, usd, as_of, source }. Strict: extra keys are rejected (a
 * renamed field must not be silently ignored); ai_units and usd are finite numbers ≥ 0, as_of a
 * real "YYYY-MM-DD" date, source a non-empty string. Returns { ok: true, value: { aiUnits, usd,
 * asOf, source } } or { ok: false, error }.
 */
export function validateBuildCost(data) {
  if (!plainObject(data)) return { ok: false, error: 'not a JSON object' };
  const errors = keyProblems(data, ['ai_units', 'usd', 'as_of', 'source']);
  for (const k of ['ai_units', 'usd']) if (k in data && !(isNum(data[k]) && data[k] >= 0)) errors.push(`${k} is not a number ≥ 0`);
  if ('as_of' in data && !validDay(data.as_of)) errors.push('as_of is not a YYYY-MM-DD date');
  if ('source' in data && !isStr(data.source)) errors.push('source is not a non-empty string');
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, value: { aiUnits: data.ai_units, usd: data.usd, asOf: data.as_of, source: data.source } };
}

/**
 * drills.json: exactly { as_of, source, defects_found_and_fixed, runs }, runs a non-empty list of
 * { id, result: "pass" | "fail", note? } with unique ids. Strict like build-cost.json. Returns
 * { ok: true, value: { asOf, source, defects, runs }, passed, total } or { ok: false, error }.
 */
export function validateDrills(data) {
  if (!plainObject(data)) return { ok: false, error: 'not a JSON object' };
  const errors = keyProblems(data, ['as_of', 'source', 'defects_found_and_fixed', 'runs']);
  if ('as_of' in data && !validDay(data.as_of)) errors.push('as_of is not a YYYY-MM-DD date');
  if ('source' in data && !isStr(data.source)) errors.push('source is not a non-empty string');
  if ('defects_found_and_fixed' in data && !(Number.isSafeInteger(data.defects_found_and_fixed) && data.defects_found_and_fixed >= 0)) errors.push('defects_found_and_fixed is not an integer ≥ 0');
  if ('runs' in data) {
    if (!Array.isArray(data.runs) || !data.runs.length) errors.push('runs is not a non-empty list');
    else {
      const ids = new Set();
      data.runs.forEach((r, i) => {
        if (!plainObject(r)) return errors.push(`runs[${i}] is not an object`);
        for (const e of keyProblems(r, ['id', 'result'], ['note'])) errors.push(`runs[${i}]: ${e}`);
        if (!isStr(r.id)) errors.push(`runs[${i}].id is not a non-empty string`);
        else if (ids.has(r.id)) errors.push(`runs[${i}].id ${r.id} is repeated`);
        else ids.add(r.id);
        if (r.result !== 'pass' && r.result !== 'fail') errors.push(`runs[${i}].result is not "pass" or "fail"`);
        if ('note' in r && typeof r.note !== 'string') errors.push(`runs[${i}].note is not a string`);
        return null;
      });
    }
  }
  if (errors.length) return { ok: false, error: errors.join('; ') };
  const runs = data.runs.map((r) => ({ id: r.id, result: r.result, note: r.note ?? null }));
  return { ok: true, value: { asOf: data.as_of, source: data.source, defects: data.defects_found_and_fixed, runs }, passed: runs.filter((r) => r.result === 'pass').length, total: runs.length };
}

// --- Human steps after go-live -------------------------------------------------------------------

const REVIEW_ACTIONS = new Set(['review', 'comment', 'comments', 'commented']);
const HUMAN_KIND = {
  enqueue: 'put an agent PR in the merge queue',
  label: 'changed labels on a factory task',
  push: 'pushed to an agent PR',
  dispatch: 'started an agent run by hand',
};

/**
 * Hands-on steps a person took after go-live, the first real dispatch of a real (non-drill) task:
 * - `queued` by an actor that isn't a [bot], on an agent PR (one whose `pr_opened` author is a
 *   [bot], or that a task event names) → "enqueue";
 * - `human_action` with an action other than a review or comment, on an agent PR or a factory task
 *   (a task, or an issue a task event names) → its action ("label", "push", "dispatch", …).
 * Plain reviews and comments, and anything on other PRs (the coordinator's own, under the shared
 * account), don't count. Returns { goLive, steps: [{ at, kind, what, pr, issue, task, actor }],
 * byKind: { kind: n }, total }.
 */
export function humanSteps(events) {
  const list = (events || []).filter((e) => e && typeof e === 'object');
  const prTask = prTaskMap(list);
  const authors = new Map();
  const issueTask = new Map();
  let goLive = null;
  for (const ev of list) {
    const p = ev.payload || {};
    if (ev.type === 'pr_opened' && isNum(p.pr)) authors.set(p.pr, p.author);
    if (isStr(p.task) && isNum(p.issue)) issueTask.set(p.issue, p.task);
    if (goLive == null && ev.type === 'dispatched' && isStr(p.task) && !isDrill(p.task) && !isPlanOnly(ev)) goLive = parseTime(ev.timestamp);
  }
  const agentPr = (pr) => isNum(pr) && (prTask.has(pr) || isBot(authors.get(pr)));
  const steps = [];
  if (goLive != null) {
    for (const ev of list) {
      const p = ev.payload || {};
      const t = parseTime(ev.timestamp);
      if (t == null || t < goLive) continue;
      let kind = null;
      if (ev.type === 'queued' && isStr(p.actor) && !isBot(p.actor) && agentPr(p.pr)) kind = 'enqueue';
      else if (ev.type === 'human_action' && isStr(p.action) && !REVIEW_ACTIONS.has(p.action.toLowerCase())
        && (agentPr(p.pr) || isStr(p.task) || issueTask.has(p.issue))) kind = p.action.toLowerCase();
      if (!kind) continue;
      const task = isStr(p.task) ? p.task : prTask.get(p.pr) ?? issueTask.get(p.issue) ?? null;
      steps.push({ at: eventTime(ev), kind, what: HUMAN_KIND[kind] ?? `${kind} (by hand)`, pr: isNum(p.pr) ? p.pr : null, issue: isNum(p.issue) ? p.issue : null, task, actor: p.actor ?? p.reviewer ?? null });
    }
  }
  const byKind = {};
  for (const s of steps) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  return { goLive, steps, byKind, total: steps.length };
}

/** A controller reason code in plain words: "review_objected" → "the reviewer objected". */
export function plainReason(reason) {
  const known = {
    review_objected: 'the reviewer objected',
    repeated_signature: 'the same failure repeated',
    'same-failure-signature': 'the same failure repeated',
    implement_no_pr: 'the agent opened no PR',
    implement_failed: 'the agent run failed',
    repair_no_push: 'the repair changed nothing',
    repair_failed: 'the repair failed',
    gates_failed: 'the strict gates failed',
    main_regressed: 'main broke after the merge',
    'contract-changed': 'its contract changed',
  };
  if (!isStr(reason)) return null;
  return known[reason] ?? reason.replace(/[_-]+/g, ' ');
}

// --- Status line --------------------------------------------------------------------------------

const PAUSE_PLAIN = {
  budget_pause: 'daily AI budget reached',
  budget_unknown: "today's AI spend can't be measured",
  busy_jobs_unknown: 'GitHub Actions load unknown',
  actions_busy: 'GitHub Actions busy',
};

/** One health problem (healthSummary().problems item) in plain words, as segments. */
export function plainProblem(problem, { heartbeatAt = null } = {}) {
  const code = problem?.code ?? '';
  if (code === 'hb-stale' || code === 'hb-late') return heartbeatAt != null ? [T('last check-in'), { t: 'time', at: heartbeatAt }] : [T('check-in late')];
  if (code === 'hb-none') return [T('no check-in from the factory')];
  if (code === 'hb-unknown') return [T('last check-in unknown')];
  if (code === 'verifier:verifier-not-set-up') return [T("independent audit check isn't set up")];
  if (code === 'verifier:verifier-late' || code === 'verifier:verifier-stale') return [T('independent audit check is late')];
  if (code.startsWith('verifier:')) return [T("can't read the independent audit check")];
  const text = {
    'no-log': 'no audit log yet',
    'load-failed': "can't load the audit log",
    'refresh-failed': "can't refresh the data",
    'data-stale': 'the data here is out of date',
    'chain-broken': 'the audit log failed its integrity check',
    'chain-unverified': "the audit log isn't verified yet",
  }[code];
  return [T(text ?? 'something is wrong')];
}

/**
 * The status line after the health chip: { state: { level, segs }, needs: { level, segs } }.
 * State: the worst health problem in plain words; else "switched off"; else the pause reason;
 * else "working on N tasks:" with links; else "idle". Needs: "nothing needs you", or "N tasks need
 * you:" with linked refs (#28, #33; the first 3, then "+N"), "checking reviews…" or "review list
 * unavailable" while the PR lists aren't known.
 */
export function statusParts({ health = null, heartbeatAt = null, killSwitch = null, board = null, banner = null, needsItems = [], reviews = 'ok' } = {}) {
  let state;
  const problems = (health?.problems ?? []).filter((p) => p.code !== 'paused');
  if (problems.length) state = { level: problems[0].level, segs: plainProblem(problems[0], { heartbeatAt }) };
  else if (killSwitch === false) state = { level: 'info', segs: [T('switched off')] };
  else if (banner?.state === 'paused' && banner.reason !== 'kill_switch') state = { level: 'warn', segs: [T(PAUSE_PLAIN[banner.reason] ?? 'held by a safety gate')] };
  else if (board?.counts?.running) {
    const running = board.tasks.filter((x) => x.state === 'running');
    const links = running.slice(0, 3).flatMap((x, i) => [...(i ? [T(',')] : []), x.issue != null ? { t: 'link', text: x.short, href: ghIssue(x.issue) } : T(x.short)]);
    state = { level: 'ok', segs: [T(`working on ${plural(running.length, 'task')}:`), ...links, ...(running.length > 3 ? [T(`+${running.length - 3}`)] : [])] };
  } else state = { level: 'ok', segs: [T('idle')] };

  let needs;
  const items = needsItems || [];
  if (items.length) {
    const word = items.every((i) => i.kind !== 'review') ? 'task' : 'item';
    const ref = (i) => (i.kind === 'review' ? { text: i.repo === SOURCE_REPO ? `#${i.number}` : `${String(i.repo).split('/').pop()}#${i.number}`, href: i.url }
      : i.issue != null ? { text: `#${i.issue}`, href: ghIssue(i.issue) } : i.pr != null ? { text: `#${i.pr}`, href: ghPull(i.pr) } : { text: i.task ?? '?', href: null });
    const links = items.slice(0, 3).flatMap((i, k) => {
      const r = ref(i);
      return [...(k ? [T(',')] : []), r.href ? { t: 'link', text: r.text, href: r.href } : T(r.text)];
    });
    needs = { level: 'warn', segs: [T(`${plural(items.length, word)} need${items.length === 1 ? 's' : ''} you:`), ...links, ...(items.length > 3 ? [T(`+${items.length - 3}`)] : [])] };
  } else if (reviews === 'pending') needs = { level: 'info', segs: [T('checking reviews…')] };
  else if (reviews === 'unavailable') needs = { level: 'warn', segs: [T('review list unavailable')] };
  else needs = { level: 'ok', segs: [T('nothing needs you')] };
  return { state, needs };
}

// --- The five scoreboard sentences ----------------------------------------------------------------

const TIER_WORD = { auto: 'routine', 'auto-strict': 'core' };

/**
 * "Shipped: 26 of 26 tasks" / "18 routine + 8 core" / "gh-aw
 * Outcomes: 26 PRs accepted, 1 rejected, 0 pending" (real work; `outcomes` is outcomesSummary(),
 * or null without a snapshot).
 */
export function shippedItem(board, outcomes = null) {
  const done = board?.counts?.done ?? 0;
  const total = board?.total ?? 0;
  const tiers = Object.entries(board?.byTier ?? {}).sort(([a], [b]) => (a === 'auto' ? -1 : b === 'auto' ? 1 : a.localeCompare(b)));
  const parts = tiers.flatMap(([tier, x], i) => [...(i ? [T('+')] : []), NUM(`${x.done} ${TIER_WORD[tier] ?? (tier === 'unknown' ? 'other' : tier)}`)]);
  const p = outcomes?.real?.prs;
  const line = p
    ? [T('gh-aw Outcomes:'), NUM(`${p.accepted} PR${p.accepted === 1 ? '' : 's'} accepted`), T(','), NUM(`${p.rejected} rejected`), T(','), NUM(`${p.pending} pending`)]
    : [T('gh-aw Outcomes not available yet')];
  return {
    key: 'shipped',
    main: [T('Shipped:'), BIG(`${done} of ${total}`), T(total === 1 ? 'task' : 'tasks')],
    subs: [...(total ? [parts] : []), line],
  };
}

/**
 * "Speed: about 9 min per task" / "Oct 22 → Oct 27". With done tasks but no start-to-merge times
 * in the log, the timing is "unavailable" (never "no task merged yet").
 */
export function speedItem({ medianMs = null, count = 0, firstAt = null, lastAt = null, done = 0 } = {}) {
  if (!count || medianMs == null) return { key: 'speed', main: [T('Speed:'), BIG('—'), T(done ? 'timing unavailable' : 'no task merged yet')], subs: [] };
  return {
    key: 'speed',
    main: [T('Speed: about'), BIG(plainDuration(medianMs)), T('per task')],
    subs: firstAt != null && lastAt != null ? [dateSpan(firstAt, lastAt)] : [],
  };
}

/** "Oct 22 → Nov 2", "Oct 22 → 27" within one month, or "Oct 22" for one day. */
function dateSpan(a, b) {
  const [x, y] = [shortDate(a), shortDate(b)];
  if (x === y) return [NUM(x)];
  const [mx, my] = [x.split(' ')[0], y.split(' ')[0]];
  return [NUM(x), T('→'), NUM(mx === my ? y.slice(my.length + 1) : y)];
}

/**
 * "Total cost: about $1,126" / "= $1,110 one-time build + $16.32 running" /
 * "$11.42 tasks + $4.89 drills · about $0.44 per accepted PR". Without drill cost the per-PR
 * clause joins the second line (real tasks are then the whole run cost). `build` is a
 * validateBuildCost() result; `cost` a costJoin() result: the run total always counts (it's the
 * spend snapshots); the real/drill split and the per-PR cost need the Outcomes snapshot
 * (`cost.known`) and `acceptedPrs`, the real PRs it accepted. Run cost not tied to a task counts
 * as real tasks.
 */
export function costItem({ build = null, cost = null, acceptedPrs = null } = {}) {
  const b = build?.ok ? build.value : null;
  const run = cost ? cost.total : null;
  const drills = cost?.drillAic ?? 0;
  const real = cost ? cost.total - drills : null;
  const perPr = cost?.known && acceptedPrs ? real / acceptedPrs : null;
  const known = cost?.known && cost.measuredRuns;
  const per = perPr != null ? [SEP, T('about'), NUM(formatUsd(perPr)), T('per accepted PR')] : [];
  const split = known && (drills > 0 || !b)
    ? [NUM(formatUsd(real)), T('tasks'), ...(drills > 0 ? [T('+'), NUM(formatUsd(drills)), T('drills')] : []), ...per]
    : null;
  if (b && run != null) {
    return {
      key: 'cost',
      main: [T('Total cost: about'), BIG(formatUsd(b.usd * 100 + run))],
      subs: [[T('='), NUM(formatUsd(b.usd * 100)), T('one-time build +'), NUM(formatUsd(run)), T('running'), ...(known && !split ? per : [])], ...(split ? [split] : [])],
      perPr,
    };
  }
  if (b) return { key: 'cost', main: [T('Total cost: about'), BIG(formatUsd(b.usd * 100))], subs: [[T('='), NUM(formatUsd(b.usd * 100)), T('one-time build'), SEP, T('running cost not available right now')]], perPr };
  if (run != null) return { key: 'cost', main: [T('Running cost: about'), BIG(formatUsd(run))], subs: split ? [split] : [], perPr };
  return { key: 'cost', main: [T('Total cost:'), BIG('—'), T('not available right now')], subs: [], perPr };
}

/**
 * "Hands-off: 25 of 26 PRs merged with no human edits (gh-aw zero-touch)" / "2 manual steps after
 * go-live" (ours, linked to the list; the human effort outside the PR). `outcomes` is outcomesSummary() or null.
 */
export function handsOffItem(outcomes, steps, href = '#human-steps') {
  const p = outcomes?.real?.prs;
  const main = p
    ? [T('Hands-off:'), BIG(`${outcomes.real.zeroTouch} of ${p.accepted}`), T(`PR${p.accepted === 1 ? '' : 's'} merged with no human edits`), NUM('(gh-aw zero-touch)')]
    : [T('Hands-off:'), BIG('—'), T('gh-aw Outcomes not available yet')];
  const sub = steps?.goLive
    ? [NUM(String(steps.total)), { t: 'link', text: steps.total === 1 ? 'manual step' : 'manual steps', href }, T('after go-live')]
    : [NUM('0'), T('manual steps; not live yet')];
  return { key: 'hands', main, subs: [sub] };
}

// --- gh-aw Outcomes: the newest outcomes_snapshot -------------------------------------------

export const OUTCOME_STATUSES = Object.freeze(['accepted', 'rejected', 'pending', 'ignored', 'unknown']);
export const OUTCOMES_STALE_MS = 48 * HOUR_MS;

/**
 * One outcomes_snapshot payload, normalized, or null when it isn't usable (no `runs` list, no
 * source run id, no evaluation time). Runs without a numeric run_id, a workflow, a boolean
 * `drill` or an `items` list, and items without a type or status, are dropped and counted in
 * `dropped`. An optional `diagnosis` is kept; review runs may name a task.
 */
export function parseOutcomesSnapshot(payload) {
  if (!plainObject(payload) || !Array.isArray(payload.runs) || !(Number.isSafeInteger(payload.source_run_id) && payload.source_run_id > 0)) return null;
  const evaluatedAt = parseTime(payload.evaluated_at);
  if (evaluatedAt == null) return null;
  let dropped = 0;
  const runs = [];
  for (const r of payload.runs) {
    if (!plainObject(r) || !isNum(r.run_id) || !isStr(r.workflow) || typeof r.drill !== 'boolean' || !Array.isArray(r.items)) {
      dropped++;
      continue;
    }
    const items = [];
    for (const it of r.items) {
      if (!plainObject(it) || !isStr(it.type) || !isStr(it.outcome_status) || !(it.zero_touch === true || it.zero_touch === false || it.zero_touch == null)) {
        dropped++;
        continue;
      }
      items.push({ type: it.type, url: isStr(it.object_url) ? it.object_url : null, status: it.outcome_status, evidence: isStr(it.evidence_strength) ? it.evidence_strength : null, zeroTouch: it.zero_touch ?? null });
    }
    runs.push({
      runId: r.run_id, workflow: r.workflow, task: isStr(r.task) ? r.task : null, drill: r.drill, createdAt: parseTime(r.created_at),
      aic: isNum(r.aic) ? r.aic : null, conclusion: isStr(r.conclusion) ? r.conclusion : null, eval: isStr(r.eval) ? r.eval : null,
      evaluatedAt: parseTime(r.evaluated_at), items, diagnosis: r.diagnosis ?? null,
    });
  }
  return {
    sourceRunId: payload.source_run_id, sourceRunAttempt: isNum(payload.source_run_attempt) ? payload.source_run_attempt : null,
    ghAwVersion: isStr(payload.gh_aw_version) ? payload.gh_aw_version : null, mode: isStr(payload.mode) ? payload.mode : null,
    evaluatedAt, runs, dropped, summary: plainObject(payload.summary) ? payload.summary : null,
  };
}

/**
 * The newest usable outcomes_snapshot in the log (each is complete, so only it is read) and when
 * it was last re-checked: the newest `outcomes_checked` marker after it whose `same_as_run_id` is
 * its source run. Returns { snapshot, at, checkedAt, lastAt, ignored } or null without one.
 */
export function latestOutcomes(events) {
  let found = null;
  let ignored = 0;
  for (const ev of events || []) {
    if (ev?.type !== 'outcomes_snapshot') continue;
    const snap = parseOutcomesSnapshot(ev.payload);
    const at = parseTime(ev.timestamp);
    if (!snap || at == null) {
      ignored++;
      continue;
    }
    if (!found || at >= found.at) found = { snapshot: snap, at };
  }
  if (!found) return null;
  let checkedAt = null;
  for (const ev of events || []) {
    const t = parseTime(ev?.timestamp);
    if (ev?.type === 'outcomes_checked' && t != null && t >= found.at && ev.payload?.same_as_run_id === found.snapshot.sourceRunId && (checkedAt == null || t > checkedAt)) checkedAt = t;
  }
  return { ...found, checkedAt, lastAt: Math.max(found.snapshot.evaluatedAt, checkedAt ?? -Infinity), ignored };
}

/** Whether the newest Outcomes snapshot (latestOutcomes()) is over 48 h old with no check since. */
export function outcomesStale(latest, now = Date.now()) {
  return !!latest && now - latest.lastAt > OUTCOMES_STALE_MS;
}

/**
 * Counts from a parsed snapshot, real work and safety drills apart (a run is a drill when the
 * snapshot says so, or its task is drill/*): `prs` counts `create_pull_request` items by status
 * (accepted, rejected, pending, other) and by raw status (`prStatus`), `items` every item by status, `zeroTouch` the accepted PRs
 * gh-aw marked zero-touch.
 */
export function outcomesSummary(snapshot) {
  const blank = () => ({ prs: { accepted: 0, rejected: 0, pending: 0, other: 0 }, prStatus: {}, items: {}, zeroTouch: 0, runs: 0 });
  const out = { real: blank(), drills: blank() };
  for (const r of snapshot?.runs ?? []) {
    const side = r.drill || isDrill(r.task) ? out.drills : out.real;
    side.runs++;
    for (const it of r.items) {
      side.items[it.status] = (side.items[it.status] ?? 0) + 1;
      if (it.type !== 'create_pull_request') continue;
      side.prStatus[it.status] = (side.prStatus[it.status] ?? 0) + 1;
      if (it.status in side.prs && it.status !== 'other') side.prs[it.status]++;
      else side.prs.other++;
      if (it.status === 'accepted' && it.zeroTouch === true) side.zeroTouch++;
    }
  }
  return out;
}

/**
 * "Quality: 0 reverts · reviewer blocked 1 change · 12 safety drills passed (6 defects fixed)",
 * real work only (drills are left out of the reverts and blocks; the tooltip says so). The drills clause needs a valid drills.json (`drills`, a
 * validateDrills() result); without it the clause is left out.
 */
export function qualityItem(q, drills = null) {
  const r = q?.reverts ?? 0;
  const k = q?.objections ?? 0;
  return {
    key: 'quality',
    main: [
      T('Quality:'), BIG(String(r)), T(`revert${r === 1 ? '' : 's'}`), SEP,
      T('reviewer blocked'), NUM(`${k} change${k === 1 ? '' : 's'}`),
      ...(drills?.ok ? [SEP, { t: 'link', text: `${drills.passed} safety drill${drills.passed === 1 ? '' : 's'} passed`, href: JOURNAL_URL },
        NUM(`(${drills.value.defects} defect${drills.value.defects === 1 ? '' : 's'} fixed)`)] : []),
    ],
    subs: [],
  };
}
