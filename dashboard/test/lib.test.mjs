import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CADENCE_NOTE, DEFAULTS, anchorTimes, cadenceText, canonicalize, computeEventSha, dailySeries, dayPaths, deriveMetrics, formatAge, formatDuration, formatHours,
  formatLimit, heartbeatLevel, heartbeatTimes, isPlanOnly, limitsText, listSubjects, observedCadence, parseJsonl, stageTimes, statusSummary,
  subjectLabel, timelineFor, verifyChain,
} from '../lib.js';
import { FIXTURE_NOW, FIXTURE_PATH, QUIET_FIXTURE_NOW, QUIET_FIXTURE_PATH, buildFixtureLines, buildQuietFixtureLines } from './make-fixture.mjs';

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
  assert.equal(m.running.available, false);
  assert.equal(m.running.count, null);
  assert.deepEqual(m.running.rows, []);
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

test('heartbeat age turns amber after 8 h and red after 12 h', () => {
  assert.deepEqual([DEFAULTS.heartbeatWarnMin, DEFAULTS.heartbeatAlertMin], [480, 720]);
  const events = fixtureEvents();
  const last = at('2026-10-16T11:00:03Z');
  assert.equal(deriveMetrics(events, { now: last + 480 * 60000 }).heartbeat.level, 'ok');
  assert.equal(deriveMetrics(events, { now: last + 481 * 60000 }).heartbeat.level, 'warn');
  assert.equal(deriveMetrics(events, { now: last + 720 * 60000 }).heartbeat.level, 'warn');
  assert.equal(deriveMetrics(events, { now: last + 721 * 60000 }).heartbeat.level, 'alert');
  assert.equal(heartbeatLevel(null), 'none');
  assert.equal(heartbeatLevel(0), 'ok');
  assert.equal(heartbeatLevel(480), 'ok');
  assert.equal(heartbeatLevel(480.5), 'warn');
  assert.equal(heartbeatLevel(720), 'warn');
  assert.equal(heartbeatLevel(720.5), 'alert');
  // The old hourly-cadence limits no longer flag a normal late scheduled run.
  assert.equal(heartbeatLevel(121), 'ok');
  assert.equal(heartbeatLevel(7.6 * 60), 'ok');
});

test('limits read as people say them', () => {
  assert.equal(formatLimit(480), '8 h');
  assert.equal(formatLimit(720), '12 h');
  assert.equal(formatLimit(1560), '26 h');
  assert.equal(formatLimit(90), '90 min');
  assert.equal(formatLimit(10), '10 min');
  assert.equal(formatLimit(null), '—');
  assert.equal(limitsText(480, 720), 'amber after 8 h, red after 12 h');
  assert.equal(limitsText(480, 1560), 'amber after 8 h, red after 26 h');
});

test('observed cadence: median and longest gap between consecutive times, null below 2 points', () => {
  const t = (iso) => at(iso);
  assert.equal(observedCadence([]), null);
  assert.equal(observedCadence(undefined), null);
  assert.equal(observedCadence([t('2026-10-17T00:00:00Z')]), null);
  assert.equal(observedCadence([t('2026-10-17T00:00:00Z'), 'not a time', NaN, null]), null, 'invalid times are ignored');
  // Unsorted input, ISO strings and epoch ms mixed: gaps 2 h, 3 h, 7.6 h.
  const c = observedCadence(['2026-10-17T05:00:00Z', t('2026-10-17T00:00:00Z'), '2026-10-17T12:36:00Z', t('2026-10-17T02:00:00Z')]);
  assert.deepEqual(c, { count: 4, medianH: 3, maxH: 7.6 });
  // An even number of gaps takes the mean of the middle two.
  assert.deepEqual(observedCadence([0, 3600000, 3 * 3600000, 6 * 3600000, 10 * 3600000]), { count: 5, medianH: 2.5, maxH: 4 });
  assert.deepEqual(observedCadence([0, 1800000]), { count: 2, medianH: 0.5, maxH: 0.5 });

  assert.equal(formatHours(2.4), '2.4 h');
  assert.equal(formatHours(7.6), '7.6 h');
  assert.equal(formatHours(3), '3.0 h');
  assert.equal(formatHours(0.75), '45 min');
  assert.equal(formatHours(null), '—');
  assert.equal(cadenceText('Heartbeats', { count: 21, medianH: 2.4, maxH: 7.6 }, 7), 'Heartbeats: median every 2.4 h, longest gap 7.6 h (7 days)');
  assert.equal(cadenceText('Verifications', null, 1), 'Verifications: too few to measure (1 day)');
  assert.equal(CADENCE_NOTE, 'GitHub runs scheduled jobs late on Free plans');
});

test('cadence inputs: heartbeat times from the events, anchor times within the window', () => {
  const events = fixtureEvents();
  assert.deepEqual(heartbeatTimes(events), ['2026-10-15T09:00:07Z', '2026-10-16T09:00:06Z', '2026-10-16T10:00:04Z', '2026-10-16T11:00:03Z'].map(at));
  assert.deepEqual(heartbeatTimes([{ type: 'heartbeat', timestamp: 17 }, null, { type: 'merged', timestamp: '2026-10-16T10:00:04Z' }]), []);
  const now = at('2026-10-17T12:00:00Z');
  const anchors = [{ at: '2026-10-09T12:00:00Z' }, { at: '2026-10-10T12:00:00Z' }, { at: '2026-10-17T11:00:00Z' }, { at: '2026-10-17T13:00:00Z' }, { at: 'bad' }];
  assert.deepEqual(anchorTimes(anchors, { now, days: 7 }), [at('2026-10-10T12:00:00Z'), at('2026-10-17T11:00:00Z')]);
});

test('the quiet fixture is current, every hash in it is real, and it is the quiet live state', async () => {
  const committed = readFileSync(QUIET_FIXTURE_PATH, 'utf8');
  assert.equal(committed, buildQuietFixtureLines().join('\n') + '\n', 'run: node dashboard/test/make-fixture.mjs');
  const records = parseJsonl(committed, 'quiet.jsonl');
  const chain = await verifyChain(records);
  assert.equal(chain.status, 'verified');
  const events = records.map((r) => r.event);
  const m = deriveMetrics(events, { now: at(QUIET_FIXTURE_NOW) });
  assert.equal(m.needsYou.count, 0);
  assert.equal(m.killSwitch.enabled, false);
  assert.equal(m.dryRun, true);
  assert.equal(m.heartbeat.level, 'ok');
  assert.equal(m.running.rows.length, 0);
  assert.equal(events.filter((e) => e.type === 'merged').length, 10);
  // Heartbeats at the cadence GitHub really delivers: median 2.4 h, worst 7.6 h.
  assert.equal(cadenceText('Heartbeats', observedCadence(heartbeatTimes(events)), 7), 'Heartbeats: median every 2.4 h, longest gap 7.6 h (7 days)');
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

// --- review fixes ---------------------------------------------------------------

const mk = (type, timestamp, payload, dryRun = false) => ({
  type, timestamp, payload: { dedupe_key: 'k', factory_version: 'v', dry_run: dryRun, ...payload },
});

test('review #2: a heartbeat with a non-string timestamp never leaks into heartbeat.at', () => {
  const good = mk('heartbeat', '2026-10-16T09:00:00Z', { factory_enabled: true });
  const bad = { ...mk('heartbeat', '2026-10-16T10:00:00Z', { factory_enabled: false }), timestamp: 1792141200 };
  const now = at('2026-10-16T10:30:00Z');

  const onlyBad = deriveMetrics([bad], { now });
  assert.equal(onlyBad.heartbeat.at, null);
  assert.equal(onlyBad.heartbeat.ageMin, null);
  assert.equal(onlyBad.heartbeat.level, 'none');
  assert.equal(onlyBad.killSwitch.at, null);
  assert.equal(onlyBad.latestAt, null);

  // The latest heartbeat with a usable timestamp is used instead.
  const mixed = deriveMetrics([good, bad], { now });
  assert.equal(mixed.heartbeat.at, '2026-10-16T09:00:00Z');
  assert.equal(Math.round(mixed.heartbeat.ageMin), 90);
  assert.equal(mixed.killSwitch.enabled, true);
});

test('review #2: malformed field types in any event never make derivation throw', () => {
  const junk = [12345, null, true, {}, [], 'not-a-date'];
  for (const [i, value] of junk.entries()) {
    const events = fixtureEvents().map((ev, j) => {
      const p = { ...ev.payload };
      for (const k of Object.keys(p)) if ((j + k.length) % 3 === 0) p[k] = value;
      return { ...ev, timestamp: j % 4 === i % 4 ? value : ev.timestamp, payload: p };
    });
    const m = deriveMetrics(events, { now: at(FIXTURE_NOW) });
    for (const v of [m.heartbeat.at, m.latestAt, ...m.needsYou.items.map((it) => it.since)]) {
      assert.ok(v === null || typeof v === 'string', `string or null, got ${typeof v}`);
    }
    for (const s of listSubjects(events)) timelineFor(events, s.key);
    stageTimes(events);
    events.forEach(subjectLabel);
  }
});

test('review #3: dispatched attempts retire on a later attempt, a merged PR, needs_human or cancelled', () => {
  const finished = mk('run_finished', '2026-10-16T07:00:00Z', { task: 'x/done', attempt: 1, aic: 1 });
  const events = [
    finished,
    mk('dispatched', '2026-10-16T08:00:00Z', { task: 't/a', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('repair_dispatched', '2026-10-16T08:30:00Z', { task: 't/a', attempt: 2, effect: 'dispatch', reason: 'ci-failed' }),
    mk('dispatched', '2026-10-16T08:00:00Z', { task: 't/b', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('pr_opened', '2026-10-16T08:20:00Z', { pr: 11, task: 't/b', author: 'bot' }),
    mk('merged', '2026-10-16T08:40:00Z', { pr: 11, merge_commit_sha: 'a'.repeat(40) }), // task via the PR
    mk('dispatched', '2026-10-16T08:00:00Z', { task: 't/c', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('needs_human', '2026-10-16T08:50:00Z', { task: 't/c', effect: 'label', reason: 'same-failure-signature' }),
    mk('dispatched', '2026-10-16T08:00:00Z', { task: 't/d', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('cancelled', '2026-10-16T08:55:00Z', { task: 't/d', effect: 'close', reason: 'owner' }),
    mk('dispatched', '2026-10-16T08:00:00Z', { task: 't/e', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('needs_human', '2026-10-16T08:58:00Z', { task: 't/e', effect: 'label', reason: 'plan' }, true), // a plan: t/e keeps running
  ];
  const m = deriveMetrics(events, { now: at('2026-10-16T09:00:00Z') });
  assert.equal(m.running.available, true);
  assert.deepEqual(m.running.rows.map((r) => r.key).sort(), ['t/a#a2', 't/e#a1']);
  assert.equal(m.running.count, 2);
  assert.equal(m.running.retired, 4);
});

test('review #3: without any run_finished, active-run status is unavailable, not a count', () => {
  const events = [
    mk('dispatched', '2026-10-10T08:00:00Z', { task: 't/a', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('dispatched', '2026-10-11T08:00:00Z', { task: 't/b', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('dispatched', '2026-10-12T08:00:00Z', { task: 't/c', attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('dispatched', '2026-10-13T08:00:00Z', { task: 't/d', attempt: 1, effect: 'dispatch', reason: 'ready' }),
  ];
  const m = deriveMetrics(events, { now: at('2026-10-16T09:00:00Z') });
  assert.equal(m.running.available, false);
  assert.equal(m.running.count, null); // no false "4 / 3" WIP alert
  assert.equal(m.running.rows.length, 4); // still listed as not yet retired
  assert.equal(deriveMetrics([], { now: at('2026-10-16T09:00:00Z') }).running.available, false);
  assert.equal(deriveMetrics(fixtureEvents(), { now: at(FIXTURE_NOW) }).running.available, true);
});

test('review #4: dry-run dispatch decisions do not resolve needs-you items; observed facts do', () => {
  const dry = true;
  const base = [
    mk('needs_human', '2026-10-16T08:00:00Z', { task: 't/a', issue: 1, effect: 'label', reason: 'r' }, dry),
    mk('stale_contract', '2026-10-16T08:01:00Z', { task: 't/b', issue: 2, effect: 'hold', reason: 'contract-changed' }, dry),
    mk('needs_human', '2026-10-16T08:02:00Z', { task: 't/c', issue: 3, pr: 30, effect: 'label', reason: 'r' }, dry),
    mk('needs_human', '2026-10-16T08:03:00Z', { task: 't/d', issue: 4, pr: 40, effect: 'label', reason: 'r' }, dry),
  ];
  const events = [
    ...base,
    mk('dispatched', '2026-10-16T09:00:00Z', { task: 't/a', issue: 1, attempt: 2, effect: 'dispatch', reason: 'retry' }, dry),
    mk('repair_dispatched', '2026-10-16T09:00:00Z', { task: 't/b', issue: 2, attempt: 2, effect: 'dispatch', reason: 'retry' }, dry),
    mk('picked', '2026-10-16T09:00:00Z', { task: 't/b', issue: 2, effect: 'pick', reason: 'priority' }, dry),
    mk('human_action', '2026-10-16T09:10:00Z', { action: 'review', pr: 30, reviewer: 'owner', state: 'approved', submitted_at: '2026-10-16T09:09:00Z' }, dry),
    mk('merged', '2026-10-16T09:20:00Z', { pr: 40, merge_commit_sha: 'b'.repeat(40), merged_at: '2026-10-16T09:19:00Z' }, dry),
  ];
  const m = deriveMetrics(events, { now: at('2026-10-16T10:00:00Z') });
  assert.deepEqual(m.needsYou.items.map((i) => i.task), ['t/a', 't/b']);
  assert.equal(m.running.dryRunPlanned, 2);

  // The same decisions outside dry run do resolve.
  const live = events.map((ev) => (ev.type === 'dispatched' || ev.type === 'repair_dispatched'
    ? { ...ev, payload: { ...ev.payload, dry_run: false } } : ev));
  assert.deepEqual(deriveMetrics(live, { now: at('2026-10-16T10:00:00Z') }).needsYou.items, []);

  assert.equal(isPlanOnly(mk('dispatched', 'x', {}, true)), true);
  assert.equal(isPlanOnly(mk('budget_pause', 'x', { effect: 'pause' }, true)), true);
  assert.equal(isPlanOnly(mk('human_action', 'x', {}, true)), false);
  assert.equal(isPlanOnly(mk('merged', 'x', {}, true)), false);
  assert.equal(isPlanOnly(mk('dispatched', 'x', {}, false)), false);
});

// --- header status (follow-up #1) -----------------------------------------------

test('status line never reads as healthy while the heartbeat is late, stale or missing', () => {
  const events = fixtureEvents();
  const lastHb = at('2026-10-16T11:00:03Z');
  const base = { loaded: true, eventCount: events.length, headSha: 'abcdef0123456789abcdef0123456789abcdef01', days: 7 };
  const hbAt = (min) => deriveMetrics(events, { now: lastHb + min * 60000 }).heartbeat;

  const fresh = statusSummary({ ...base, heartbeat: hbAt(12) });
  assert.equal(fresh.level, 'ok');
  assert.equal(fresh.text, 'Data fresh · 46 events · audit head abcdef0 · controller heartbeat ok');

  assert.equal(statusSummary({ ...base, heartbeat: hbAt(480) }).level, 'ok');
  const late = statusSummary({ ...base, heartbeat: hbAt(481) });
  assert.equal(late.level, 'warn');
  assert.match(late.text, /^Data fresh .* · controller heartbeat late \(over 8 h\)$/);

  assert.equal(statusSummary({ ...base, heartbeat: hbAt(720) }).level, 'warn');
  const stale = statusSummary({ ...base, heartbeat: hbAt(12 * 60 + 5) });
  assert.equal(stale.level, 'alert');
  assert.match(stale.text, /^Data fresh .* · controller heartbeat stale \(12 h\)$/);
  assert.doesNotMatch(stale.text, /Up to date/);

  const none = statusSummary({ ...base, heartbeat: deriveMetrics([], { now: lastHb }).heartbeat });
  assert.equal(none.level, 'alert');
  assert.match(none.text, /no controller heartbeat in the last 7 days$/);

  // Fail closed: no heartbeat information at all is not healthy.
  assert.equal(statusSummary({ ...base, heartbeat: null }).level, 'warn');
  assert.match(statusSummary({ ...base, heartbeat: null }).text, /controller heartbeat unknown$/);

  assert.equal(statusSummary({ loaded: false }).level, 'info');
  const noLog = statusSummary({ loaded: true, noLog: true });
  assert.equal(noLog.level, 'warn');
  assert.match(noLog.text, /no controller heartbeat/);
  const err = statusSummary({ ...base, error: 'GitHub API error (HTTP 502).', heartbeat: hbAt(12) });
  assert.equal(err.level, 'alert');
  assert.match(err.text, /^Problem: GitHub API error \(HTTP 502\)\. Showing the last data loaded · controller heartbeat ok$/);
  assert.match(statusSummary({ ...base, fixture: true, heartbeat: hbAt(12) }).text, /^Sample data · 46 events · /);

  assert.equal(formatAge(null), 'unknown');
  assert.equal(formatAge(119.9), '119 min');
  assert.equal(formatAge(180), '3 h');
  assert.equal(formatAge(3 * 1440 + 5), '3 d');
});

test('AIC today comes from the newest real spend_snapshot (measured + reserved), not only run_finished', () => {
  const base = { dedupe_key: 'k', factory_version: 'v' };
  const snap = (timestamp, aic_today, runs, dry_run = false) => ({ type: 'spend_snapshot', timestamp, payload: { ...base, dry_run, day: timestamp.slice(0, 10), aic_today, runs, runs_total: runs.length } });
  const events = [
    snap('2026-10-21T22:00:00Z', 31.38, [{ run_id: 1, status: 'measured', aic: 31.38 }]),
    snap('2026-10-22T18:37:16Z', 2700, [{ run_id: 2, status: 'reserved', aic: 900 }, { run_id: 3, status: 'reserved', aic: 900 }, { run_id: 4, status: 'reserved', aic: 900 }]),
    snap('2026-10-22T18:42:36Z', 967.24, [{ run_id: 2, status: 'measured', aic: 32.09 }, { run_id: 3, status: 'measured', aic: 35.15 }, { run_id: 4, status: 'reserved', aic: 900 }]),
    snap('2026-10-22T18:50:00Z', 99999, [], true), // dry-run: ignored
  ];
  const m = deriveMetrics(events, { now: at('2026-10-22T19:00:00Z') });
  assert.equal(m.aicToday.total, 967.24);
  assert.equal(m.aicToday.source, 'spend_snapshot');
  assert.equal(Math.round(m.aicToday.measured * 100) / 100, 67.24);
  assert.equal(m.aicToday.reserved, 900);
  assert.equal(m.aicToday.runs, 3);
  assert.equal(m.aicToday.at, '2026-10-22T18:42:36Z');
  // Days without a snapshot fall back to run_finished; the daily series uses each day's snapshot.
  assert.equal(deriveMetrics(events, { now: at('2026-10-23T00:10:00Z') }).aicToday.total, 0);
  assert.equal(deriveMetrics(events, { now: at('2026-10-23T00:10:00Z') }).aicToday.source, null);
  const s = dailySeries(events, { now: at('2026-10-22T19:00:00Z'), days: 2 });
  assert.deepEqual(s.aic, [31.38, 967.24]);
  // A truncated run list (the controller lists at most 50): the total stands, the split is unavailable.
  const many = Array.from({ length: 50 }, (_, i) => ({ run_id: 100 + i, status: 'measured', aic: 30 }));
  const trunc = deriveMetrics([{ ...snap('2026-10-22T18:59:00Z', 1530, many), payload: { ...snap('2026-10-22T18:59:00Z', 1530, many).payload, runs_total: 51 } }], { now: at('2026-10-22T19:00:00Z') }).aicToday;
  assert.deepEqual([trunc.total, trunc.measured, trunc.reserved, trunc.runs, trunc.listed], [1530, null, null, 51, 50]);
  // A larger run_finished total today raises it, as in the controller.
  const more = [...events, { type: 'run_finished', timestamp: '2026-10-22T18:55:00Z', payload: { ...base, dry_run: false, task: 't/a', attempt: 1, aic: 1200 } }];
  assert.equal(deriveMetrics(more, { now: at('2026-10-22T19:00:00Z') }).aicToday.total, 1200);
});
