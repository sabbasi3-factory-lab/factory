// Pure helpers the liveness watchdog needs (moved from the retired dashboard's lib.js, unchanged).
// No DOM access, no network; Node (>= 20).

export const EVENT_FIELDS = ['id', 'parents', 'payload', 'sha', 'timestamp', 'type', 'version'];

// The controller is scheduled hourly, but GitHub's cron on a Free-plan org runs it only every 2 to 8 h
// (measured: median gap 2.4 h, p90 4.4 h, worst 7.6 h), so the alert limit sits above that: 12 h.
export const DEFAULTS = Object.freeze({ heartbeatAlertMin: 720, windowDays: 7 });

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA_REF = /^sha256:[0-9a-f]{64}$/;
const isStr = (v) => typeof v === 'string' && v !== '';

/** Canonical JSON (DESIGN §11): object keys sorted, no whitespace. */
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

/** Coarse age for an aria-live line: whole hours from 2 h, so it changes at most hourly. */
export function formatAge(ageMin) {
  if (ageMin == null || !Number.isFinite(ageMin)) return 'unknown';
  if (ageMin < 120) return `${Math.floor(ageMin)} min`;
  if (ageMin < 48 * 60) return `${Math.floor(ageMin / 60)} h`;
  return `${Math.floor(ageMin / 1440)} d`;
}

/** Exact UTC second-precision time ("2026-10-17T05:47:12Z") that round-trips, or null. */
export function parseUtcSeconds(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') !== value) return null;
  return ms;
}
