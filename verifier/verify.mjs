// Independent audit-chain verifier (DESIGN §11). Runs in the factory repo, hourly, from
// .github/workflows/audit-verify.yml. Plain Node, no dependencies, no App key.
//
// 1. Reads the WHOLE `audit` branch of the product repo from git objects (ls-tree + cat-file,
//    never `git archive` or a checkout, so .gitattributes can't hide or rewrite files) and checks
//    every day file, every event's sha and the hash chain from a genesis event.
// 2. Reads the full history of this repo's append-only `anchors` branch and checks that every
//    commit only appended lines (the branch has a no-bypass ruleset against deletion and
//    non-fast-forward pushes; a fast-forward commit that edits or drops lines is caught here).
// 3. Checks the log against EVERY anchor: the anchored event count must still exist and the event
//    at that position must still have the anchored sha. A truncated tail, rewritten history or a
//    deleted audit branch fails.
// 4. On success, writes the next anchors file (old content + one new line) for the workflow to
//    commit. On failure, prints ::error:: lines and exits 1: the failed run is the alert of record.
//
// Who can write what: the product repo's controller App can rewrite its own `audit` branch, but
// it is not installed on this repo, so it can't touch the anchors, this code or this workflow.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const SOURCE = 'sabbasi3-factory-lab/chrono-node-rs';
export const ANCHORS_PATH = 'anchors/chrono-node-rs.jsonl';

const DAY_PATH = /^audit\/(\d{4})\/(\d{2})\/(\d{2})\.jsonl$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EVENT_KEYS = 'id,parents,payload,sha,timestamp,type,version';
const ANCHOR_KEYS = 'at,audit_head,events,last_sha,run_id,source,v';
const utf8 = new TextDecoder('utf-8', { fatal: true });

// ---------------------------------------------------------------- canonical JSON

/** Keys sorted by UTF-16 code units, recursively; no whitespace (same as the controller). */
export function canonicalize(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  switch (typeof value) {
    case 'object':
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
        .join(',')}}`;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number');
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    default:
      throw new TypeError(`unsupported type ${typeof value}`);
  }
}

const isRealTime = (s) => typeof s === 'string' && TIMESTAMP.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().replace(/\.\d{3}Z$/, 'Z') === s;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function eventSha(event) {
  const { sha: _omit, ...record } = event;
  return `sha256:${createHash('sha256').update(canonicalize(record)).digest('hex')}`;
}

/** Parses one audit line; throws on anything that isn't a canonical, self-consistent event. */
export function parseEventLine(line) {
  const ev = JSON.parse(line);
  if (!isObject(ev) || Object.keys(ev).sort().join(',') !== EVENT_KEYS) throw new Error('wrong fields');
  if (ev.version !== 1) throw new Error('version is not 1');
  if (typeof ev.id !== 'string' || !UUID_V4.test(ev.id)) throw new Error('id is not a UUID v4');
  if (typeof ev.type !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(ev.type)) throw new Error('invalid type');
  if (!isRealTime(ev.timestamp)) throw new Error('timestamp is not a real UTC second');
  if (!Array.isArray(ev.parents) || ev.parents.length > 1 || !ev.parents.every((p) => typeof p === 'string' && SHA.test(p))) {
    throw new Error('parents is not [] or ["sha256:<hex>"]');
  }
  if (!isObject(ev.payload)) throw new Error('payload is not an object');
  if (typeof ev.sha !== 'string' || !SHA.test(ev.sha)) throw new Error('sha is not sha256:<hex>');
  if (canonicalize(ev) !== line) throw new Error('not canonical JSON');
  if (eventSha(ev) !== ev.sha) throw new Error('sha mismatch');
  return ev;
}

// ---------------------------------------------------------------- the audit log

const fail = (errors) => ({ ok: false, events: [], errors });

/**
 * files: [{ path, content }] = every blob on the audit branch. Only audit/YYYY/MM/DD.jsonl is
 * allowed. Returns { ok, events, errors }.
 */
export function verifyLog(files) {
  const errors = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = [];
  for (const f of sorted) {
    const m = DAY_PATH.exec(f.path);
    if (!m) errors.push(`unexpected file on the audit branch: ${f.path}`);
    else if (f.content === '') errors.push(`${f.path}: empty day file`);
    else if (!f.content.endsWith('\n')) errors.push(`${f.path}: does not end with a newline`);
    else {
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      f.content
        .slice(0, -1)
        .split('\n')
        .forEach((line, i) => lines.push({ line, where: `${f.path}:${i + 1}`, day }));
    }
  }
  if (errors.length > 0) return fail(errors);

  const events = [];
  for (const [i, l] of lines.entries()) {
    const at = `event #${i + 1} (${l.where})`;
    let ev;
    try {
      ev = parseEventLine(l.line);
    } catch (err) {
      return fail([`${at}: ${err.message}`]);
    }
    const prev = events.at(-1);
    if (!prev && ev.parents.length !== 0) return fail([`${at} is not a genesis event (it has a parent): the start of the log is missing`]);
    if (prev && ev.parents[0] !== prev.sha) return fail([`${at}: parent does not match the previous event`]);
    if (prev && ev.timestamp < prev.timestamp) return fail([`${at}: timestamp earlier than the previous event`]);
    if (ev.timestamp.slice(0, 10) !== l.day) return fail([`${at}: not in its own day file`]);
    events.push(ev);
  }
  return { ok: true, events, errors: [] };
}

// ---------------------------------------------------------------- anchors

/** Parses one anchor line; throws unless it is exactly a canonical anchor. */
export function parseAnchorLine(line) {
  const a = JSON.parse(line);
  if (!isObject(a) || Object.keys(a).sort().join(',') !== ANCHOR_KEYS) throw new Error('wrong fields');
  if (a.v !== 1) throw new Error('v is not 1');
  if (a.source !== SOURCE) throw new Error('wrong source');
  if (!isRealTime(a.at)) throw new Error('at is not a real UTC second');
  if (!Number.isSafeInteger(a.events) || a.events < 0) throw new Error('events is not a count');
  if (a.events === 0 ? a.last_sha !== null : typeof a.last_sha !== 'string' || !SHA.test(a.last_sha)) throw new Error('last_sha does not fit events');
  if (!(a.audit_head === null || (typeof a.audit_head === 'string' && COMMIT.test(a.audit_head)))) throw new Error('audit_head is not a commit');
  if (!Number.isSafeInteger(a.run_id) || a.run_id <= 0) throw new Error('run_id is not positive');
  if (canonicalize(a) !== line) throw new Error('not canonical JSON');
  return a;
}

/**
 * versions: an iterable (consumed once, in order) of { commit, parents: [sha], content: string |
 * null } for every commit of the anchors branch, oldest first (content null = the file is
 * missing in that commit). The history must be linear, every commit must contain the file, and
 * each commit may only append (at least one byte). Only the previous and current versions are
 * held at any time, so memory stays proportional to the newest file, not the whole history.
 * Returns { ok, anchors, content, errors } for the newest version.
 */
export function verifyAnchorHistory(versions) {
  const bad = (error) => ({ ok: false, anchors: [], content: null, errors: [error] });
  let prev = null;
  for (const v of versions) {
    const short = v.commit.slice(0, 7);
    const linear = prev === null ? v.parents.length === 0 : v.parents.length === 1 && v.parents[0] === prev.commit;
    if (!linear) return bad(`anchors commit ${short}: history is not linear`);
    if (v.content === null) return bad(`anchors commit ${short}: ${ANCHORS_PATH} is missing`);
    if (prev && !(v.content.length > prev.content.length && v.content.startsWith(prev.content))) {
      return bad(`anchors commit ${short}: anchors were changed or removed, not only appended`);
    }
    prev = { commit: v.commit, content: v.content };
  }
  if (prev === null) return bad('the anchors branch has no commits');
  const content = prev.content;
  if (content === '' || !content.endsWith('\n')) return bad(`${ANCHORS_PATH}: empty or not newline-terminated`);
  const anchors = [];
  for (const [i, line] of content.slice(0, -1).split('\n').entries()) {
    try {
      anchors.push(parseAnchorLine(line));
    } catch (err) {
      return bad(`anchor #${i + 1}: ${err.message}`);
    }
  }
  const errors = [];
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].at < anchors[i - 1].at) errors.push(`anchor #${i + 1}: earlier than anchor #${i}`);
    if (anchors[i].events < anchors[i - 1].events) errors.push(`anchor #${i + 1}: fewer events (${anchors[i].events}) than anchor #${i} (${anchors[i - 1].events})`);
  }
  return { ok: errors.length === 0, anchors, content, errors };
}

/** Checks the verified log against every anchor. */
export function checkAnchors(events, auditHead, anchors) {
  const errors = [];
  if (auditHead === null && anchors.some((a) => a.audit_head !== null)) errors.push('the audit branch is gone, but earlier anchors recorded it');
  for (const [i, a] of anchors.entries()) {
    if (a.events > events.length) {
      errors.push(`log shrank: anchor #${i + 1} (${a.at}) recorded ${a.events} events, the log now has ${events.length}`);
    } else if (a.events > 0 && events[a.events - 1].sha !== a.last_sha) {
      errors.push(`history rewritten: event #${a.events} is ${events[a.events - 1].sha}, anchor #${i + 1} (${a.at}) recorded ${a.last_sha}`);
    }
  }
  return errors;
}

export function nextAnchor({ events, auditHead, at, runId }) {
  return parseAnchorLine(canonicalize({ at, audit_head: auditHead, events: events.length, last_sha: events.at(-1)?.sha ?? null, run_id: runId, source: SOURCE, v: 1 }));
}

/**
 * The whole decision. anchorVersions null = the anchors branch doesn't exist; that's allowed
 * only with bootstrap (a deliberate manual run), never on a schedule.
 */
export function run({ auditFiles, auditHead, anchorVersions, bootstrap, at, runId }) {
  const errors = [];
  let anchors = [];
  let oldContent = '';
  if (anchorVersions === null) {
    if (!bootstrap) errors.push('the anchors branch is missing; creating it needs a manual run with bootstrap=true');
  } else {
    const h = verifyAnchorHistory(anchorVersions);
    errors.push(...h.errors);
    anchors = h.anchors;
    oldContent = h.content ?? '';
  }
  const log = verifyLog(auditHead === null ? [] : auditFiles);
  errors.push(...log.errors);
  if (errors.length === 0) errors.push(...checkAnchors(log.events, auditHead, anchors));
  if (errors.length === 0 && anchors.length > 0 && at <= anchors.at(-1).at) errors.push(`the clock (${at}) is not after the newest anchor (${anchors.at(-1).at})`);
  if (errors.length > 0) return { ok: false, errors, events: log.events.length, anchors: anchors.length, anchor: null, next: null };
  const anchor = nextAnchor({ events: log.events, auditHead, at, runId });
  return { ok: true, errors: [], events: log.events.length, anchors: anchors.length + 1, anchor, next: `${oldContent}${canonicalize(anchor)}\n` };
}

// ---------------------------------------------------------------- git (reads objects only)

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 30 });
}

/** Every entry of a commit's tree as { mode, type, oid, path }. */
export function lsTree(dir, commit) {
  return git(dir, ['ls-tree', '-r', '-z', '--full-tree', commit])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t');
      const [mode, type, oid] = e.slice(0, tab).split(' ');
      return { mode, type, oid, path: e.slice(tab + 1) };
    });
}

/** Blob contents as strict UTF-8; symlinks, submodules and executables are refused. */
export function readBlobs(dir, commit) {
  return lsTree(dir, commit).map((e) => {
    if (e.type !== 'blob' || e.mode !== '100644') throw new Error(`refusing ${e.path} (mode ${e.mode}, ${e.type})`);
    return { path: e.path, content: utf8.decode(git(dir, ['cat-file', 'blob', e.oid])) };
  });
}

/**
 * Every commit of `ref`, oldest first, with the anchors file content at that commit. A generator:
 * each file is read only when the verifier asks for it, so only one or two are held at a time.
 */
export function* readAnchorVersions(dir, ref) {
  const lines = git(dir, ['rev-list', '--reverse', '--parents', ref]).toString('utf8').trim().split('\n').filter(Boolean);
  for (const l of lines) {
    const [commit, ...parents] = l.split(' ');
    const entries = lsTree(dir, commit);
    const extra = entries.find((e) => e.path !== ANCHORS_PATH);
    if (extra) throw new Error(`anchors commit ${commit.slice(0, 7)}: unexpected file ${extra.path}`);
    const file = entries.find((e) => e.path === ANCHORS_PATH);
    if (file && (file.type !== 'blob' || file.mode !== '100644')) throw new Error(`anchors commit ${commit.slice(0, 7)}: ${ANCHORS_PATH} is not a regular file`);
    yield { commit, parents, content: file ? utf8.decode(git(dir, ['cat-file', 'blob', file.oid])) : null };
  }
}

// ---------------------------------------------------------------- CLI

function main(env) {
  const auditHead = env.AUDIT_HEAD || null;
  const anchorsRef = env.ANCHORS_REF || null;
  const runId = Number(env.GITHUB_RUN_ID);
  if (auditHead !== null && !COMMIT.test(auditHead)) throw new Error('AUDIT_HEAD must be a commit SHA or empty');
  if (auditHead !== null && !env.AUDIT_GIT_DIR) throw new Error('AUDIT_GIT_DIR is required');
  if (anchorsRef !== null && !env.ANCHORS_GIT_DIR) throw new Error('ANCHORS_GIT_DIR is required');
  if (!env.NEXT_FILE) throw new Error('NEXT_FILE is required');
  const result = run({
    auditFiles: auditHead === null ? [] : readBlobs(env.AUDIT_GIT_DIR, auditHead),
    auditHead,
    anchorVersions: anchorsRef === null ? null : readAnchorVersions(env.ANCHORS_GIT_DIR, anchorsRef),
    bootstrap: env.BOOTSTRAP === 'true',
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    runId,
  });
  const summary = result.ok
    ? `Verified ${result.events} events from genesis against ${result.anchors - 1} earlier anchors; anchor #${result.anchors} covers ${result.events} events (last ${result.anchor.last_sha ?? '-'}).`
    : `Audit chain verification FAILED:\n${result.errors.map((e) => `- ${e}`).join('\n')}`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (!result.ok) {
    for (const e of result.errors) console.log(`::error::${e}`);
    return 1;
  }
  writeFileSync(env.NEXT_FILE, result.next);
  console.log(summary);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.env);
  } catch (err) {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  }
}
