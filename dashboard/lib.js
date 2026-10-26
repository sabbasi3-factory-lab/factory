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

export const HEALTH_LABELS = Object.freeze({ ok: 'Healthy', warn: 'Degraded', alert: 'Down', loading: 'Loading' });
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
 * - Healthy: fresh data, a verified chain, a heartbeat within 8 h and, when given, a
 *   verifier anchor within 8 h. A verifier still being checked doesn't count either way.
 *
 * The limits (DEFAULTS.heartbeatWarnMin/AlertMin, VERIFIER_LIMITS) sit above the cadence
 * GitHub's scheduler really delivers on a Free plan, every 2 to 8 h for hourly jobs, so
 * a normal late run doesn't read as Degraded.
 *
 * `reasons` lists every condition that isn't healthy, worst first, for the tooltip.
 */
export function healthSummary({ loaded = false, noLog = false, error = null, chain = null, heartbeat = null, dataAgeMin = null, verifier = null } = {}) {
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
  const worst = found.reduce((a, f) => (LEVEL_RANK[f.level] > LEVEL_RANK[a] ? f.level : a), 'ok');
  const reasons = found.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]).map((f) => f.text);
  return { level: worst, label: HEALTH_LABELS[worst], reasons };
}

/**
 * The heartbeat tile: { level, value }. Until the first load it's the neutral "loading"
 * level with "…", never a red alarm; after it, ok/warn/alert from heartbeat.level, and a
 * missing heartbeat is an alert with "—".
 */
export function heartbeatTile(heartbeat, loaded) {
  if (!loaded) return { level: 'loading', value: '…' };
  if (heartbeat?.ageMin == null) return { level: 'alert', value: '—' };
  const level = heartbeat.level === 'ok' ? 'ok' : heartbeat.level === 'warn' ? 'warn' : 'alert';
  return { level, value: compactAge(heartbeat.ageMin * 60000) };
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

/** Anchors per UTC day over the window, oldest first: the "Verified" tile's trend (24 scheduled). */
export function anchorsPerDay(anchors, { now = Date.now(), days = DEFAULTS.windowDays } = {}) {
  const end = Date.parse(utcDay(now) + 'T00:00:00Z');
  const labels = [];
  for (let i = days - 1; i >= 0; i--) labels.push(utcDay(end - i * 86400000));
  const index = new Map(labels.map((d, i) => [d, i]));
  const counts = labels.map(() => 0);
  for (const a of anchors || []) {
    const ms = parseUtcSeconds(a?.at);
    const i = ms == null ? undefined : index.get(utcDay(ms));
    if (i != null) counts[i]++;
  }
  return { days: labels, counts };
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

/**
 * Sparkline geometry: every valid point gets a marker; lines join only consecutive
 * valid points, so a gap (null) is never bridged.
 */
export function sparkSegments(values) {
  const points = [];
  const segments = [];
  let run = [];
  (values || []).forEach((v, i) => {
    if (isNum(v)) {
      points.push({ i, v });
      run.push({ i, v });
    } else {
      if (run.length > 1) segments.push(run);
      run = [];
    }
  });
  if (run.length > 1) segments.push(run);
  return { points, segments };
}

// ---------------------------------------------------------------------------
// v2 views: short SHAs, 7-day series, pipeline lanes, stage and cost charts

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
 * Per-UTC-day series for the KPI trend lines, oldest day first. Rates are null on days
 * with nothing to measure, so a trend line shows a gap instead of a fake zero.
 */
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

export function dailySeries(events, { now = Date.now(), days = DEFAULTS.windowDays } = {}) {
  const end = Date.parse(utcDay(now) + 'T00:00:00Z');
  const labels = [];
  for (let i = days - 1; i >= 0; i--) labels.push(utcDay(end - i * 86400000));
  const index = new Map(labels.map((d, i) => [d, i]));
  const zeros = () => labels.map(() => 0);
  const dayOf = (ms) => (ms == null ? null : index.get(utcDay(ms)) ?? null);

  const prTask = prTaskMap(events);
  const merged = zeros();
  const aic = zeros();
  const heartbeats = zeros();
  const checksPassed = zeros();
  const checksTotal = zeros();
  const mergeMinutes = labels.map(() => []);
  const factoryMerged = zeros();
  const factoryMergedPrs = labels.map(() => []);
  const opened = new Map();
  const touched = new Set();

  for (const ev of events) {
    const p = ev.payload || {};
    if (ev.type === 'human_action' && isNum(p.pr)) touched.add(p.pr);
    if (ev.type === 'pr_opened' && isNum(p.pr) && !opened.has(p.pr)) opened.set(p.pr, eventTime(ev));
  }
  for (const ev of events) {
    const p = ev.payload || {};
    const d = dayOf(ev.type === 'run_finished' || ev.type === 'heartbeat' ? parseTime(ev.timestamp) : eventTime(ev));
    if (d == null) continue;
    switch (ev.type) {
      case 'merged': {
        merged[d]++;
        const at = eventTime(ev);
        if (isNum(p.pr) && opened.get(p.pr) != null && at != null) mergeMinutes[d].push((at - opened.get(p.pr)) / 60000);
        if (isStr(p.task) || prTask.has(p.pr)) {
          factoryMerged[d]++;
          factoryMergedPrs[d].push(p.pr);
        }
        break;
      }
      case 'run_finished':
        if (isNum(p.aic)) aic[d] += p.aic;
        break;
      case 'heartbeat':
        heartbeats[d]++;
        break;
      case 'check_result':
        checksTotal[d]++;
        if (p.conclusion === 'success') checksPassed[d]++;
        break;
      default:
        break;
    }
  }

  // A day's spend snapshot is its total (run_finished, where present, can only raise it).
  for (const [day, snap] of spendSnapshots(events)) {
    const d = index.get(day);
    if (d != null) aic[d] = Math.max(aic[d], snap.total);
  }

  // Zero-touch is cumulative across the window, so each point is "rate so far".
  const zeroTouchPct = [];
  let fm = 0;
  let untouched = 0;
  for (let i = 0; i < labels.length; i++) {
    fm += factoryMerged[i];
    untouched += factoryMergedPrs[i].filter((pr) => !touched.has(pr)).length;
    zeroTouchPct.push(fm ? (untouched / fm) * 100 : null);
  }
  const passed = checksPassed.reduce((a, b) => a + b, 0);
  const total = checksTotal.reduce((a, b) => a + b, 0);
  return {
    days: labels,
    merged,
    aic,
    heartbeats,
    checksPassPct: checksTotal.map((t, i) => (t ? (checksPassed[i] / t) * 100 : null)),
    checks: { passed, total, pct: total ? (passed / total) * 100 : null },
    mergeMedianMin: mergeMinutes.map(median),
    mergeMedianAllMin: median(mergeMinutes.flat()),
    zeroTouchPct,
  };
}

export const PIPELINE_LANES = Object.freeze([
  { key: 'ready', label: 'Ready' },
  { key: 'running', label: 'Running' },
  { key: 'pr-open', label: 'PR open' },
  { key: 'checks', label: 'Checks' },
  { key: 'queued', label: 'Merge queue' },
  { key: 'merged', label: 'Merged' },
  { key: 'deployed', label: 'Deployed' },
]);

const LANE_OF = {
  ready: 'ready',
  picked: 'running',
  dispatched: 'running',
  run_started: 'running',
  repair_dispatched: 'running',
  run_finished: 'running',
  pr_opened: 'pr-open',
  check_result: 'checks',
  queued: 'queued',
  dequeued: 'pr-open',
  merged: 'merged',
  deployed: 'deployed',
  accepted: 'deployed',
};
const SIDE_STATE = { needs_human: 'needs human', stale_contract: 'stale contract', blocked: 'blocked' };
const DONE_LANES = new Set(['merged', 'deployed']);

const PR_LANES = new Set(['pr-open', 'checks', 'queued']);
const LANE_RANK = { ready: 0, running: 1, 'pr-open': 2, checks: 3, queued: 4, merged: 5, deployed: 6 };
// Records of something that already happened (the daily collector may append run_finished
// hours later); they may move a card forward but never back.
const RECORD_ONLY = new Set(['run_started', 'run_finished']);
// After a merge, only real new work moves a card back: a new attempt, a new PR, re-admission.
const REOPENS = new Set(['ready', 'picked', 'dispatched', 'repair_dispatched', 'pr_opened']);
const CHECK_OK = new Set(['success', 'neutral', 'skipped']);

/** Whether an event of `type` may move a card from lane `from` to lane `to`. */
function laneMoveAllowed(type, from, to) {
  if (from == null || from === to || LANE_RANK[to] >= LANE_RANK[from]) return true;
  if (RECORD_ONLY.has(type)) return false;
  if (DONE_LANES.has(from)) return REOPENS.has(type);
  return true;
}

/**
 * One card per task (or per PR that has no task) in the lane of its latest stage.
 * v1 has no "closed" event, so `openPrs` (a Set of PR numbers that are open on GitHub
 * right now) decides PR lanes: a card in PR open, Checks or Merge queue stays only if one
 * of its PRs is open; otherwise it's counted in `closed`. Without `openPrs` (the list
 * couldn't be fetched) cards stay, and those lanes are flagged `prStateUnknown`.
 * Side states (needs-human, stale contract, blocked) become tags on the card; dry-run
 * decisions never move a card, because nothing was launched.
 */
export function pipeline(events, { openPrs = null } = {}) {
  const prTask = prTaskMap(events);
  const cards = new Map();
  const card = (key) => {
    if (!cards.has(key)) {
      cards.set(key, {
        key,
        kind: key.startsWith('task:') ? 'task' : 'pr',
        label: key.startsWith('task:') ? key.slice(5) : `PR #${key.slice(3)}`,
        issue: null, prs: [], lane: null, enteredAt: null, attempt: null, model: null, workflow: null,
        side: null, checkHead: null, oldHeads: new Set(), checks: new Map(), planned: false, removed: false,
      });
    }
    return cards.get(key);
  };

  for (const ev of events) {
    const p = ev.payload || {};
    const subjects = eventSubjects(ev, prTask);
    let keys = [...subjects].filter((s) => s.startsWith('task:'));
    if (!keys.length) keys = [...subjects].filter((s) => s.startsWith('pr:'));
    if (!keys.length) continue;
    const planOnly = isPlanOnly(ev);
    const lane = LANE_OF[ev.type];
    for (const key of keys) {
      const c = card(key);
      if (isNum(p.issue)) c.issue = p.issue;
      for (const pr of eventPrs(ev)) if (!c.prs.includes(pr)) c.prs.push(pr);
      if (ev.type === 'cancelled' && !planOnly) {
        c.removed = true;
        continue;
      }
      if (SIDE_STATE[ev.type]) {
        c.side = { label: SIDE_STATE[ev.type], reason: isStr(p.reason) ? p.reason : null };
        if (!c.lane) [c.lane, c.enteredAt] = ['ready', parseTime(ev.timestamp)];
        continue;
      }
      // Resolutions without a lane (human_action, contract_pinned) still clear the side
      // state; plan-only (dry-run) decisions never resolve anything.
      if (RESOLVES_NEEDS_YOU.has(ev.type) && !planOnly) c.side = null;
      if (!lane) continue;
      if (planOnly) {
        c.planned = true;
        if (!c.lane) [c.lane, c.enteredAt] = ['ready', parseTime(ev.timestamp)];
        continue;
      }
      // Latest result per workflow for the PR's current head: a success from one
      // workflow doesn't hide another workflow's failure; a new head starts afresh.
      const head = isStr(p.head_sha) ? p.head_sha : null;
      if ((ev.type === 'check_result' || ev.type === 'pr_opened') && head && head !== c.checkHead) {
        if (c.oldHeads.has(head)) continue; // a late result for a head that's been replaced
        if (c.checkHead) c.oldHeads.add(c.checkHead);
        c.checkHead = head;
        c.checks = new Map();
      }
      // A cancelled task stays out of the pipeline until real new work reopens it; a late
      // run_finished or check result after the cancellation doesn't bring it back.
      if (c.removed && !REOPENS.has(ev.type)) continue;
      c.removed = false;
      if (c.lane !== lane && laneMoveAllowed(ev.type, c.lane, lane)) [c.lane, c.enteredAt] = [lane, eventTime(ev)];
      if (ev.type === 'dispatched' || ev.type === 'repair_dispatched') {
        if (isNum(p.attempt)) c.attempt = p.attempt;
        if (isStr(p.model)) c.model = p.model;
        c.workflow = isStr(p.workflow) ? p.workflow : ev.type === 'repair_dispatched' ? 'repair' : 'implement';
        c.planned = false;
      }
      if (ev.type === 'pr_opened' && !head) c.checks = new Map();
      if (ev.type === 'check_result') {
        c.checks.set(isStr(p.workflow) ? p.workflow : 'check', {
          conclusion: isStr(p.conclusion) ? p.conclusion : null,
          signature: isStr(p.failure_signature) ? p.failure_signature : null,
        });
      }
    }
  }

  const lanes = PIPELINE_LANES.map((l) => ({ ...l, cards: [], prStateUnknown: false }));
  const byKey = new Map(lanes.map((l) => [l.key, l]));
  const known = openPrs instanceof Set;
  const closed = [];
  for (const c of cards.values()) {
    if (c.removed || !c.lane) continue;
    if (PR_LANES.has(c.lane) && c.prs.length) {
      if (!known) byKey.get(c.lane).prStateUnknown = true;
      else if (!c.prs.some((pr) => openPrs.has(pr))) {
        closed.push({ key: c.key, label: c.label, prs: c.prs.slice(), lane: c.lane });
        continue;
      }
    }
    const tags = [];
    if (c.side) tags.push({ text: c.side.label, tone: 'fail', title: c.side.reason });
    if (c.lane === 'running' && c.workflow === 'repair') tags.push({ text: `repair${c.attempt ? ` a${c.attempt}` : ''}`, tone: 'warn', title: null });
    if (!DONE_LANES.has(c.lane)) {
      for (const [wf, r] of c.checks) {
        if (r.conclusion && !CHECK_OK.has(r.conclusion)) tags.push({ text: `${wf} ${r.conclusion}`, tone: 'fail', title: r.signature });
      }
    }
    if (c.planned) tags.push({ text: 'dry-run plan', tone: 'info', title: null });
    byKey.get(c.lane).cards.push({ ...c, tags });
  }
  for (const l of lanes) {
    // Active lanes: longest-waiting first. Done lanes: most recent first.
    l.cards.sort((a, b) => (DONE_LANES.has(l.key) ? (b.enteredAt ?? 0) - (a.enteredAt ?? 0) : (a.enteredAt ?? 0) - (b.enteredAt ?? 0)));
  }
  closed.sort((a, b) => (a.prs[0] ?? 0) - (b.prs[0] ?? 0));
  return { lanes, total: lanes.reduce((n, l) => n + l.cards.length, 0), closed, prStateKnown: known };
}

/** PR numbers opened in the events and never merged: the "open" set for sample data. */
export function unmergedPrs(events) {
  const open = new Set();
  for (const ev of events) {
    const pr = ev.payload?.pr;
    if (!isNum(pr)) continue;
    if (ev.type === 'pr_opened') open.add(pr);
    if (ev.type === 'merged') open.delete(pr);
  }
  return open;
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

/** Stacked-bar data from stageTimes(), plus the stage that takes the largest share. */
export function stageBreakdown(rows) {
  const out = [];
  const sums = {};
  for (const r of rows || []) {
    const segments = [];
    for (const st of STAGES) {
      const d = r.durations?.[st];
      if (d && isNum(d.ms) && d.ms > 0) {
        segments.push({ stage: st, ms: d.ms, to: d.to });
        sums[st] = (sums[st] ?? 0) + d.ms;
      }
    }
    const totalMs = segments.reduce((a, s) => a + s.ms, 0);
    if (totalMs > 0) out.push({ key: r.key, label: r.label, segments, totalMs, current: r.current });
  }
  const grand = Object.values(sums).reduce((a, b) => a + b, 0);
  let insight = null;
  if (grand > 0) {
    const [stage, ms] = Object.entries(sums).sort((a, b) => b[1] - a[1])[0];
    insight = { stage, label: STAGE_LABELS[stage], pct: (ms / grand) * 100, totalMs: grand, tasks: out.length };
  }
  // Average per task and PR across the window: each stage's total divided by the row count.
  const average = out.length
    ? { key: 'average', label: 'Average', segments: STAGES.filter((st) => sums[st]).map((st) => ({ stage: st, ms: sums[st] / out.length })), totalMs: grand / out.length }
    : null;
  return { rows: out, average, maxMs: Math.max(0, ...out.map((r) => r.totalMs)), insight };
}

/** Cost bars from deriveMetrics().tokensPerTask, highest first, with an average-vs-budget line. */
export function costSummary(tokens, perTaskBudget = DEFAULTS.perTaskAic) {
  const rows = (tokens?.rows ?? []).filter((r) => r.task !== '(no task)').slice().sort((a, b) => b.aic - a.aic);
  if (!rows.length) return { rows: [], maxAic: 0, avgAic: null, pct: null, overBudget: [] };
  const total = rows.reduce((a, r) => a + r.aic, 0);
  const avgAic = total / rows.length;
  return {
    rows,
    maxAic: rows[0].aic,
    avgAic,
    pct: perTaskBudget > 0 ? (avgAic / perTaskBudget) * 100 : null,
    overBudget: rows.filter((r) => r.aic > perTaskBudget).map((r) => r.task),
  };
}

/** Median run_finished duration (ms), used as the "typical run" for agent progress bars. */
export function typicalRunMs(events) {
  return median(events.filter((e) => e.type === 'run_finished').map((e) => e.payload?.duration_ms));
}

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
 * the window has no dispatch_state event. The controller records the state only when it
 * changes, so "since" is the first of the newest run of events with the same state and reason
 * (a changed unreadable-run count doesn't reset it).
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
  const sinceMs = parseTime(first.timestamp);
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
    why = `${ready == null ? 'work' : ready} ready, held by limits`;
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
    ...(p.state === 'waiting' ? ['Waiting: ready work held by the WIP or area limits.'] : []),
    `In this state since ${first.timestamp}${first !== last ? `; last change recorded ${last.timestamp}` : ''}. The controller records the state only when it changes.`,
    ...(p.dry_run === true ? ['Dry run: the controller logs decisions without acting.'] : []),
  ];
  return { level, state: p.state, reason: p.reason ?? null, since: first.timestamp, text: `${head} since ${sinceText(sinceMs, now)}: ${why}`, tip: tip.join('\n') };
}
