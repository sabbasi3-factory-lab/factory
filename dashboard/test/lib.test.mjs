import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  canonicalize, computeEventSha, dayPaths, deriveMetrics, formatDuration, heartbeatLevel,
  parseJsonl, stageTimes, timelineFor, verifyChain,
} from '../lib.js';
import { FIXTURE_NOW, FIXTURE_PATH, buildFixtureLines } from './make-fixture.mjs';

const nodeSha = (text) => 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
const at = (iso) => Date.parse(iso);

// A hand-built event whose canonical form is written out literally below.
const KNOWN = {
  version: 1,
  id: '6f1c2e4a-8b3d-4c5e-9f7a-1b2c3d4e5f60',
  type: 'dispatched',
  timestamp: '2026-10-20T14:03:11Z',
  parents: [],
  payload: {
    task: 'en/weekday-parser',
    issue: 42,
    attempt: 2,
    contract_sha: 'a1b2c3d',
    reason: 'ci-failed',
    effect: 'dispatch',
    dry_run: false,
    factory_version: 'f4c1a9e',
    dedupe_key: 'sha256:00',
  },
};
const KNOWN_CANONICAL =
  '{"id":"6f1c2e4a-8b3d-4c5e-9f7a-1b2c3d4e5f60","parents":[],"payload":{"attempt":2,"contract_sha":"a1b2c3d",' +
  '"dedupe_key":"sha256:00","dry_run":false,"effect":"dispatch","factory_version":"f4c1a9e","issue":42,' +
  '"reason":"ci-failed","task":"en/weekday-parser"},"timestamp":"2026-10-20T14:03:11Z","type":"dispatched","version":1}';

function fixtureEvents() {
  return parseJsonl(readFileSync(FIXTURE_PATH, 'utf8'), 'sample.jsonl').map((r) => r.event);
}

async function chainOf(specs, firstParent = null) {
  const lines = [];
  let parent = firstParent;
  for (const [i, spec] of specs.entries()) {
    const ev = {
      version: 1,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      type: spec.type,
      timestamp: spec.timestamp,
      parents: parent ? [parent] : [],
      payload: { dedupe_key: `k${i}`, factory_version: 'v1', dry_run: true, ...spec.payload },
    };
    ev.sha = await computeEventSha(ev);
    parent = ev.sha;
    lines.push(canonicalize(ev));
  }
  return lines;
}

// --- canonical JSON ---------------------------------------------------------

test('canonical JSON sorts keys recursively with no whitespace', () => {
  assert.equal(canonicalize(KNOWN), KNOWN_CANONICAL);
  assert.equal(canonicalize({ b: [3, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[3,{"c":null,"d":1}]}');
});

test('canonical JSON sorts by UTF-16 code units and prints primitives like JSON.stringify', () => {
  // "Z" (0x5A) < "a" (0x61) < "é" (0xE9) < "😀" (surrogate 0xD83D) < "ｚ" (0xFF5A)
  assert.equal(canonicalize({ ｚ: 1, '😀': 2, é: 3, a: 4, Z: 5 }), '{"Z":5,"a":4,"é":3,"😀":2,"ｚ":1}');
  assert.equal(canonicalize({ n: 1e21, f: 0.1, neg: -0, s: 'line\n"q"\u2028', t: true }), '{"f":0.1,"n":1e+21,"neg":0,"s":"line\\n\\"q\\"\u2028","t":true}');
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize({}), '{}');
  assert.throws(() => canonicalize({ x: NaN }));
});

// --- sha verification ---------------------------------------------------------

test('event sha matches SHA-256 of the canonical record computed with node:crypto', async () => {
  const expected = nodeSha(KNOWN_CANONICAL);
  assert.equal(await computeEventSha(KNOWN), expected);
  // The sha field itself is excluded from the hash.
  assert.equal(await computeEventSha({ ...KNOWN, sha: 'sha256:whatever' }), expected);
  const chain = await verifyChain(parseJsonl(canonicalize({ ...KNOWN, sha: expected }), 'x'));
  assert.equal(chain.status, 'verified');
  assert.equal(chain.windowStart, 'genesis');
});

test('fixture is current and every hash in it is real', async () => {
  const committed = readFileSync(FIXTURE_PATH, 'utf8');
  assert.equal(committed, buildFixtureLines().join('\n') + '\n', 'run: node dashboard/test/make-fixture.mjs');
  const records = parseJsonl(committed, 'sample.jsonl');
  for (const { event } of records) {
    const { sha, ...rest } = event;
    assert.equal(sha, nodeSha(canonicalize(rest)));
  }
  const chain = await verifyChain(records);
  assert.equal(chain.status, 'verified');
  assert.equal(chain.total, records.length);
});

// --- chain checks -------------------------------------------------------------

const SPECS = [
  { type: 'heartbeat', timestamp: '2026-10-16T09:00:00Z', payload: { factory_enabled: true } },
  { type: 'pr_opened', timestamp: '2026-10-16T09:10:00Z', payload: { pr: 3 } },
  { type: 'heartbeat', timestamp: '2026-10-16T10:00:00Z', payload: { factory_enabled: true } },
  { type: 'merged', timestamp: '2026-10-16T10:30:00Z', payload: { pr: 3 } },
];

test('a window whose first event points outside it is "window start", not broken', async () => {
  const outside = 'sha256:' + 'ab'.repeat(32);
  const chain = await verifyChain(parseJsonl((await chainOf(SPECS, outside)).join('\n'), 'd'));
  assert.equal(chain.status, 'verified');
  assert.equal(chain.windowStart, 'window-start');
  assert.equal(chain.results[0].link, 'window-start');
});

test('a tampered payload is detected at that event', async () => {
  const lines = await chainOf(SPECS);
  lines[2] = lines[2].replace('"factory_enabled":true', '"factory_enabled":false');
  const chain = await verifyChain(parseJsonl(lines.join('\n'), 'd'));
  assert.equal(chain.status, 'broken');
  assert.equal(chain.brokenAt, 3);
  assert.match(chain.brokenReason, /sha mismatch/);
  assert.equal(chain.brokenSource, 'd:3');
});

test('a removed event breaks the parent chain at the next event', async () => {
  const lines = await chainOf(SPECS);
  lines.splice(1, 1);
  const chain = await verifyChain(parseJsonl(lines.join('\n'), 'd'));
  assert.equal(chain.status, 'broken');
  assert.equal(chain.brokenAt, 2);
  assert.match(chain.brokenReason, /parent does not match/);
});

test('re-ordered events break the chain', async () => {
  const lines = await chainOf(SPECS);
  [lines[1], lines[2]] = [lines[2], lines[1]];
  const chain = await verifyChain(parseJsonl(lines.join('\n'), 'd'));
  assert.equal(chain.brokenAt, 2);
});

test('unparseable lines, a second genesis and schema violations are reported', async () => {
  const lines = await chainOf(SPECS);
  const bad = await verifyChain(parseJsonl([lines[0], '{not json', lines[1]].join('\n'), 'd'));
  assert.equal(bad.brokenAt, 2);
  assert.match(bad.brokenReason, /invalid JSON/);

  const second = await verifyChain(parseJsonl([lines[0], ...(await chainOf(SPECS.slice(0, 1)))].join('\n'), 'd'));
  assert.equal(second.brokenAt, 2);
  assert.match(second.brokenReason, /second genesis/);

  const ev = JSON.parse(lines[0]);
  ev.extra = 1;
  ev.sha = await computeEventSha(ev);
  const schema = await verifyChain(parseJsonl(JSON.stringify(ev), 'd'));
  assert.equal(schema.status, 'broken');
  assert.match(schema.brokenReason, /unexpected extra/);
});

// --- metrics ------------------------------------------------------------------

test('empty input gives empty, well-defined metrics', async () => {
  assert.deepEqual(parseJsonl('', 'x'), []);
  assert.deepEqual(parseJsonl('\n\n', 'x'), []);
  const chain = await verifyChain([]);
  assert.equal(chain.status, 'empty');
  assert.equal(chain.brokenAt, null);
  const m = deriveMetrics([], { now: at(FIXTURE_NOW) });
  assert.equal(m.eventCount, 0);
  assert.equal(m.heartbeat.ageMin, null);
  assert.equal(m.heartbeat.level, 'none');
  assert.equal(m.killSwitch.enabled, null);
  assert.equal(m.factoryVersion, null);
  assert.equal(m.dryRun, null);
  assert.equal(m.running.count, 0);
  assert.equal(m.queue.count, 0);
  assert.equal(m.mergedToday.count, 0);
  assert.equal(m.zeroTouch.rate, null);
  assert.equal(m.aicToday.total, 0);
  assert.equal(m.needsYou.count, 0);
  assert.deepEqual(m.tokensPerTask.rows, []);
  assert.deepEqual(m.stageTimes, []);
  assert.deepEqual(m.checks, []);
  assert.deepEqual(m.subjects, []);
});

test('fixture metrics: tiles', () => {
  const m = deriveMetrics(fixtureEvents(), { now: at(FIXTURE_NOW) });
  assert.equal(Math.round(m.heartbeat.ageMin), 12);
  assert.equal(m.heartbeat.level, 'ok');
  assert.equal(m.killSwitch.enabled, true);
  assert.equal(m.factoryVersion, 'f4c1a9e');
  assert.equal(m.dryRun, false);
  // month-parser repair (a2) and casual-date (a1); the dry-run dispatch is not running.
  assert.equal(m.running.count, 2);
  assert.deepEqual(m.running.rows.map((r) => r.key).sort(), ['en/casual-date#a1', 'en/month-parser#a2']);
  assert.equal(m.running.dryRunPlanned, 1);
  assert.equal(m.running.wipLimit, 3);
  // PR 9: queued, dequeued, queued again. PRs 5, 6 and 7 were merged.
  assert.equal(m.queue.count, 1);
  assert.deepEqual(m.queue.items.map((q) => q.pr), [9]);
  assert.deepEqual(m.mergedToday, { count: 1, prs: [7] });
  // Factory PRs 6 (reviewed) and 7 (no human action); PR 5 has no task, so it's not a factory PR.
  assert.deepEqual(m.zeroTouch, { merged: 2, untouched: 1, rate: 0.5 });
  // 312 + 410 today; yesterday's 280 is excluded.
  assert.equal(m.aicToday.total, 722);
  assert.equal(m.aicToday.level, 'ok');
  assert.deepEqual(m.needsYou.items.map((i) => [i.kind, i.task]), [
    ['needs_human', 'en/time-expression'],
    ['stale_contract', 'en/relative'],
  ]);
});

test('fixture metrics: tables', () => {
  const events = fixtureEvents();
  const m = deriveMetrics(events, { now: at(FIXTURE_NOW) });
  const tokens = Object.fromEntries(m.tokensPerTask.rows.map((r) => [r.task, r.aic]));
  assert.deepEqual(tokens, { 'en/ordinal': 280, 'en/weekday-parser': 312, 'en/month-parser': 410 });
  assert.equal(m.tokensPerTask.total.aic, 1002);
  assert.equal(m.tokensPerTask.total.tokens_input, 812000 + 905000 + 1130000);

  const weekday = m.stageTimes.find((r) => r.key === 'task:en/weekday-parser');
  assert.equal(weekday.current, 'deployed');
  assert.equal(weekday.durations.ready.ms, 5 * 60000);
  assert.equal(weekday.durations.queued.to, 'merged');
  assert.equal(weekday.totalMs, at('2026-10-16T09:25:00Z') - at('2026-10-16T08:00:00Z'));
  const pr9 = m.stageTimes.find((r) => r.key === 'pr:9');
  assert.deepEqual(pr9.durations['pr-open'].to, 'queued'); // checks were skipped

  assert.equal(m.checks[0].payload.prs[0], 8);
  assert.equal(m.checks[0].payload.heldout_seed, '9007199254740993');

  const tl = timelineFor(events, 'task:en/month-parser');
  assert.deepEqual(tl.map((t) => t.event.type), ['picked', 'dispatched', 'run_finished', 'pr_opened', 'check_result', 'repair_dispatched']);
  assert.equal(tl[0].gapMs, null);
  assert.equal(tl[1].gapMs, 30000);
});

test('heartbeat age turns amber after 70 min and red after 120 min', () => {
  const events = fixtureEvents();
  const last = at('2026-10-16T11:00:03Z');
  assert.equal(deriveMetrics(events, { now: last + 70 * 60000 }).heartbeat.level, 'ok');
  assert.equal(deriveMetrics(events, { now: last + 71 * 60000 }).heartbeat.level, 'warn');
  assert.equal(deriveMetrics(events, { now: last + 121 * 60000 }).heartbeat.level, 'alert');
  assert.equal(heartbeatLevel(null), 'none');
  assert.equal(heartbeatLevel(120), 'warn');
});

test('needs-you items close when the task moves again; kill switch and budget levels', () => {
  const base = { dedupe_key: 'k', factory_version: 'v', dry_run: false };
  const ev = (type, timestamp, payload) => ({ type, timestamp, payload: { ...base, ...payload } });
  const events = [
    ev('needs_human', '2026-10-16T08:00:00Z', { task: 't/a', issue: 1, reason: 'r', effect: 'label' }),
    ev('needs_human', '2026-10-16T08:01:00Z', { task: 't/b', issue: 2, reason: 'r', effect: 'label' }),
    ev('stale_contract', '2026-10-16T08:02:00Z', { task: 't/c', issue: 3, reason: 'contract-changed', effect: 'hold' }),
    ev('dispatched', '2026-10-16T09:00:00Z', { task: 't/a', issue: 1, attempt: 2, reason: 'retry', effect: 'dispatch' }),
    ev('run_finished', '2026-10-16T09:30:00Z', { task: 't/a', attempt: 2, aic: 8500 }),
    ev('heartbeat', '2026-10-16T10:00:00Z', { factory_enabled: false }),
  ];
  const m = deriveMetrics(events, { now: at('2026-10-16T10:05:00Z') });
  assert.deepEqual(m.needsYou.items.map((i) => i.task), ['t/b', 't/c']);
  assert.equal(m.killSwitch.enabled, false);
  assert.equal(m.running.count, 0);
  assert.equal(m.aicToday.total, 8500);
  assert.equal(m.aicToday.level, 'warn');
  assert.equal(deriveMetrics(events, { now: at('2026-10-17T00:00:01Z') }).aicToday.total, 0);
});

test('zero-touch is n/a until a factory PR merges, and human PRs never count', () => {
  const base = { dedupe_key: 'k', factory_version: 'v', dry_run: true };
  const events = [
    { type: 'pr_opened', timestamp: '2026-10-16T08:00:00Z', payload: { ...base, pr: 1, author: 'someone' } },
    { type: 'merged', timestamp: '2026-10-16T09:00:00Z', payload: { ...base, pr: 1, merged_at: '2026-10-16T08:59:00Z' } },
  ];
  const m = deriveMetrics(events, { now: at('2026-10-16T10:00:00Z') });
  assert.equal(m.zeroTouch.rate, null);
  assert.equal(m.mergedToday.count, 1);
  assert.equal(m.dryRun, true);
});

test('helpers: day paths, durations and stage times', () => {
  assert.deepEqual(dayPaths(at('2026-03-02T05:00:00Z'), 3), [
    'audit/2026/02/28.jsonl', 'audit/2026/03/01.jsonl', 'audit/2026/03/02.jsonl',
  ]);
  assert.equal(dayPaths(at(FIXTURE_NOW)).length, 7);
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(125000), '2m 5s');
  assert.equal(formatDuration(3 * 3600000 + 60000), '3h 1m');
  assert.equal(formatDuration(3 * 86400000), '3d 0h');
  assert.deepEqual(stageTimes([]), []);
});
