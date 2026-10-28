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

/**
 * Keeps only the wanted day-file paths that exist, given the entries of a recursive
 * git tree listing of `audit/` (paths relative to it, like "2026/10/16.jsonl").
 */
export function existingDayPaths(treeEntries, wanted) {
  const have = new Set((treeEntries || []).filter((t) => t && t.type === 'blob' && typeof t.path === 'string').map((t) => `audit/${t.path}`));
  return wanted.filter((p) => have.has(p));
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
 * `reasons` lists every condition that isn't healthy, worst first, for the tooltip.
 */
export function healthSummary({ loaded = false, noLog = false, error = null, chain = null, heartbeat = null, dataAgeMin = null, verifier = null, dispatch = null } = {}) {
  if (!loaded && !error) return { level: 'loading', label: HEALTH_LABELS.loading, reasons: ['Loading the audit log'] };
  const found = [];
  const add = (level, text) => found.push({ level, text });
  if (noLog) add('alert', 'No audit log yet');
  if (error) add(loaded ? 'warn' : 'alert', `${loaded ? 'Last refresh failed' : "Couldn't load the audit log"}: ${error}`);
  if (!error && isNum(dataAgeMin) && dataAgeMin > STALE_DATA_MIN) add('warn', `Data is ${formatAge(dataAgeMin)} old`);
  if (loaded && !noLog) {
    if (chain?.status === 'broken') add('alert', `Chain broken at event ${chain.brokenAt}`);
    else if (chain?.status !== 'verified') add('warn', 'Chain not verified');
    const level = heartbeat?.level ?? 'unknown';
    if (level === 'alert') add('alert', `Heartbeat stale (${formatAge(heartbeat.ageMin)})`);
    else if (level === 'none') add('alert', 'No heartbeat in the window');
    else if (level === 'warn') add('warn', `Heartbeat late (${formatAge(heartbeat.ageMin)})`);
    else if (level !== 'ok') add('warn', 'Heartbeat unknown');
  }
  if (verifier && (verifier.level === 'warn' || verifier.level === 'alert')) add(verifier.level, verifierReason(verifier));
  // Dispatch held by a gate (a dispatchBanner() result) is never "Healthy". The kill switch is
  // the deliberate safe state with its own chip, so it doesn't count.
  const paused = dispatch?.state === 'paused' && dispatch.reason !== 'kill_switch';
  if (paused) add('warn', dispatch.text);
  const worst = found.reduce((a, f) => (LEVEL_RANK[f.level] > LEVEL_RANK[a] ? f.level : a), 'ok');
  const reasons = found.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]).map((f) => f.text);
  // Paused and nothing else wrong: say "Paused", not "Degraded".
  const label = paused && worst === 'warn' && found.length === 1 ? HEALTH_LABELS.paused : HEALTH_LABELS[worst];
  return { level: worst, label, reasons };
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

/** At most `maxWords` whitespace-separated words (and 48 characters), with "…" when cut. */
export function shortTitle(text, maxWords = 5, maxChars = 48) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  let out = words.slice(0, maxWords).join(' ');
  let cut = words.length > maxWords;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 1).trimEnd();
    cut = true;
  }
  return cut ? `${out.replace(/[\s,.;:–-]+$/, '')}…` : out;
}

/** "#22" for a PR in the home repo, "factory#3" for one elsewhere. */
export function prRef(repo, number, homeRepo) {
  if (!isNum(number)) return '—';
  return repo && repo !== homeRepo ? `${String(repo).split('/').pop()}#${number}` : `#${number}`;
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
        merged.push(ev);
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
    mergedToday: { count: mergedToday.length, prs: mergedToday.map((ev) => ev.payload?.pr).filter(isNum) },
    zeroTouch: {
      merged: factoryMerged.length,
      untouched: untouched.length,
      rate: factoryMerged.length ? untouched.length / factoryMerged.length : null,
    },
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
  'en-month-names': 'Month names',
  'en-numeric-dates': 'Numeric dates',
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
 * entered its state (ms), `issue` the task's issue number from the events.
 */
export function taskBoard(events, catalog, { open = null, asOf = null, needsItems = [] } = {}) {
  const prTask = prTaskMap(events || []);
  const info = new Map((catalog || []).map((t) => [t.id, { issue: null, prs: [], pr: null, seen: false, readyAt: null, started: null, doneAt: null, step: null, stepAt: null }]));
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
      if (REOPENS_TASK.has(ev.type) && s.doneAt != null) s.doneAt = null;
      if (ev.type === 'ready' || ev.type === 'auto_ready') s.readyAt = t;
      if (AGENT_EVENTS.has(ev.type)) s.started ??= t;
      if (ev.type === 'dispatched') s.pr = null; // a new attempt has no PR yet
      if (isNum(p.pr) && ev.type !== 'merged') s.pr = p.pr;
      if (STEP_TEXT[ev.type]) [s.step, s.stepAt] = [STEP_TEXT[ev.type], t];
      if ((ev.type === 'merged' || ev.type === 'task_done') && s.doneAt == null) s.doneAt = t;
    }
  }
  const needsByTask = new Map();
  for (const it of needsItems || []) if (isStr(it?.task) && !needsByTask.has(it.task)) needsByTask.set(it.task, it);
  const doneIds = new Set([...info].filter(([, s]) => s.doneAt != null).map(([id]) => id));

  const tasks = (catalog || []).map((c) => {
    const s = info.get(c.id);
    const base = { ...c, issue: s.issue, prs: s.prs.slice(), step: s.step };
    if (s.doneAt != null) return { ...base, state: 'done', since: s.doneAt, reason: 'merged' };
    const need = needsByTask.get(c.id);
    if (need) return { ...base, state: 'needs', since: parseTime(need.since), reason: need.reason ?? need.kind ?? null };
    const closed = s.started != null && isClosedRef({ issue: s.issue, pr: s.pr, at: s.stepAt }, open, asOf);
    if (s.started != null && !closed) return { ...base, state: 'running', since: s.stepAt ?? s.started, reason: s.step };
    const blockedBy = c.dependsOn.filter((d) => !doneIds.has(d));
    let reason;
    if (closed) reason = 'issue or PR closed without a merge';
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

/**
 * The status line's plain-English state: { text, level }. In order: loading; paused by a gate
 * (not the kill switch, which has its own chip); tasks running; tasks needing you; all done;
 * ready tasks waiting for a slot; tasks waiting on dependencies; idle.
 */
export function stateLine({ loaded = true, board = null, dispatch = null } = {}) {
  if (!loaded) return { text: 'Loading…', level: 'loading' };
  const p = dispatch ?? null;
  if (p?.state === 'paused' && p.reason !== 'kill_switch') {
    return { text: `Paused: ${p.reason === 'budget_unknown' ? 'spend unknown' : PAUSE_TEXT[p.reason] ?? 'held by a gate'}`, level: 'warn' };
  }
  const c = board?.counts ?? null;
  if (!c || !board.total) return { text: p?.state === 'running' ? 'Running' : 'Idle: no tasks yet', level: 'info' };
  if (c.running) return { text: `Running: ${plural(c.running, 'task')}`, level: 'info' };
  if (c.needs) return { text: `Waiting on you: ${plural(c.needs, 'task')}`, level: 'warn' };
  if (c.done === board.total) return { text: `Idle: all ${board.total} tasks done`, level: 'ok' };
  if (board.readyWaiting) return { text: `Waiting: ${plural(board.readyWaiting, 'task')} ready`, level: 'info' };
  return { text: `Waiting: ${plural(c.waiting, 'task')} on dependencies`, level: 'info' };
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
 * `auto_ready` (else its first real `dispatched`) to its last `merged`. Returns
 * { medianMs, count, items: [{ task, ms }] }.
 */
export function issueToMerged(events, { now = Date.now(), days = MEDIAN_DAYS } = {}) {
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

// --- Cost: spend snapshots joined with the agent workflow runs -----------------------

export const AGENT_WORKFLOWS = Object.freeze(['implement', 'repair', 'review']);
export const REVIEW_MATCH_MS = 30 * 60000;
const RUN_TITLE = /^(Implement|Repair)\s+(\S+)\s+#(\d+)\s+attempt\s+(\d+)$/;

/** "Implement <task> #<issue> attempt <n>" (or "Repair …") → { workflow, task, issue, attempt }, else null. */
export function parseRunTitle(title) {
  const m = RUN_TITLE.exec(String(title ?? '').trim());
  return m ? { workflow: m[1].toLowerCase(), task: m[2], issue: Number(m[3]), attempt: Number(m[4]) } : null;
}

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

/** Run ids listed in any real spend snapshot. */
export function snapshotRunIds(events) {
  return runSpend(events).seen;
}

/**
 * Pairs runs with the controller events that dispatched them, by time: a run belongs to an
 * event of `type` it was created at or after, within 30 min; the nearest pairs are taken first
 * and each event and run is used once. Events in `claimed` ("task#attempt") already have a run.
 * Returns Map run id → event payload.
 */
function matchByTime(runs, events, type, claimed = new Set()) {
  const evs = (events || []).filter((e) => e?.type === type && !isPlanOnly(e) && parseTime(e.timestamp) != null
    && !claimed.has(`${e.payload?.task}#${isNum(e.payload?.attempt) ? e.payload.attempt : 1}`));
  const pairs = [];
  for (const r of runs) {
    const created = parseTime(r.created_at);
    if (created == null) continue;
    evs.forEach((e, i) => {
      const gap = created - parseTime(e.timestamp);
      if (gap >= 0 && gap <= REVIEW_MATCH_MS) pairs.push({ run: r.id, ev: i, gap });
    });
  }
  pairs.sort((a, b) => a.gap - b.gap || a.ev - b.ev);
  const usedRuns = new Map();
  const usedEvents = new Set();
  for (const pr of pairs) {
    if (usedRuns.has(pr.run) || usedEvents.has(pr.ev)) continue;
    usedRuns.set(pr.run, evs[pr.ev].payload || {});
    usedEvents.add(pr.ev);
  }
  return usedRuns;
}

const DISPATCH_EVENT = { implement: 'dispatched', repair: 'repair_dispatched', review: 'review_dispatched' };

/**
 * AIC per task, from the controller's spend snapshots (the latest measured value per run id)
 * joined with the agent workflow runs (`agentRuns`: [{ id, created_at, workflow, display_title }],
 * or null when the run lists couldn't be read). Implement and repair runs name their task in the
 * title ("Implement <task> #<issue> attempt <n>"); a review run ("Review one factory PR"), or an
 * implement or repair run whose title doesn't parse (older runs read "Implement one factory
 * task"), is matched by time to the `review_dispatched`, `dispatched` or `repair_dispatched`
 * event it followed (matchByTime).
 *
 * Returns { known, total, perTask: [{ task, aic, runs }] (non-drill, highest first), drillAic,
 * unattributed, unattributedRuns, perDay: { days, aic }, byWorkflow: { implement, repair, review,
 * unknown: { runs, measured, aic } }, unknownRunIds, measuredRuns }. `total` is every measured run
 * (drills included: they were real spend); `unattributed` is the part no task could be found for.
 */
export function costJoin(events, agentRuns, { now = Date.now(), days = MEDIAN_DAYS } = {}) {
  const { measured } = runSpend(events);
  const known = Array.isArray(agentRuns);
  const runs = known ? agentRuns.filter((r) => isNum(r?.id)) : [];
  const listed = new Map(runs.map((r) => [r.id, r]));
  const titled = new Map();
  for (const r of runs) {
    const t = parseRunTitle(r.display_title);
    if (t && t.workflow === r.workflow) titled.set(r.id, t);
  }
  const byTime = new Map();
  for (const wf of AGENT_WORKFLOWS) {
    const claimed = new Set([...titled.values()].filter((t) => t.workflow === wf).map((t) => `${t.task}#${t.attempt}`));
    const untitled = runs.filter((r) => r.workflow === wf && !titled.has(r.id));
    for (const [id, p] of matchByTime(untitled, events, DISPATCH_EVENT[wf], claimed)) byTime.set(id, p);
  }
  const byWorkflow = Object.fromEntries([...AGENT_WORKFLOWS, 'unknown'].map((w) => [w, { runs: 0, measured: 0, aic: 0 }]));
  for (const r of runs) if (byWorkflow[r.workflow]) byWorkflow[r.workflow].runs++;

  const perTask = new Map();
  let total = 0;
  let drillAic = 0;
  let unattributed = 0;
  let unattributedRuns = 0;
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
    const run = listed.get(id);
    const wf = run && byWorkflow[run.workflow] ? run.workflow : 'unknown';
    byWorkflow[wf].measured++;
    byWorkflow[wf].aic += m.aic;
    if (!run) unknownRunIds.push(id);
    const task = titled.get(id)?.task ?? (isStr(byTime.get(id)?.task) ? byTime.get(id).task : null);
    if (!task) {
      unattributed += m.aic;
      unattributedRuns++;
    } else if (isDrill(task)) drillAic += m.aic;
    else {
      const row = perTask.get(task) ?? perTask.set(task, { task, aic: 0, runs: 0 }).get(task);
      row.aic += m.aic;
      row.runs++;
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
 * Quality over the loaded window, drills excluded:
 * - reverts: real `auto_revert` events;
 * - escaped defects: main commits whose post-merge `ci` failed (`check_result` with event
 *   "push", workflow "ci", conclusion "failure"), counted once per commit, leaving out merge
 *   commits of drill tasks;
 * - objections: `needs_human` with reason "review_objected";
 * - repairs: per real `repair_dispatched`, "succeeded" when the task's PR later merged with no
 *   `needs_human` for the task in between, "failed" when a `needs_human` came first, otherwise
 *   pending. `rate` = succeeded / (succeeded + failed), null without any.
 */
export function qualityStats(events) {
  const list = (events || []).filter((e) => e && typeof e === 'object');
  const prTask = prTaskMap(list);
  const taskOf = (ev) => (isStr(ev.payload?.task) ? ev.payload.task : prTask.get(ev.payload?.pr) ?? null);
  const drillShas = new Set();
  for (const ev of list) {
    if ((ev.type === 'merged' || ev.type === 'auto_revert') && isDrill(taskOf(ev)) && isStr(ev.payload?.merge_commit_sha)) drillShas.add(ev.payload.merge_commit_sha);
  }
  let reverts = 0;
  let objections = 0;
  const escaped = new Set();
  for (const ev of list) {
    const p = ev.payload || {};
    if (isPlanOnly(ev)) continue;
    if (ev.type === 'auto_revert' && !isDrill(taskOf(ev))) reverts++;
    if (ev.type === 'needs_human' && p.reason === 'review_objected' && !isDrill(taskOf(ev))) objections++;
    if (ev.type === 'check_result' && p.event === 'push' && p.workflow === 'ci' && p.conclusion === 'failure' && isStr(p.head_sha) && !drillShas.has(p.head_sha)) escaped.add(p.head_sha);
  }
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  list.forEach((ev, i) => {
    if (ev.type !== 'repair_dispatched' || isPlanOnly(ev)) return;
    const task = taskOf(ev);
    if (!task || isDrill(task)) return;
    let outcome = 'pending';
    for (const later of list.slice(i + 1)) {
      if (taskOf(later) !== task || isPlanOnly(later)) continue;
      if (later.type === 'needs_human') {
        outcome = 'failed';
        break;
      }
      if (later.type === 'merged') {
        outcome = 'succeeded';
        break;
      }
    }
    if (outcome === 'succeeded') succeeded++;
    else if (outcome === 'failed') failed++;
    else pending++;
  });
  return {
    reverts,
    escaped: { count: escaped.size, shas: [...escaped] },
    objections,
    repairs: { succeeded, failed, pending, rate: succeeded + failed ? succeeded / (succeeded + failed) : null },
  };
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
 * The newest `limit` meaningful events as short sentences, newest first:
 * [{ text, at, type, task, issue, pr }], e.g. "#29 iso-format-parser merged". The reference is
 * the task's issue (else the PR). Skips heartbeats, spend snapshots, dispatch states, dequeues,
 * dry-run plans, passing checks and duplicates (task_done, handoff_done, auto_merge, and a line
 * identical to the previous one).
 */
export function recentActivity(events, { limit = 5 } = {}) {
  const list = (events || []).filter((e) => e && typeof e === 'object');
  const prTask = prTaskMap(list);
  const issueOf = new Map();
  for (const ev of list) if (isStr(ev.payload?.task) && isNum(ev.payload?.issue)) issueOf.set(ev.payload.task, ev.payload.issue);
  const out = [];
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
    if (out.length && out.at(-1).text === text) continue;
    out.push({ text, at: eventTime(ev), type: ev.type, task, issue, pr });
  }
  return out;
}
