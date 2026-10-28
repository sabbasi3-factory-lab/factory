// The one-screen redesign: the closed rule for in-flight work (bug 1), the cost join (bug 2), the
// 14-day stage medians (bug 3), and the new aggregates: the task catalog and board, the key
// numbers, quality, human touch, liveness, recent activity, the status line and relative times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AREA_LABELS, areaLabel, costJoin, deriveMetrics, dropClosed, fallbackCatalog, formatUsd, humanTouch, isClosedRef, issueToMerged, liveness, medianTaskCost,
  parseContract, parseJsonl, parseRunTitle, parseTaskmap, qualityStats, recentActivity, relativeTime, runSpend, shortDuration, shortTaskName, snapshotRunIds,
  stageSummary, stageTimes, stateLine, taskBoard, taskCatalog,
} from '../lib.js';
import { FIXTURE_NOW, FIXTURE_PATH, META_FIXTURE_PATH, QUIET_META_FIXTURE_PATH, buildMeta, buildQuietMeta, metaText } from './make-fixture.mjs';

const at = (iso) => Date.parse(iso);
const MIN = 60000;
const HOUR = 60 * MIN;
let seq = 0;
const ev = (type, timestamp, payload, dryRun = false) => ({ id: `e${seq++}`, type, timestamp, payload: { dedupe_key: 'k', factory_version: 'v', dry_run: dryRun, ...payload } });
const cat = (...ids) => taskCatalog(ids.map((id) => ({ id, area: id.startsWith('common/') ? 'common-parsers' : 'en-casual' })));

// --- relative times and formats -------------------------------------------------------

test('relative times are short and never ISO; durations have at most two units; AIC reads as dollars', () => {
  const now = at('2026-10-28T19:00:00Z');
  assert.equal(relativeTime(now - 10000, now), 'just now');
  assert.equal(relativeTime(now - 23 * MIN, now), '23m ago');
  assert.equal(relativeTime(now - 5 * HOUR - 59 * MIN, now), '5h ago');
  assert.equal(relativeTime(now - 47 * HOUR, now), '47h ago');
  assert.equal(relativeTime(now - 3 * 24 * HOUR, now), '3d ago');
  assert.equal(relativeTime(now + 56 * MIN, now), 'in 56m');
  assert.equal(relativeTime(null, now), '—');
  assert.equal(shortDuration(45000), '45s');
  assert.equal(shortDuration(9 * MIN), '9m');
  assert.equal(shortDuration(5 * HOUR + 12 * MIN), '5h 12m');
  assert.equal(shortDuration(3 * 24 * HOUR + 4 * HOUR), '3d 4h');
  assert.equal(shortDuration(null), '—');
  assert.equal(formatUsd(32.78), '$0.33');
  assert.equal(formatUsd(1631.6), '$16.32');
  assert.equal(formatUsd(10000), '$100');
  assert.equal(formatUsd(123456), '$1,235');
  assert.equal(formatUsd(undefined), '—');
});

// --- task map and contracts ---------------------------------------------------------------

const TASKMAP = `# Task map
version: 1
upstream_root: upstream/src

done:
  - { step: ENCasualDateParser, rust: src/a.rs }

tasks:
  # --- common ---
  - { id: common/iso-format-parser, step: ISOFormatParser, source: "common/parsers/ISOFormatParser.ts", rust: src/x.rs, area: common-parsers }
  - id: common/extract-timezone-abbr-refiner
    step: ExtractTimezoneAbbrRefiner
    area: common-refiners # where it lives
    unit:
      requirement: >-
        Keep upstream's optional constructor map, area: not-this-one
      cases:
        - { test: no_map, text: "at 10:00 XYZ", id: not-a-task, expect: { text: "at 10:00" } }
  - { id: en/month-name-parser, step: ENMonthNameParser, area: 'en-month-names' }
  - { id: drill/gate-perf, area: drill }

acceptance:
  differential: { phrases: 2000, seed: 42 }
`;

test('task map: flow and block entries in order, nested lists, comments and quotes; other sections ignored', () => {
  assert.deepEqual(parseTaskmap(TASKMAP), [
    { id: 'common/iso-format-parser', area: 'common-parsers' },
    { id: 'common/extract-timezone-abbr-refiner', area: 'common-refiners' },
    { id: 'en/month-name-parser', area: 'en-month-names' },
    { id: 'drill/gate-perf', area: 'drill' },
  ]);
  assert.deepEqual(parseTaskmap(''), []);
  assert.deepEqual(parseTaskmap('tasks:\n  - { step: NoId }\n'), []);
});

test('contracts: top-level fields, `[]`, flow and block dependency lists', () => {
  const block = parseContract(`# Generated
id: common/iso-format-parser
title: Port ISOFormatParser
tier: auto-strict
area: common-parsers
priority: 6
scope:
  - src/common/parsers/iso_format.rs
depends_on:
  - common/overlap-removal-refiner
  - "common/forward-date-refiner"
acceptance:
  - golden:
      step: ISOFormatParser
      areas:
        - en/general
upstream_class: ISOFormatParser
`);
  assert.deepEqual(block, {
    id: 'common/iso-format-parser', title: 'Port ISOFormatParser', tier: 'auto-strict', area: 'common-parsers',
    dependsOn: ['common/overlap-removal-refiner', 'common/forward-date-refiner'], upstreamClass: 'ISOFormatParser',
  });
  assert.deepEqual(parseContract('id: en/a\ntier: auto\ndepends_on: []\n').dependsOn, []);
  assert.deepEqual(parseContract('id: en/a\ndepends_on: [en/b, "en/c"]\n').dependsOn, ['en/b', 'en/c']);
  assert.deepEqual(parseContract('').dependsOn, []);
});

test('catalog: task map joined with contracts, drills dropped, short names and readable area labels', () => {
  const entries = parseTaskmap(TASKMAP);
  const contracts = new Map([['common/iso-format-parser', { id: 'common/iso-format-parser', title: 'Port ISOFormatParser', tier: 'auto-strict', area: 'common-parsers', dependsOn: ['x/y'], upstreamClass: 'ISOFormatParser' }]]);
  const c = taskCatalog(entries, contracts);
  assert.deepEqual(c.map((t) => [t.id, t.short, t.area, t.tier, t.contract]), [
    ['common/iso-format-parser', 'iso-format-parser', 'common-parsers', 'auto-strict', true],
    ['common/extract-timezone-abbr-refiner', 'extract-timezone-abbr-refiner', 'common-refiners', null, false],
    ['en/month-name-parser', 'month-name-parser', 'en-month-names', null, false],
  ]);
  assert.deepEqual(c[0].dependsOn, ['x/y']);
  assert.equal(shortTaskName('en/time-unit-ago-format-parser'), 'time-unit-ago-format-parser');
  assert.equal(areaLabel('en-month-names'), 'Month names');
  assert.equal(areaLabel('common-refiners'), 'Common refiners');
  assert.equal(areaLabel('en-new-things'), 'New things');
  assert.equal(areaLabel(null), AREA_LABELS.other);
  // Without the task map: the non-drill tasks seen in the events.
  const fb = fallbackCatalog([ev('dispatched', '2026-10-27T10:00:00Z', { task: 'drill/x' }), ev('dispatched', '2026-10-27T10:00:00Z', { task: 'en/a' }), ev('merged', '2026-10-27T11:00:00Z', { task: 'en/a' })]);
  assert.deepEqual(fb.map((t) => [t.id, t.area]), [['en/a', 'en-tasks']]);
});

// --- bug 1: closed work leaves every in-flight view ---------------------------------------

// The live drills that sat in "Running": issue 114 / PR 122, 116 / 127, 117 / 131, all closed.
const drillEvents = () => [
  ev('dispatched', '2026-10-27T14:50:00Z', { task: 'drill/gate-semver', issue: 114, attempt: 1, effect: 'dispatch_workflow:implement' }),
  ev('repair_dispatched', '2026-10-27T14:56:35Z', { task: 'drill/gate-semver', issue: 114, pr: 122, attempt: 2, reason: 'ci_failed', run_id: 1 }),
  ev('repair_dispatched', '2026-10-27T16:24:00Z', { task: 'drill/gate-perf', issue: 116, pr: 127, attempt: 2, reason: 'ci_failed', run_id: 2 }),
  ev('repair_dispatched', '2026-10-27T16:57:35Z', { task: 'drill/gate-code-health', issue: 117, pr: 131, attempt: 2, reason: 'ci_failed', run_id: 3 }),
  ev('task_done', '2026-10-27T17:00:00Z', { task: 'en/other', issue: 9, effect: 'close_task' }), // live task_done: run status is known
];

test('bug 1: closed drill PRs #122, #127 and #131 leave Running once the open set is known', () => {
  const now = at('2026-10-28T19:00:00Z');
  const m = deriveMetrics(drillEvents(), { now });
  assert.deepEqual(m.running.rows.map((r) => [r.task, r.pr]).sort(), [['drill/gate-code-health', 131], ['drill/gate-perf', 127], ['drill/gate-semver', 122]]);
  const dropped = dropClosed(m, new Set([5, 6]), now);
  assert.deepEqual(dropped.running.rows, []);
  assert.equal(dropped.running.count, 0);
  assert.equal(dropped.running.closedDropped, 3);
  // Unknown open set: nothing is hidden on a guess.
  assert.equal(dropClosed(m, null, now).running.rows.length, 3);
  // A snapshot older than the work can't know about it: kept.
  assert.equal(dropClosed(m, new Set(), at('2026-10-27T15:00:00Z')).running.rows.length, 2);
});

test('bug 1: the closed rule is one function: issue or current PR closed, never on unknown or newer data', () => {
  const asOf = at('2026-10-28T12:00:00Z');
  const t = at('2026-10-28T10:00:00Z');
  assert.equal(isClosedRef({ issue: 114, pr: 122, at: t }, new Set(), asOf), true);
  assert.equal(isClosedRef({ issue: 114, pr: 122, at: t }, new Set([114]), asOf), true, 'a closed PR is enough');
  assert.equal(isClosedRef({ issue: 114, pr: 122, at: t }, new Set([114, 122]), asOf), false);
  assert.equal(isClosedRef({ issue: 114, pr: null, at: t }, new Set([114]), asOf), false);
  assert.equal(isClosedRef({ issue: 114, at: t }, null, asOf), false, 'unknown open set');
  assert.equal(isClosedRef({ issue: 114, at: asOf + 1 }, new Set(), asOf), false, 'newer than the snapshot');
  assert.equal(isClosedRef({ issue: 114, at: null }, new Set(), asOf), false, 'unknown start');
  assert.equal(isClosedRef({ at: t }, new Set(), asOf), false, 'nothing to check');
});

test('bug 1: the board applies the same rule: a closed issue or PR is not running; drills never show', () => {
  const events = [
    ...drillEvents(),
    ev('dispatched', '2026-10-28T09:00:00Z', { task: 'en/a', issue: 31, attempt: 1 }),
    ev('pr_opened', '2026-10-28T09:10:00Z', { task: 'en/a', pr: 40, opened_at: '2026-10-28T09:10:00Z' }),
    ev('dispatched', '2026-10-28T09:00:00Z', { task: 'en/b', issue: 32, attempt: 1 }),
  ];
  const catalog = cat('en/a', 'en/b');
  const board = (open, asOf) => Object.fromEntries(taskBoard(events, catalog, { open, asOf }).tasks.map((t) => [t.id, [t.state, t.reason]]));
  assert.deepEqual(board(null, null), { 'en/a': ['running', 'PR open'], 'en/b': ['running', 'implement agent running'] });
  const asOf = at('2026-10-28T12:00:00Z');
  assert.deepEqual(board(new Set([31, 40, 32]), asOf), { 'en/a': ['running', 'PR open'], 'en/b': ['running', 'implement agent running'] });
  assert.deepEqual(board(new Set([31, 32]), asOf), { 'en/a': ['waiting', 'issue or PR closed without a merge'], 'en/b': ['running', 'implement agent running'] });
  assert.deepEqual(board(new Set([40]), asOf), { 'en/a': ['waiting', 'issue or PR closed without a merge'], 'en/b': ['waiting', 'issue or PR closed without a merge'] });
  assert.deepEqual(board(new Set(), at('2026-10-28T09:05:00Z')), { 'en/a': ['running', 'PR open'], 'en/b': ['waiting', 'issue or PR closed without a merge'] }, 'newer work is kept');
  assert.equal(taskBoard(events, cat('en/a', 'drill/gate-perf'), {}).total, 1);
});

// --- the board, tasks done and the status line ---------------------------------------------

test('board states: done, running, needs you and waiting (dependency, ready, not seen), with tier counts', () => {
  const events = [
    ev('auto_ready', '2026-10-27T10:00:00Z', { task: 'common/a', issue: 1, reason: 'deps_merged' }),
    ev('dispatched', '2026-10-27T10:00:05Z', { task: 'common/a', issue: 1, attempt: 1 }),
    ev('merged', '2026-10-27T10:30:00Z', { task: 'common/a', pr: 11, merged_at: '2026-10-27T10:29:00Z' }),
    ev('task_done', '2026-10-27T10:30:00Z', { task: 'common/a', issue: 1, pr: 11, effect: 'close_task' }),
    ev('dispatched', '2026-10-27T11:00:00Z', { task: 'en/b', issue: 2, attempt: 1 }),
    ev('needs_human', '2026-10-27T11:30:00Z', { task: 'en/b', issue: 2, pr: 12, reason: 'review_objected', effect: 'label:needs-human' }),
    ev('repair_dispatched', '2026-10-27T12:00:00Z', { task: 'en/c', issue: 3, pr: 13, attempt: 2 }),
    ev('auto_ready', '2026-10-27T12:00:00Z', { task: 'en/d', issue: 4 }),
    ev('dispatched', '2026-10-27T12:00:00Z', { task: 'en/e', issue: 5, attempt: 1 }, true), // a dry-run plan
  ];
  const catalog = taskCatalog(['common/a', 'en/b', 'en/c', 'en/d', 'en/e', 'en/f'].map((id) => ({ id, area: 'x' })), new Map([
    ['common/a', { tier: 'auto-strict', dependsOn: [] }],
    ['en/b', { tier: 'auto', dependsOn: [] }],
    ['en/c', { tier: 'auto', dependsOn: [] }],
    ['en/d', { tier: 'auto', dependsOn: ['common/a'] }],
    ['en/e', { tier: 'auto', dependsOn: [] }],
    ['en/f', { tier: 'auto', dependsOn: ['en/c'] }],
  ]));
  const m = deriveMetrics(events, { now: at('2026-10-27T13:00:00Z') });
  const b = taskBoard(events, catalog, { needsItems: m.needsYou.items });
  assert.deepEqual(b.tasks.map((t) => [t.id, t.state, t.reason]), [
    ['common/a', 'done', 'merged'],
    ['en/b', 'needs', 'review_objected'],
    ['en/c', 'running', 'repair agent running'],
    ['en/d', 'waiting', 'ready, waiting for a free slot'],
    ['en/e', 'waiting', 'not started'],
    ['en/f', 'waiting', 'waiting on c'],
  ]);
  assert.equal(b.tasks[0].since, at('2026-10-27T10:29:00Z'));
  assert.equal(b.tasks[0].issue, 1);
  assert.deepEqual(b.counts, { done: 1, running: 1, needs: 1, waiting: 3 });
  assert.deepEqual(b.byTier, { 'auto-strict': { done: 1, total: 1 }, auto: { done: 0, total: 5 } });
  assert.equal(b.readyWaiting, 1);
  assert.equal(taskBoard(events, cat('en/z')).tasks[0].reason, 'no events in the loaded window');
  // A new attempt after a merge reopens the task.
  const reopened = taskBoard([...events, ev('dispatched', '2026-10-27T14:00:00Z', { task: 'common/a', issue: 1, attempt: 2 })], catalog, {});
  assert.equal(reopened.tasks[0].state, 'running');
});

test('status line: paused, running, waiting on you, all done, ready, dependencies, in plain English', () => {
  const board = (counts, extra = {}) => ({ counts: { done: 0, running: 0, needs: 0, waiting: 0, ...counts }, total: Object.values(counts).reduce((a, b) => a + b, 0), readyWaiting: 0, ...extra });
  assert.deepEqual(stateLine({ board: board({ done: 26 }) }), { text: 'Idle: all 26 tasks done', level: 'ok' });
  assert.deepEqual(stateLine({ board: board({ running: 2, done: 3 }) }), { text: 'Running: 2 tasks', level: 'info' });
  assert.deepEqual(stateLine({ board: board({ running: 1 }) }), { text: 'Running: 1 task', level: 'info' });
  assert.deepEqual(stateLine({ board: board({ running: 1 }), dispatch: { state: 'paused', reason: 'budget_pause' } }), { text: 'Paused: daily AI budget reached', level: 'warn' });
  assert.deepEqual(stateLine({ board: board({ done: 1 }), dispatch: { state: 'paused', reason: 'budget_unknown' } }).text, 'Paused: spend unknown');
  // The kill switch has its own chip, so the state describes the work.
  assert.deepEqual(stateLine({ board: board({ done: 3 }), dispatch: { state: 'paused', reason: 'kill_switch' } }).text, 'Idle: all 3 tasks done');
  assert.deepEqual(stateLine({ board: board({ needs: 2, done: 1 }) }), { text: 'Waiting on you: 2 tasks', level: 'warn' });
  assert.deepEqual(stateLine({ board: board({ waiting: 3, done: 1 }, { readyWaiting: 3 }) }).text, 'Waiting: 3 tasks ready');
  assert.deepEqual(stateLine({ board: board({ waiting: 4, done: 1 }) }).text, 'Waiting: 4 tasks on dependencies');
  assert.deepEqual(stateLine({ board: board({}) }).text, 'Idle: no tasks yet');
  assert.deepEqual(stateLine({ loaded: false }).level, 'loading');
});

// --- bug 2: the cost join ------------------------------------------------------------------

const snap = (timestamp, runs, dryRun = false) => ev('spend_snapshot', timestamp, { day: timestamp.slice(0, 10), aic_today: runs.reduce((a, r) => a + r.aic, 0), runs, runs_total: runs.length }, dryRun);
const run = (id, workflow, created_at, display_title) => ({ id, workflow, created_at, display_title });

test('run titles: "Implement|Repair <task> #<issue> attempt <n>", anything else is null', () => {
  assert.deepEqual(parseRunTitle('Implement common/iso-format-parser #29 attempt 1'), { workflow: 'implement', task: 'common/iso-format-parser', issue: 29, attempt: 1 });
  assert.deepEqual(parseRunTitle('  Repair common/forward-date-refiner #28 attempt 2 '), { workflow: 'repair', task: 'common/forward-date-refiner', issue: 28, attempt: 2 });
  for (const bad of ['Implement one factory task', 'Review one factory PR', 'Implement en/a #x attempt 1', 'Implement en/a #3', 'implement en/a #3 attempt 1 extra', '', null]) {
    assert.equal(parseRunTitle(bad), null, String(bad));
  }
});

test('spend: the latest measured value per run id; reserved never replaces a measurement; dry runs ignored', () => {
  const events = [
    snap('2026-10-27T10:00:00Z', [{ run_id: 1, aic: 900, status: 'reserved' }, { run_id: 2, aic: 10, status: 'measured' }]),
    snap('2026-10-27T10:10:00Z', [{ run_id: 1, aic: 31.5, status: 'measured' }, { run_id: 2, aic: 12, status: 'measured' }, { run_id: 3, aic: 900, status: 'reserved' }]),
    snap('2026-10-27T10:20:00Z', [{ run_id: 1, aic: 900, status: 'reserved' }, { run_id: 4, aic: 0, status: 'no_inference' }]),
    snap('2026-10-27T10:30:00Z', [{ run_id: 5, aic: 77, status: 'measured' }], true),
  ];
  const { measured, reservedOnly } = runSpend(events);
  assert.deepEqual([...measured].map(([id, m]) => [id, m.aic, m.status, m.day]), [[2, 12, 'measured', '2026-10-27'], [1, 31.5, 'measured', '2026-10-27'], [4, 0, 'no_inference', '2026-10-27']]);
  assert.deepEqual(reservedOnly, [3]);
  assert.deepEqual([...snapshotRunIds(events)].sort(), [1, 2, 3, 4]);
});

test('bug 2: per-task AIC joins snapshots with the run lists: titles, dispatch-time matching, drills, unknown runs', () => {
  const now = at('2026-10-28T19:00:00Z');
  const events = [
    ev('dispatched', '2026-10-22T18:34:30Z', { task: 'en/old', issue: 40, attempt: 1 }),
    ev('dispatched', '2026-10-27T10:00:00Z', { task: 'en/a', issue: 1, attempt: 1 }),
    ev('repair_dispatched', '2026-10-27T10:30:00Z', { task: 'en/a', issue: 1, pr: 11, attempt: 2, run_id: 999 }),
    ev('review_dispatched', '2026-10-27T11:00:00Z', { task: 'en/a', issue: 1, pr: 11, run_id: 998 }),
    ev('review_dispatched', '2026-10-27T12:00:00Z', { task: 'common/b', issue: 2, pr: 12, run_id: 997 }),
    ev('review_dispatched', '2026-10-27T14:00:00Z', { task: 'common/c', issue: 3, pr: 13, run_id: 996 }),
    ev('dispatched', '2026-10-27T15:00:00Z', { task: 'drill/gate-perf', issue: 116, attempt: 1 }),
    snap('2026-10-22T19:00:00Z', [{ run_id: 100, aic: 20, status: 'measured' }]),
    snap('2026-10-27T16:00:00Z', [101, 102, 103, 104, 105, 106, 107, 108].map((run_id, i) => ({ run_id, aic: (i + 1) * 10, status: 'measured' }))),
  ];
  const runs = [
    run(100, 'implement', '2026-10-22T18:34:40Z', 'Implement one factory task'), // untitled: matched to its dispatch by time
    run(101, 'implement', '2026-10-27T10:00:09Z', 'Implement en/a #1 attempt 1'),
    run(102, 'repair', '2026-10-27T10:30:08Z', 'Repair en/a #1 attempt 2'),
    run(103, 'review', '2026-10-27T11:02:00Z', 'Review one factory PR'), // en/a's review
    run(104, 'review', '2026-10-27T12:05:00Z', 'Review one factory PR'), // nearest to common/b's dispatch
    run(105, 'review', '2026-10-27T12:20:00Z', 'Review one factory PR'), // a second run for the same event: unattributed
    run(106, 'review', '2026-10-27T14:31:00Z', 'Review one factory PR'), // 31 min after common/c's dispatch: too late
    run(107, 'implement', '2026-10-27T15:00:10Z', 'Implement drill/gate-perf #116 attempt 1'),
    // 108 is in a snapshot but in no list (older than the 100 listed runs): unattributed, unknown workflow.
  ];
  const c = costJoin(events, runs, { now, days: 14 });
  assert.equal(c.known, true);
  assert.deepEqual(c.perTask.map((r) => [r.task, r.aic, r.runs]), [['en/a', 60, 3], ['common/b', 40, 1], ['en/old', 20, 1]]);
  assert.equal(c.total, 20 + 360);
  assert.equal(c.drillAic, 70);
  assert.equal(c.unattributed, 50 + 60 + 80);
  assert.equal(c.unattributedRuns, 3);
  assert.deepEqual(c.unknownRunIds, [108]);
  assert.equal(c.measuredRuns, 9);
  assert.deepEqual(Object.fromEntries(Object.entries(c.byWorkflow).map(([w, x]) => [w, [x.runs, x.measured, x.aic]])), {
    implement: [3, 3, 20 + 10 + 70], repair: [1, 1, 20], review: [4, 4, 30 + 40 + 50 + 60], unknown: [0, 1, 80],
  });
  assert.equal(c.perDay.days.length, 14);
  assert.equal(c.perDay.days.at(-1), '2026-10-28');
  assert.equal(c.perDay.aic[c.perDay.days.indexOf('2026-10-22')], 20);
  assert.equal(c.perDay.aic[c.perDay.days.indexOf('2026-10-27')], 360);
  // A run created before its event never matches.
  const early = costJoin([ev('review_dispatched', '2026-10-27T11:00:00Z', { task: 'en/a' }), snap('2026-10-27T12:00:00Z', [{ run_id: 1, aic: 5, status: 'measured' }])],
    [run(1, 'review', '2026-10-27T10:59:00Z', 'Review one factory PR')], { now });
  assert.deepEqual([early.perTask, early.unattributed], [[], 5]);
  // A titled run claims its dispatch, so an untitled one can't take it.
  const claimed = costJoin([ev('dispatched', '2026-10-27T10:00:00Z', { task: 'en/a', attempt: 1 }), snap('2026-10-27T12:00:00Z', [{ run_id: 1, aic: 5, status: 'measured' }, { run_id: 2, aic: 7, status: 'measured' }])],
    [run(1, 'implement', '2026-10-27T10:00:05Z', 'Implement en/a #1 attempt 1'), run(2, 'implement', '2026-10-27T10:00:06Z', 'Implement one factory task')], { now });
  assert.deepEqual([claimed.perTask.map((r) => [r.task, r.aic]), claimed.unattributed], [[['en/a', 5]], 7]);
  // Without the run lists: totals still known, nothing attributed.
  const unknown = costJoin(events, null, { now });
  assert.deepEqual([unknown.known, unknown.total, unknown.perTask, unknown.unattributed], [false, 380, [], 380]);
  // Median over the done tasks with attributed cost.
  assert.deepEqual(medianTaskCost(c, ['en/a', 'common/b', 'en/none']), { medianAic: 50, count: 2 });
  assert.deepEqual(medianTaskCost(c, []), { medianAic: null, count: 0 });
});

// --- bug 3 and the 14-day medians -----------------------------------------------------------

test('bug 3: "where the time goes" is the median per stage over tasks merged in the last 14 days, labelled by task', () => {
  const now = at('2026-10-28T19:00:00Z');
  const task = (id, day, runMin, prMin, queueMin) => {
    const t0 = at(`${day}T10:00:00Z`);
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return [
      ev('auto_ready', iso(t0), { task: id, issue: 1 }),
      ev('dispatched', iso(t0 + MIN), { task: id, issue: 1, attempt: 1 }),
      ev('pr_opened', iso(t0 + (1 + runMin) * MIN), { task: id, pr: 50, opened_at: iso(t0 + (1 + runMin) * MIN) }),
      ev('queued', iso(t0 + (1 + runMin + prMin) * MIN), { task: id, pr: 50, at: iso(t0 + (1 + runMin + prMin) * MIN) }),
      ev('merged', iso(t0 + (1 + runMin + prMin + queueMin) * MIN), { task: id, pr: 50, merged_at: iso(t0 + (1 + runMin + prMin + queueMin) * MIN) }),
    ];
  };
  const events = [
    ...task('en/early', '2026-10-10', 18 * 60, 60, 60), // merged 18 days ago: out of the window
    ...task('en/a', '2026-10-22', 5, 2, 1),
    ...task('en/b', '2026-10-23', 7, 4, 1),
    ...task('common/c', '2026-10-27', 100, 3, 2),
    ...task('drill/d', '2026-10-27', 50, 50, 50),
    ev('pr_opened', '2026-10-27T10:00:00Z', { pr: 90, opened_at: '2026-10-27T10:00:00Z' }),
    ev('merged', '2026-10-27T11:00:00Z', { pr: 90, merged_at: '2026-10-27T11:00:00Z' }),
  ];
  // stageTimes() keys PRs by their task; give each task its own PR number.
  let pr = 50;
  for (const e of events) if (e.payload.task && e.payload.pr === 50) e.payload.pr = pr + ['en/early', 'en/a', 'en/b', 'common/c', 'drill/d'].indexOf(e.payload.task);
  const ss = stageSummary(stageTimes(events), { now, days: 14 });
  assert.deepEqual(ss.rows.map((r) => r.label), ['a', 'b', 'c']);
  assert.deepEqual(ss.median.segments.map((s) => [s.stage, s.ms / MIN, s.tasks]), [['ready', 1, 3], ['running', 7, 3], ['pr-open', 3, 3], ['queued', 1, 3]]);
  assert.equal(ss.median.totalMs, 12 * MIN);
  assert.deepEqual([ss.insight.stage, ss.insight.label, Math.round(ss.insight.pct)], ['running', 'Agent running', 58]);
  assert.equal(ss.maxMs, 106 * MIN);
  assert.deepEqual(stageSummary([], { now }), { rows: [], median: null, maxMs: 0, insight: null, days: 14 });
});

test('issue → merged: first auto_ready (else first real dispatch) to the last merge, non-drill tasks merged in 14 days', () => {
  const now = at('2026-10-28T19:00:00Z');
  const events = [
    ev('auto_ready', '2026-10-27T10:00:00Z', { task: 'common/a', issue: 1 }),
    ev('dispatched', '2026-10-27T10:05:00Z', { task: 'common/a', issue: 1, attempt: 1 }),
    ev('merged', '2026-10-27T10:30:00Z', { pr: 11, task: 'common/a', merged_at: '2026-10-27T10:23:00Z' }),
    ev('dispatched', '2026-10-27T09:00:00Z', { task: 'en/b', issue: 2, attempt: 1 }, true), // a plan: ignored
    ev('dispatched', '2026-10-27T11:00:00Z', { task: 'en/b', issue: 2, attempt: 1 }),
    ev('pr_opened', '2026-10-27T11:05:00Z', { pr: 12, task: 'en/b' }),
    ev('merged', '2026-10-27T11:40:00Z', { pr: 12, merged_at: '2026-10-27T11:40:00Z' }), // task via the PR
    ev('dispatched', '2026-10-27T12:00:00Z', { task: 'drill/x', issue: 3, attempt: 1 }),
    ev('merged', '2026-10-27T12:09:00Z', { pr: 13, task: 'drill/x', merged_at: '2026-10-27T12:09:00Z' }),
    ev('dispatched', '2026-10-10T12:00:00Z', { task: 'en/old', issue: 4, attempt: 1 }),
    ev('merged', '2026-10-10T13:00:00Z', { pr: 14, task: 'en/old', merged_at: '2026-10-10T13:00:00Z' }),
  ];
  const r = issueToMerged(events, { now });
  assert.deepEqual(r.items.map((i) => [i.task, i.ms / MIN]).sort(), [['common/a', 23], ['en/b', 40]]);
  assert.equal(r.medianMs, 31.5 * MIN);
  assert.equal(r.count, 2);
  assert.deepEqual(issueToMerged([], { now }), { medianMs: null, count: 0, items: [] });
});

// --- quality and human touch -------------------------------------------------------------------

test('quality: reverts and objections without drills, escaped defects once per main commit, repair success', () => {
  const sha = (c) => c.repeat(40);
  const events = [
    ev('merged', '2026-10-26T17:25:35Z', { pr: 89, task: null, merge_commit_sha: sha('f') }),
    ev('check_result', '2026-10-26T17:27:19Z', { workflow: 'ci', event: 'push', conclusion: 'failure', head_sha: sha('f'), prs: [] }),
    ev('check_result', '2026-10-26T17:30:00Z', { workflow: 'ci', event: 'push', conclusion: 'failure', head_sha: sha('f'), prs: [] }), // a re-run: same defect
    ev('check_result', '2026-10-26T17:31:00Z', { workflow: 'gates', event: 'push', conclusion: 'failure', head_sha: sha('e'), prs: [] }), // not ci
    ev('check_result', '2026-10-26T17:32:00Z', { workflow: 'ci', event: 'pull_request', conclusion: 'failure', head_sha: sha('d'), prs: [3] }), // not main
    ev('merged', '2026-10-27T16:11:41Z', { pr: 125, task: 'drill/post-merge', merge_commit_sha: sha('0') }),
    ev('check_result', '2026-10-27T16:12:00Z', { workflow: 'ci', event: 'push', conclusion: 'failure', head_sha: sha('0'), prs: [] }), // the drill's own failure
    ev('auto_revert', '2026-10-27T16:14:40Z', { pr: 125, task: 'drill/post-merge', merge_commit_sha: sha('0'), revert_pr: 126 }),
    ev('auto_revert', '2026-10-27T16:20:00Z', { pr: 130, task: 'en/real', merge_commit_sha: sha('1'), revert_pr: 131 }),
    ev('needs_human', '2026-10-27T14:41:38Z', { task: 'drill/reviewer-objects', reason: 'review_objected', issue: 111, pr: 118 }),
    ev('needs_human', '2026-10-27T18:17:44Z', { task: 'common/abbr', reason: 'review_objected', issue: 26, pr: 136 }),
    // Repairs: slash merged with no hand-off in between (worked); forward got a hand-off first (failed); a drill's doesn't count.
    ev('repair_dispatched', '2026-10-27T19:26:59Z', { task: 'common/slash', issue: 32, pr: 141, attempt: 2 }),
    ev('merged', '2026-10-27T19:59:00Z', { task: 'common/slash', pr: 141 }),
    ev('repair_dispatched', '2026-10-27T20:36:24Z', { task: 'common/forward', issue: 28, pr: 143, attempt: 2 }),
    ev('needs_human', '2026-10-27T20:47:21Z', { task: 'common/forward', reason: 'repeated_signature', issue: 28, pr: 143 }),
    ev('merged', '2026-10-27T22:15:00Z', { task: 'common/forward', pr: 143 }),
    ev('repair_dispatched', '2026-10-27T16:24:00Z', { task: 'drill/gate-perf', issue: 116, pr: 127, attempt: 2 }),
    ev('repair_dispatched', '2026-10-27T23:00:00Z', { task: 'common/pending', issue: 40, pr: 150, attempt: 2 }),
  ];
  const q = qualityStats(events);
  assert.equal(q.reverts, 1);
  assert.deepEqual(q.escaped, { count: 1, shas: [sha('f')] });
  assert.equal(q.objections, 1);
  assert.deepEqual(q.repairs, { succeeded: 1, failed: 1, pending: 1, rate: 0.5 });
  assert.deepEqual(qualityStats([]), { reverts: 0, escaped: { count: 0, shas: [] }, objections: 0, repairs: { succeeded: 0, failed: 0, pending: 0, rate: null } });
});

test('human touch: actions in the last 7 days (reviews, enqueues by a person) and the median time to unblock', () => {
  const now = at('2026-10-28T19:00:00Z');
  const events = [
    ev('human_action', '2026-10-20T10:00:00Z', { action: 'review', pr: 1, reviewer: 'owner', state: 'COMMENTED', submitted_at: '2026-10-20T10:00:00Z' }), // 8 days ago
    ev('human_action', '2026-10-27T10:00:00Z', { action: 'review', pr: 2, reviewer: 'owner', state: 'COMMENTED', submitted_at: '2026-10-27T10:00:00Z' }),
    ev('human_action', '2026-10-27T10:05:00Z', { action: 'label', pr: 2, reviewer: 'owner' }),
    ev('queued', '2026-10-27T10:10:00Z', { pr: 2, actor: 'owner', at: '2026-10-27T10:10:00Z' }),
    ev('queued', '2026-10-27T10:20:00Z', { pr: 3, actor: 'factory-controller[bot]', at: '2026-10-27T10:20:00Z' }),
    // Hand-offs: re-dispatched after 60 min; unblocked by a review of its PR after 30 min; a drill; one still open.
    ev('needs_human', '2026-10-27T18:00:00Z', { task: 'common/a', issue: 26, pr: 136, reason: 'review_objected' }),
    ev('dispatched', '2026-10-27T19:00:00Z', { task: 'common/a', issue: 26, attempt: 2 }),
    ev('needs_human', '2026-10-27T20:00:00Z', { task: 'common/b', issue: 28, pr: 143, reason: 'repeated_signature' }),
    ev('human_action', '2026-10-27T20:30:00Z', { action: 'review', pr: 143, reviewer: 'owner', submitted_at: '2026-10-27T20:30:00Z' }),
    ev('needs_human', '2026-10-27T14:00:00Z', { task: 'drill/x', issue: 111, pr: 118, reason: 'review_objected' }),
    ev('task_done', '2026-10-27T14:05:00Z', { task: 'drill/x', issue: 111, effect: 'close_task' }),
    ev('needs_human', '2026-10-28T10:00:00Z', { task: 'en/c', issue: 30, reason: 'implement_no_pr' }),
  ];
  const x = humanTouch(events, { now, days: 7 });
  assert.deepEqual([x.total, x.reviews, x.other, x.enqueues], [4, 2, 1, 1]);
  assert.equal(x.medianResolveMs, 45 * MIN);
  assert.deepEqual([x.resolved, x.unresolved], [2, 1]);
  // The task closing resolves it too.
  const closed = humanTouch([events[5], ev('task_done', '2026-10-27T18:20:00Z', { task: 'common/a', issue: 26, effect: 'close_task' })], { now });
  assert.equal(closed.medianResolveMs, 20 * MIN);
});

// --- liveness and recent activity ----------------------------------------------------------------

test('liveness: last poll from controller events; next poll ~10 min later with work in flight, else the next hour', () => {
  const events = [
    ev('heartbeat', '2026-10-28T18:31:45Z', { factory_enabled: true }),
    ev('check_result', '2026-10-28T18:40:00Z', { workflow: 'ci', conclusion: 'success' }), // not a controller poll
  ];
  const now = at('2026-10-28T19:04:00Z');
  const idle = liveness(events, { now });
  assert.deepEqual(idle, { lastAt: at('2026-10-28T18:31:45Z'), lastType: 'heartbeat', nextAt: at('2026-10-28T20:00:00Z'), mode: 'cron', followUpMissed: false });
  const busy = liveness(events, { now: at('2026-10-28T18:35:00Z'), inFlight: true });
  assert.deepEqual([busy.mode, busy.nextAt], ['follow-up', at('2026-10-28T18:41:45Z')]);
  // The follow-up didn't come: the next hourly run, flagged.
  const missed = liveness(events, { now, inFlight: true });
  assert.deepEqual([missed.mode, missed.nextAt, missed.followUpMissed], ['cron', at('2026-10-28T20:00:00Z'), true]);
  // Paused by a gate chains too; the kill switch doesn't.
  const gate = (reason) => [...events, ev('dispatch_state', '2026-10-28T18:32:00Z', { state: 'paused', reason, in_flight: 0, ready: 0 })];
  assert.equal(liveness(gate('budget_pause'), { now: at('2026-10-28T18:35:00Z') }).mode, 'follow-up');
  assert.equal(liveness(gate('kill_switch'), { now: at('2026-10-28T18:35:00Z') }).mode, 'cron');
  assert.equal(liveness(gate('budget_pause'), { now: at('2026-10-28T18:35:00Z') }).lastType, 'dispatch_state');
  assert.deepEqual(liveness([], { now }), { lastAt: null, lastType: null, nextAt: null, mode: null, followUpMissed: false });
});

test('recent activity: the last 5 meaningful events as short sentences, noise and duplicates skipped', () => {
  const events = [
    ev('dispatched', '2026-10-27T23:24:00Z', { task: 'common/iso-format-parser', issue: 29, attempt: 1 }),
    ev('dispatched', '2026-10-27T23:24:30Z', { task: 'en/x', issue: 37, attempt: 1 }, true), // a plan
    ev('pr_opened', '2026-10-27T23:31:00Z', { pr: 149, opened_at: '2026-10-27T23:30:46Z' }),
    ev('check_result', '2026-10-27T23:33:00Z', { workflow: 'ci', conclusion: 'failure', prs: [149] }),
    ev('check_result', '2026-10-27T23:34:00Z', { workflow: 'gates', conclusion: 'success', prs: [149] }),
    ev('review_dispatched', '2026-10-27T23:35:50Z', { task: 'common/iso-format-parser', issue: 29, pr: 149 }),
    ev('spend_snapshot', '2026-10-27T23:41:30Z', { day: '2026-10-27', aic_today: 1, runs: [] }),
    ev('auto_merge', '2026-10-27T23:41:30Z', { task: 'common/iso-format-parser', issue: 29, pr: 149 }),
    ev('queued', '2026-10-27T23:43:06Z', { pr: 149, actor: 'controller[bot]', at: '2026-10-27T23:42:41Z' }),
    ev('dequeued', '2026-10-27T23:47:54Z', { pr: 149 }),
    ev('merged', '2026-10-27T23:47:54Z', { pr: 149, task: 'common/iso-format-parser', merged_at: '2026-10-27T23:46:39Z' }),
    ev('task_done', '2026-10-27T23:47:54Z', { task: 'common/iso-format-parser', issue: 29, pr: 149 }),
    ev('heartbeat', '2026-10-28T00:23:58Z', {}),
    ev('dispatch_state', '2026-10-28T00:23:58Z', { state: 'idle' }),
  ];
  const r = recentActivity(events);
  assert.deepEqual(r.map((x) => x.text), [
    '#29 iso-format-parser merged',
    '#29 iso-format-parser queued',
    '#29 iso-format-parser in review',
    '#29 iso-format-parser ci failed',
    '#29 iso-format-parser PR opened',
  ]);
  assert.equal(r[0].at, at('2026-10-27T23:46:39Z'));
  assert.deepEqual(recentActivity(events, { limit: 7 }).slice(5).map((x) => x.text), ['#29 iso-format-parser started']);
  const plain = recentActivity([
    ev('human_action', '2026-10-27T19:17:10Z', { action: 'review', pr: 139, reviewer: 'owner' }),
    ev('human_action', '2026-10-27T19:17:10Z', { action: 'review', pr: 139, reviewer: 'owner' }),
    ev('queued', '2026-10-27T19:18:00Z', { pr: 139, actor: 'owner' }),
    ev('check_result', '2026-10-27T19:30:00Z', { workflow: 'ci', event: 'push', conclusion: 'failure', prs: [] }),
    ev('auto_revert', '2026-10-27T19:40:00Z', { pr: 139, revert_pr: 140 }),
  ]);
  assert.deepEqual(plain.map((x) => x.text), ['#139 reverted', 'ci failed on main', '#139 queued by hand', '#139 reviewed']);
});

// --- the sample fixtures exercise the new panels offline ------------------------------------------

test('the meta stand-ins are current, and the busy sample shows every board state and a cost join', () => {
  assert.equal(readFileSync(META_FIXTURE_PATH, 'utf8'), metaText(buildMeta()), 'run: node dashboard/test/make-fixture.mjs');
  assert.equal(readFileSync(QUIET_META_FIXTURE_PATH, 'utf8'), metaText(buildQuietMeta()), 'run: node dashboard/test/make-fixture.mjs');
  const meta = buildMeta();
  const events = parseJsonl(readFileSync(FIXTURE_PATH, 'utf8'), 'sample.jsonl').map((r) => r.event);
  const now = at(FIXTURE_NOW);
  const entries = parseTaskmap(meta.taskmap);
  assert.equal(entries.length, 8);
  const catalog = taskCatalog(entries, new Map(entries.map((e) => [e.id, parseContract(meta.contracts[e.id])])));
  assert.deepEqual(catalog.find((t) => t.id === 'en/range').dependsOn, ['en/month-parser', 'en/ordinal']);
  const m = deriveMetrics(events, { now });
  const board = taskBoard(events, catalog, { needsItems: m.needsYou.items });
  assert.deepEqual(board.counts, { done: 2, running: 2, needs: 2, waiting: 2 });
  const runs = Object.entries(meta.runs).flatMap(([workflow, list]) => list.map((r) => ({ ...r, workflow })));
  const cost = costJoin(events, runs, { now });
  assert.deepEqual(cost.perTask.map((r) => [r.task, r.aic]), [['en/month-parser', 410], ['en/weekday-parser', 407], ['en/ordinal', 280]]);
  assert.deepEqual([cost.total, cost.unattributed], [1097, 0]);
  assert.deepEqual(medianTaskCost(cost, board.tasks.filter((t) => t.state === 'done').map((t) => t.id)), { medianAic: 343.5, count: 2 });
  assert.equal(qualityStats(events).escaped.count, 1);
});
