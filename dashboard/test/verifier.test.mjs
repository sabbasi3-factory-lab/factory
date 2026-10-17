import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERIFIER_LIMITS, canonicalize, parseAnchors, validateAnchor, verifierStatus } from '../lib.js';
import { ANCHORS_FIXTURE_PATH, FIXTURE_NOW, buildAnchorLines } from './make-fixture.mjs';

const NOW = Date.parse('2026-10-17T06:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const minutesAgo = (min) => iso(NOW - min * 60000);
const anchor = (over = {}) => ({
  at: minutesAgo(13),
  audit_head: 'ab12cd3'.padEnd(40, '0'),
  events: 41,
  last_sha: 'sha256:' + 'e'.repeat(64),
  run_id: 1234,
  source: 'sabbasi3-factory-lab/chrono-node-rs',
  v: 1,
  ...over,
});
const file = (...anchors) => anchors.map((a) => (typeof a === 'string' ? a : canonicalize(a))).join('\n') + '\n';
const status = (text, now = NOW) => verifierStatus({ status: 'ok', text }, now);

test('verifier: a valid anchors file reads as verified, with age and anchor count', () => {
  const text = file(
    anchor({ at: minutesAgo(180), audit_head: null, events: 0, last_sha: null, run_id: 1 }),
    anchor({ at: minutesAgo(120), events: 40, run_id: 2 }),
    anchor({ at: minutesAgo(60), events: 40, run_id: 3 }),
    anchor({ at: minutesAgo(23), events: 1041, run_id: 4 }),
  );
  const { anchors, problem } = parseAnchors(text);
  assert.equal(problem, null);
  assert.equal(anchors.length, 4);
  const s = status(text);
  assert.deepEqual([s.level, s.reason, s.count], ['ok', 'verifier-fresh', 4]);
  assert.equal(s.chip, 'Verified 23 min ago · 4 anchors');
  assert.equal(s.line, 'Independent verifier: last run 23 min ago, 4 anchors, newest covers 1,041 events (audit head ab12cd3).');
  assert.equal(s.newest.run_id, 4);
  // No trailing newline is fine too; one anchor reads singular.
  assert.equal(status(canonicalize(anchor({ at: minutesAgo(5) }))).chip, 'Verified 5 min ago · 1 anchor');
  assert.match(status(file(anchor({ audit_head: null }))).line, /\(no audit head\)/);
});

test('verifier: the committed anchors fixture is current and verified at the fixture clock', () => {
  const committed = readFileSync(ANCHORS_FIXTURE_PATH, 'utf8');
  assert.equal(committed, buildAnchorLines().join('\n') + '\n', 'run: node dashboard/test/make-fixture.mjs');
  const s = status(committed, Date.parse(FIXTURE_NOW));
  assert.equal(s.level, 'ok');
  assert.equal(s.count, 26);
});

test('verifier: a malformed line anywhere makes the whole file unknown (alert)', () => {
  const good = anchor({ at: minutesAgo(70), run_id: 1 });
  const cases = [
    ['{not json', 'invalid JSON'],
    ['', 'blank line'],
    [canonicalize({ ...anchor(), extra: 1 }), 'unexpected extra'],
    [canonicalize((({ run_id, ...rest }) => rest)(anchor())), 'missing run_id'],
    [canonicalize(anchor({ v: 2 })), 'v is not 1'],
    [canonicalize(anchor({ at: '2026-10-17T05:47:12.000Z' })), 'at is not'],
    [canonicalize(anchor({ at: '2026-09-31T05:47:12Z' })), 'at is not'],
    [canonicalize(anchor({ audit_head: 'AB12CD3'.padEnd(40, '0') })), 'audit_head'],
    [canonicalize(anchor({ audit_head: 'ab12cd3' })), 'audit_head'],
    [canonicalize(anchor({ events: -1 })), 'events'],
    [canonicalize(anchor({ events: 1.5 })), 'events'],
    [canonicalize(anchor({ events: '41' })), 'events'],
    [canonicalize(anchor({ last_sha: null })), 'last_sha'],
    [canonicalize(anchor({ last_sha: 'e'.repeat(64) })), 'last_sha'],
    [canonicalize(anchor({ events: 0 })), 'last_sha is not null'],
    [canonicalize(anchor({ run_id: 0 })), 'run_id'],
    [canonicalize(anchor({ source: 'someone/else' })), 'source'],
    [JSON.stringify(anchor(), null, 1).replace(/\n/g, ''), 'not canonical'],
    [JSON.stringify({ v: 1, ...anchor() }), 'not canonical'],
    ['[]', 'not an object'],
  ];
  for (const [line, reason] of cases) {
    const text = file(good, line, anchor({ run_id: 3 }));
    const { problem } = parseAnchors(text);
    assert.equal(problem?.line, 2, line);
    assert.ok(problem.reason.includes(reason), `${line}: ${problem.reason}`);
    const s = status(text);
    assert.deepEqual([s.level, s.reason], ['alert', 'verifier-malformed'], line);
    assert.equal(s.chip, 'Verifier unknown · bad anchor line 2');
  }
  assert.deepEqual(validateAnchor(anchor()), []);
});

test('verifier: newest anchor in the future is an alert, not ok', () => {
  const s = status(file(anchor({ at: minutesAgo(30), run_id: 1 }), anchor({ at: iso(NOW + 60000), run_id: 2 })));
  assert.deepEqual([s.level, s.reason], ['alert', 'verifier-future']);
  assert.match(s.chip, /^Verifier unknown/);
  // Exactly now is fine.
  assert.equal(status(file(anchor({ at: iso(NOW) }))).level, 'ok');
});

test('verifier: anchors that go back in events or time are an alert', () => {
  const down = status(file(anchor({ at: minutesAgo(60), events: 41 }), anchor({ at: minutesAgo(10), events: 40 })));
  assert.deepEqual([down.level, down.reason], ['alert', 'verifier-out-of-order']);
  assert.match(down.title, /line 2: events goes down/);
  const back = status(file(anchor({ at: minutesAgo(10) }), anchor({ at: minutesAgo(60) })));
  assert.deepEqual([back.level, back.reason], ['alert', 'verifier-out-of-order']);
  // Equal `at` and equal `events` are allowed (non-decreasing).
  assert.equal(status(file(anchor({ run_id: 1 }), anchor({ run_id: 2 }))).level, 'ok');
});

test('verifier: an empty or unreadable file is unknown (alert), never ok', () => {
  for (const text of ['', '\n']) {
    const s = status(text);
    assert.equal(s.level, 'alert', JSON.stringify(text));
  }
  assert.equal(status('').reason, 'verifier-empty');
  assert.equal(status('\n').reason, 'verifier-malformed'); // a blank line, not an empty file
  const err = verifierStatus({ status: 'error', detail: 'HTTP 500' }, NOW);
  assert.deepEqual([err.level, err.reason, err.chip], ['alert', 'verifier-unreadable', 'Verifier unknown · unreadable']);
  assert.match(err.line, /HTTP 500/);
  assert.equal(verifierStatus(undefined, NOW).level, 'alert');
  assert.equal(verifierStatus({ status: 'pending' }, NOW).level, 'info');
});

test('verifier: a 404 reads as "not set up yet" (warn), not an alert', () => {
  const s = verifierStatus({ status: 'missing' }, NOW);
  assert.deepEqual([s.level, s.reason, s.chip], ['warn', 'verifier-not-set-up', 'Verifier not set up yet']);
  assert.match(s.line, /^Independent verifier: not set up yet/);
});

test('verifier: ok up to 2 h, warn after, alert after 26 h', () => {
  assert.deepEqual([VERIFIER_LIMITS.warnMin, VERIFIER_LIMITS.alertMin], [120, 1560]);
  const at = (min) => status(file(anchor({ at: minutesAgo(min) })));
  assert.equal(at(0).level, 'ok');
  assert.equal(at(120).level, 'ok');
  assert.deepEqual([at(121).level, at(121).reason], ['warn', 'verifier-late']);
  assert.equal(at(121).chip, 'Verified 2 h ago · 1 anchor');
  assert.equal(at(1560).level, 'warn');
  assert.deepEqual([at(1561).level, at(1561).reason], ['alert', 'verifier-stale']);
  assert.equal(at(3000).chip, 'Verified 2 d ago · 1 anchor');
});
