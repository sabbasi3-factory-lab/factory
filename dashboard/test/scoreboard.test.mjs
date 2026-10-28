// The results scoreboard: the status line, the five sentences, the build-cost and drill files, and
// the human-steps rule. Builders return segments; segText() reads them as a person would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  JOURNAL_URL, OUTCOMES_STALE_MS, costItem, costJoin, earliestSpendDay, handsOffItem, healthSummary, humanSteps, latestOutcomes, outcomesStale, outcomesSummary, parseOutcomesSnapshot, issueToMerged, plainDuration, plainProblem, qualityItem, segText,
  shippedItem, shortDate, speedItem, statusParts, validateBuildCost, validateDrills,
} from '../lib.js';

const at = (iso) => Date.parse(iso);
const MIN = 60000;
let seq = 0;
const ev = (type, timestamp, payload, dryRun = false) => ({ id: `s${seq++}`, type, timestamp, payload: { dedupe_key: 'k', factory_version: 'v', dry_run: dryRun, ...payload } });
const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const text = (item) => [segText(item.main), ...item.subs.map((s) => segText(s))];
const bigs = (item) => item.main.filter((s) => s.t === 'big').length;

// --- helpers ------------------------------------------------------------------------------------

test('plain durations, dates and the earliest spend day', () => {
  assert.equal(plainDuration(9.4 * MIN), '9 min');
  assert.equal(plainDuration(20000), '1 min');
  assert.equal(plainDuration(89 * MIN), '89 min');
  assert.equal(plainDuration(90 * MIN), '1.5 hours');
  assert.equal(plainDuration(60 * MIN * 1.04), '62 min');
  assert.equal(plainDuration(150 * MIN), '2.5 hours');
  assert.equal(plainDuration(null), '—');
  assert.equal(shortDate('2026-10-21'), 'Oct 21');
  assert.equal(shortDate(at('2026-10-27T23:46:39Z')), 'Oct 27');
  assert.equal(shortDate(null), '—');
  const snap = (timestamp, day, dryRun = false) => ev('spend_snapshot', timestamp, { day, aic_today: 1, runs: [] }, dryRun);
  assert.equal(earliestSpendDay([snap('2026-10-22T01:00:00Z', '2026-10-22'), snap('2026-10-21T21:42:46Z', '2026-10-21'), snap('2026-10-01T00:00:00Z', '2026-10-01', true)]), '2026-10-21');
  assert.equal(earliestSpendDay([]), null);
  assert.equal(segText([{ t: 'text', text: 'a (median' }, { t: 'num', text: '$1' }, { t: 'text', text: 'each)' }, { t: 'text', text: ',' }, { t: 'sep' }, { t: 'time', at: 0 }], 60 * MIN),
    'a (median $1 each), · 1h ago');
});

// --- build-cost.json and drills.json -------------------------------------------------------------

test('build-cost.json: the committed file is valid; every field is required and checked; extra keys are rejected', () => {
  // The committed figure changes daily (one-line PRs from the journal), so check it's valid and
  // self-consistent rather than pinning its values: dollars = AI credits / 100, rounded.
  const file = read('build-cost.json');
  const committed = validateBuildCost(file);
  assert.equal(committed.ok, true, committed.error);
  assert.ok(Math.abs(file.usd - file.ai_units / 100) <= 1, `usd ${file.usd} should be ai_units / 100 (${file.ai_units / 100})`);
  assert.ok(file.ai_units > 0 && file.as_of >= '2026-10-27', 'a real, current build figure');
  const sample = { ai_units: 111000, usd: 1110, as_of: '2026-10-27', source: 'build journal (coordinator + build sessions)' };
  assert.deepEqual(validateBuildCost(sample), { ok: true, value: { aiUnits: 111000, usd: 1110, asOf: '2026-10-27', source: 'build journal (coordinator + build sessions)' } });
  const bad = (patch, msg) => {
    const r = validateBuildCost({ ...sample, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, msg);
  };
  bad({ usd: -1 }, /usd is not a number ≥ 0/);
  bad({ ai_units: '111000' }, /ai_units is not a number ≥ 0/);
  bad({ usd: Number.NaN }, /usd is not a number ≥ 0/);
  bad({ as_of: '2026-10-32' }, /as_of is not a YYYY-MM-DD date/);
  bad({ as_of: '27 Oct 2026' }, /as_of is not a YYYY-MM-DD date/);
  bad({ source: '' }, /source is not a non-empty string/);
  bad({ note: 'x' }, /unexpected note/);
  const { usd: _usd, ...missing } = sample;
  assert.match(validateBuildCost(missing).error, /missing usd/);
  for (const notObject of [null, [], 'x', 3]) assert.deepEqual(validateBuildCost(notObject), { ok: false, error: 'not a JSON object' });
});

test('drills.json: the committed record is 12 passed runs with 6 defects; every field is checked', () => {
  const file = read('drills.json');
  const r = validateDrills(file);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.passed, r.total, r.value.defects, r.value.asOf, r.value.source], [12, 12, 6, '2026-10-27', 'docs/JOURNAL.md']);
  assert.deepEqual(r.value.runs.map((x) => x.id), ['D1', 'D1b', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8a', 'D8b', 'D8c', 'D8d']);
  assert.deepEqual(r.value.runs.filter((x) => x.note).map((x) => [x.id, x.note]), [['D1', 'after 1 manual replay'], ['D8d', 'after a gate fix']]);
  // The count is computed: a failed run isn't counted.
  const mixed = validateDrills({ ...file, runs: [{ id: 'A', result: 'pass' }, { id: 'B', result: 'fail', note: 'gate missed' }] });
  assert.deepEqual([mixed.passed, mixed.total], [1, 2]);
  const bad = (data, msg) => {
    const x = validateDrills(data);
    assert.equal(x.ok, false, JSON.stringify(data).slice(0, 80));
    assert.match(x.error, msg);
  };
  bad({ ...file, runs: [] }, /runs is not a non-empty list/);
  bad({ ...file, runs: 'D1' }, /runs is not a non-empty list/);
  bad({ ...file, runs: [{ id: 'D1', result: 'passed' }] }, /runs\[0\]\.result is not "pass" or "fail"/);
  bad({ ...file, runs: [{ id: 'D1', result: 'pass' }, { id: 'D1', result: 'pass' }] }, /runs\[1\]\.id D1 is repeated/);
  bad({ ...file, runs: [{ result: 'pass' }] }, /runs\[0\]: missing id/);
  bad({ ...file, runs: [{ id: 'D1', result: 'pass', when: 'x' }] }, /runs\[0\]: unexpected when/);
  bad({ ...file, runs: [{ id: 'D1', result: 'pass', note: 3 }] }, /runs\[0\]\.note is not a string/);
  bad({ ...file, defects_found_and_fixed: -1 }, /defects_found_and_fixed is not an integer ≥ 0/);
  bad({ ...file, defects_found_and_fixed: 1.5 }, /defects_found_and_fixed is not an integer ≥ 0/);
  bad({ ...file, extra: 1 }, /unexpected extra/);
  bad({ runs: file.runs }, /missing as_of, source, defects_found_and_fixed/);
  bad(null, /not a JSON object/);
});

// --- human steps after go-live -------------------------------------------------------------------

test('human steps: hands-on actions on agent PRs and factory tasks after go-live; reviews and other PRs do not count', () => {
  const events = [
    ev('dispatched', '2026-10-21T10:00:00Z', { task: 'en/a', issue: 31, attempt: 1 }, true), // a dry-run plan: not go-live
    ev('queued', '2026-10-21T10:30:00Z', { pr: 9, actor: 'owner' }), // before go-live
    ev('dispatched', '2026-10-21T11:00:00Z', { task: 'drill/x', issue: 90, attempt: 1 }), // a drill: not go-live
    ev('dispatched', '2026-10-21T22:12:01Z', { task: 'en/a', issue: 31, attempt: 1 }), // go-live
    ev('pr_opened', '2026-10-21T22:20:00Z', { pr: 54, author: 'factory-agent[bot]' }),
    ev('pr_opened', '2026-10-21T22:21:00Z', { pr: 60, author: 'owner' }),
    ev('pr_opened', '2026-10-21T22:22:00Z', { pr: 61, author: 'factory-agent[bot]' }), // an agent PR without a task event
    ev('merged', '2026-10-21T22:40:00Z', { pr: 54, task: 'en/a' }),
    ev('queued', '2026-10-21T22:30:00Z', { pr: 54, actor: 'owner' }), // counted: enqueue an agent PR
    ev('queued', '2026-10-21T22:31:00Z', { pr: 61, actor: 'owner' }), // counted: agent-authored
    ev('queued', '2026-10-21T22:32:00Z', { pr: 60, actor: 'owner' }), // the owner's own PR: not counted
    ev('queued', '2026-10-21T22:33:00Z', { pr: 54, actor: 'factory-controller[bot]' }), // a bot: not counted
    ev('human_action', '2026-10-21T22:34:00Z', { action: 'review', pr: 54, reviewer: 'owner', state: 'COMMENTED', submitted_at: '2026-10-21T22:34:00Z' }),
    ev('human_action', '2026-10-21T22:35:00Z', { action: 'comment', pr: 54, reviewer: 'owner', submitted_at: '2026-10-21T22:35:00Z' }),
    ev('human_action', '2026-10-21T22:36:00Z', { action: 'label', issue: 31, reviewer: 'owner', submitted_at: '2026-10-21T22:36:00Z' }), // counted: a factory task's issue
    ev('human_action', '2026-10-21T22:37:00Z', { action: 'push', pr: 61, reviewer: 'owner', submitted_at: '2026-10-21T22:37:00Z' }), // counted
    ev('human_action', '2026-10-21T22:38:00Z', { action: 'label', pr: 60, reviewer: 'owner', submitted_at: '2026-10-21T22:38:00Z' }), // the owner's PR: not counted
  ];
  const h = humanSteps(events);
  assert.equal(h.goLive, at('2026-10-21T22:12:01Z'));
  assert.deepEqual(h.steps.map((s) => [s.kind, s.pr ?? s.issue, s.task, s.what]), [
    ['enqueue', 54, 'en/a', 'put an agent PR in the merge queue'],
    ['enqueue', 61, null, 'put an agent PR in the merge queue'],
    ['label', 31, 'en/a', 'changed labels on a factory task'],
    ['push', 61, null, 'pushed to an agent PR'],
  ]);
  assert.deepEqual(h.byKind, { enqueue: 2, label: 1, push: 1 });
  assert.equal(h.total, 4);
  assert.deepEqual(humanSteps(events.slice(0, 3)), { goLive: null, steps: [], byKind: {}, total: 0 }, 'not live yet');
});

// --- the status line ----------------------------------------------------------------------------

const board = (counts, tasks = []) => ({ counts: { done: 0, running: 0, needs: 0, waiting: 0, ...counts }, total: Object.values(counts).reduce((a, b) => a + b, 0), tasks });
const healthy = { problems: [] };
const parts = (opts) => {
  const p = statusParts({ health: healthy, killSwitch: true, board: board({ done: 26 }), ...opts });
  return [segText(p.state.segs, at('2026-10-28T19:00:00Z')), p.state.level, segText(p.needs.segs), p.needs.level];
};

test('status line: idle and nothing needs you; working on tasks with links; paused; switched off', () => {
  assert.deepEqual(parts({}), ['idle', 'ok', 'nothing needs you', 'ok']);
  const running = [1, 2, 3, 4].map((i) => ({ state: 'running', short: `task-${i}`, issue: 40 + i }));
  const p = statusParts({ health: healthy, killSwitch: true, board: board({ running: 2, done: 1 }, running.slice(0, 2)) });
  assert.equal(segText(p.state.segs), 'working on 2 tasks: task-1, task-2');
  assert.deepEqual(p.state.segs.filter((s) => s.t === 'link').map((s) => s.href), ['https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/41', 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/42']);
  assert.equal(parts({ board: board({ running: 4 }, running) })[0], 'working on 4 tasks: task-1, task-2, task-3 +1');
  assert.equal(parts({ board: board({ running: 1 }, [{ state: 'running', short: 'solo', issue: null }]) })[0], 'working on 1 task: solo');
  assert.deepEqual(parts({ banner: { state: 'paused', reason: 'budget_pause' } }).slice(0, 2), ['daily AI budget reached', 'warn']);
  assert.deepEqual(parts({ banner: { state: 'paused', reason: 'budget_unknown' } })[0], "today's AI spend can't be measured");
  assert.deepEqual(parts({ banner: { state: 'paused', reason: 'kill_switch' } })[0], 'idle', 'the kill switch is reported from factory_enabled');
  assert.deepEqual(parts({ killSwitch: false }).slice(0, 2), ['switched off', 'info']);
});

test('status line: an unhealthy factory says what is wrong in plain words, worst first', () => {
  const now = at('2026-10-28T19:00:00Z');
  const hb = { level: 'warn', ageMin: 9 * 60 };
  const health = healthSummary({ loaded: true, chain: { status: 'verified' }, heartbeat: hb });
  assert.deepEqual(health.problems, [{ level: 'warn', code: 'hb-late', text: 'Heartbeat late (9 h)' }]);
  assert.deepEqual(parts({ health, heartbeatAt: now - 9 * 60 * MIN }).slice(0, 2), ['last check-in 9h ago', 'warn']);
  const down = healthSummary({ loaded: true, chain: { status: 'broken', brokenAt: 4 }, heartbeat: hb, dispatch: { state: 'paused', reason: 'budget_pause', text: 'Paused' } });
  assert.deepEqual(down.problems.map((p) => p.code), ['chain-broken', 'hb-late', 'paused']);
  assert.deepEqual(parts({ health: down, banner: { state: 'paused', reason: 'budget_pause' } }).slice(0, 2), ['the audit log failed its integrity check', 'alert']);
  // A pause alone is not a health problem for the state part: it names the pause.
  const paused = healthSummary({ loaded: true, chain: { status: 'verified' }, heartbeat: { level: 'ok', ageMin: 5 }, dispatch: { state: 'paused', reason: 'budget_pause', text: 'Paused' } });
  assert.equal(paused.label, 'Paused');
  assert.deepEqual(parts({ health: paused, banner: { state: 'paused', reason: 'budget_pause' } })[0], 'daily AI budget reached');
  const plain = (code) => segText(plainProblem({ code }));
  assert.equal(plain('hb-none'), 'no check-in from the factory');
  assert.equal(plain('hb-late'), 'check-in late');
  assert.equal(plain('data-stale'), 'the data here is out of date');
  assert.equal(plain('refresh-failed'), "can't refresh the data");
  assert.equal(plain('verifier:verifier-not-set-up'), "independent audit check isn't set up");
  assert.equal(plain('verifier:verifier-stale'), 'independent audit check is late');
  assert.equal(plain('verifier:verifier-malformed'), "can't read the independent audit check");
  assert.equal(plain('???'), 'something is wrong');
});

test('status line: what needs you, linked, after the closed rule; reviews; unknown review list', () => {
  const items = [
    { kind: 'needs_human', task: 'common/forward', issue: 28, pr: 143 },
    { kind: 'needs_human', task: 'en/x', issue: null, pr: 33 },
  ];
  const p = statusParts({ health: healthy, board: board({ done: 1 }), needsItems: items });
  assert.equal(segText(p.needs.segs), '2 tasks need you: #28, #33');
  assert.deepEqual(p.needs.segs.filter((s) => s.t === 'link').map((s) => s.href), [
    'https://github.com/sabbasi3-factory-lab/chrono-node-rs/issues/28', 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/33',
  ]);
  assert.equal(p.needs.level, 'warn');
  assert.equal(parts({ needsItems: items.slice(0, 1) })[2], '1 task needs you: #28');
  const review = { kind: 'review', repo: 'sabbasi3-factory-lab/factory', number: 3, url: 'https://github.com/sabbasi3-factory-lab/factory/pull/3' };
  assert.equal(parts({ needsItems: [items[0], review] })[2], '2 items need you: #28, factory#3');
  const many = [1, 2, 3, 4, 5].map((i) => ({ kind: 'needs_human', issue: i }));
  assert.equal(parts({ needsItems: many })[2], '5 tasks need you: #1, #2, #3 +2');
  assert.deepEqual(parts({ reviews: 'pending' }).slice(2), ['checking reviews…', 'info']);
  assert.deepEqual(parts({ reviews: 'unavailable' }).slice(2), ['review list unavailable', 'warn']);
});

// --- the five sentences ---------------------------------------------------------------------------

test('shipped: done of total, routine and core by tier, and the gh-aw Outcomes line (or its fallback)', () => {
  const b = { counts: { done: 26 }, total: 26, byTier: { 'auto-strict': { done: 8, total: 8 }, auto: { done: 18, total: 18 } } };
  const os = { real: { prs: { accepted: 26, rejected: 1, pending: 0, other: 0 }, zeroTouch: 25 } };
  assert.deepEqual(text(shippedItem(b, os)), ['Shipped: 26 of 26 tasks', '18 routine + 8 core', 'gh-aw Outcomes: 26 PRs accepted, 1 rejected, 0 pending']);
  assert.equal(bigs(shippedItem(b, os)), 1);
  assert.deepEqual(text(shippedItem(b, null)).at(-1), 'gh-aw Outcomes not available yet');
  assert.equal(text(shippedItem(b, { real: { prs: { accepted: 1, rejected: 0, pending: 2, other: 0 } } })).at(-1), 'gh-aw Outcomes: 1 PR accepted, 0 rejected, 2 pending');
  assert.deepEqual(text(shippedItem({ counts: { done: 1 }, total: 3, byTier: { auto: { done: 1, total: 2 }, unknown: { done: 0, total: 1 } } })).slice(0, 2),
    ['Shipped: 1 of 3 tasks', '1 routine + 0 other']);
  assert.deepEqual(text(shippedItem({ counts: { done: 0 }, total: 0, byTier: {} })), ['Shipped: 0 of 0 tasks', 'gh-aw Outcomes not available yet']);
});
test('speed: about M min (or hours past 90 min) per task, with the first and last finish dates', () => {
  assert.deepEqual(text(speedItem({ medianMs: 9.6 * MIN, count: 26, firstAt: at('2026-10-22T18:44:00Z'), lastAt: at('2026-10-27T23:49:06Z') })), ['Speed: about 10 min per task', 'Oct 22 → 27']);
  assert.deepEqual(text(speedItem({ medianMs: 9.6 * MIN, count: 2, firstAt: at('2026-10-30T18:44:00Z'), lastAt: at('2026-11-02T10:00:00Z') }))[1], 'Oct 30 → Nov 2');
  assert.deepEqual(text(speedItem({ medianMs: 3 * 60 * MIN, count: 2, firstAt: at('2026-10-22T00:00:00Z'), lastAt: at('2026-10-22T05:00:00Z') })), ['Speed: about 3 hours per task', 'Oct 22']);
  assert.deepEqual(text(speedItem({})), ['Speed: — no task merged yet']);
  // Done tasks whose start and merge aren't in the log: the timing is unavailable, not "no merge".
  assert.deepEqual(text(speedItem({ count: 0, done: 26 })), ['Speed: — timing unavailable']);
  // The median over every done task in the loaded log (days: Infinity), only the given tasks.
  const events = [
    ev('dispatched', '2026-10-01T10:00:00Z', { task: 'en/old', issue: 1, attempt: 1 }),
    ev('merged', '2026-10-01T10:20:00Z', { task: 'en/old', pr: 11, merged_at: '2026-10-01T10:20:00Z' }),
    ev('dispatched', '2026-10-27T10:00:00Z', { task: 'en/new', issue: 2, attempt: 1 }),
    ev('merged', '2026-10-27T10:10:00Z', { task: 'en/new', pr: 12, merged_at: '2026-10-27T10:10:00Z' }),
    ev('dispatched', '2026-10-27T11:00:00Z', { task: 'en/undone', issue: 3, attempt: 1 }),
    ev('merged', '2026-10-27T13:00:00Z', { task: 'en/undone', pr: 13, merged_at: '2026-10-27T13:00:00Z' }),
  ];
  const now = at('2026-10-28T19:00:00Z');
  assert.equal(issueToMerged(events, { now }).count, 2, 'the 14-day window');
  const all = issueToMerged(events, { now, days: Infinity, tasks: new Set(['en/old', 'en/new']) });
  assert.deepEqual([all.count, all.medianMs], [2, 15 * MIN]);
});

const cost = (patch = {}) => ({ known: true, total: 1632, drillAic: 489, measuredRuns: 60, unattributed: 0, ...patch });
const build = validateBuildCost({ ai_units: 111000, usd: 1110, as_of: '2026-10-27', source: 'journal' });

test('cost: build (one-time) + full run cost, split into real tasks and drills, and the cost per accepted PR', () => {
  const item = costItem({ build, cost: cost(), acceptedPrs: 26 });
  assert.deepEqual(text(item), [
    'Total cost: about $1,126',
    '= $1,110 one-time build + $16.32 running',
    '$11.43 tasks + $4.89 drills · about $0.44 per accepted PR',
  ]);
  assert.equal(bigs(item), 1);
  // Per accepted PR = full real-task run cost ÷ real accepted PRs (unattributed counts as real).
  assert.equal(item.perPr, (1632 - 489) / 26);
  assert.equal(costItem({ build, cost: cost({ total: 1631.6, drillAic: 447.4 }), acceptedPrs: 26 }).perPr.toFixed(1), '45.5');
  // No drill cost: the run is all tasks, so the per-PR clause joins the second line; no accepted PRs, no per-PR clause.
  assert.deepEqual(text(costItem({ build, cost: cost({ drillAic: 0, unattributed: 100 }), acceptedPrs: 0 })), ['Total cost: about $1,126', '= $1,110 one-time build + $16.32 running']);
  assert.equal(text(costItem({ build, cost: cost({ drillAic: 0 }), acceptedPrs: 16 }))[1], '= $1,110 one-time build + $16.32 running · about $1.02 per accepted PR');
  // No gh-aw Outcomes snapshot: the run total still counts; no split and no per-PR cost.
  const noOutcomes = costItem({ build, cost: cost({ known: false }), acceptedPrs: null });
  assert.deepEqual(text(noOutcomes), ['Total cost: about $1,126', '= $1,110 one-time build + $16.32 running']);
  assert.equal(noOutcomes.perPr, null);
  // No build cost: the run cost only.
  const noBuild = { ok: false, error: 'build-cost.json: HTTP 404' };
  assert.deepEqual(text(costItem({ build: noBuild, cost: cost(), acceptedPrs: 26 })), ['Running cost: about $16.32', '$11.43 tasks + $4.89 drills · about $0.44 per accepted PR']);
  assert.deepEqual(text(costItem({ build, cost: null })), ['Total cost: about $1,110', '= $1,110 one-time build · running cost not available right now']);
  assert.deepEqual(text(costItem({ build: noBuild, cost: null })), ['Total cost: — not available right now']);
  // Real agent runs but no spend measurement: unavailable, never $0.00.
  assert.deepEqual(text(costItem({ build, cost: cost({ known: true, total: 0, drillAic: 0, measuredRuns: 0, spend: 'missing' }), acceptedPrs: 2 })),
    ['Total cost: about $1,110', '= $1,110 one-time build · running cost not available yet']);
  assert.deepEqual(text(costItem({ build: noBuild, cost: cost({ total: 0, measuredRuns: 0, spend: 'missing' }) })), ['Running cost: — not available yet']);
  // No measured runs at all (a dry run): the run cost is $0.
  assert.deepEqual(text(costItem({ build, cost: cost({ known: false, total: 0, drillAic: 0, measuredRuns: 0 }) })), ['Total cost: about $1,110', '= $1,110 one-time build + $0.00 running']);
});
test('hands-off: N of M PRs merged with no human edits (gh-aw zero-touch), and our manual steps below', () => {
  const os = { real: { prs: { accepted: 26, rejected: 1, pending: 0, other: 0 }, zeroTouch: 25 } };
  const item = handsOffItem(os, { goLive: 1, total: 2 });
  assert.deepEqual(text(item), ['Hands-off: 25 of 26 PRs merged with no human edits (gh-aw zero-touch)', '2 manual steps after go-live']);
  assert.equal(bigs(item), 1);
  assert.deepEqual(item.subs[0].find((s) => s.t === 'link'), { t: 'link', text: 'manual steps', href: '#human-steps' });
  assert.equal(text(handsOffItem(os, { goLive: 1, total: 1 }))[1], '1 manual step after go-live');
  assert.equal(text(handsOffItem({ real: { prs: { accepted: 1 }, zeroTouch: 1 } }, { goLive: 1, total: 0 }))[0], 'Hands-off: 1 of 1 PR merged with no human edits (gh-aw zero-touch)');
  // Fallbacks: no Outcomes snapshot; not live yet.
  assert.deepEqual(text(handsOffItem(null, { goLive: null, total: 0 })), ['Hands-off: — gh-aw Outcomes not available yet', '0 manual steps; not live yet']);
});

// --- gh-aw Outcomes ----------------------------------------------------------------------------

const PRURL = (n) => `https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/${n}`;
const oitem = (type, status, zeroTouch = null, n = null) => ({ type, object_url: n ? PRURL(n) : null, outcome_status: status, evidence_strength: 'strong', zero_touch: zeroTouch });
const orun = (run_id, workflow, task, drill, items, extra = {}) => ({ run_id, workflow, task, drill, created_at: '2026-10-27T10:00:00Z', aic: 10, conclusion: 'success', eval: 'ok', evaluated_at: '2026-10-28T21:26:38Z', items, ...extra });
const opayload = (source_run_id, runs, evaluated_at = '2026-10-28T21:26:38Z') => ({ source_run_id, source_run_attempt: 1, gh_aw_version: 'v0.92.0', evaluated_at, mode: 'full', runs, summary: {} });

test('outcomes: parse and validate a snapshot; malformed runs and items are skipped; diagnosis and tasked reviews are accepted', () => {
  const p = parseOutcomesSnapshot(opayload(40771939035, [
    orun(1, 'implement', 'en/a', false, [oitem('create_pull_request', 'accepted', true, 54), { type: 'add_comment' }, oitem('add_comment', 'pending')]),
    orun(2, 'review', 'en/a', false, [oitem('create_check_run', 'unknown')], { diagnosis: { cause: 'x' } }),
    { run_id: 'x', workflow: 'implement', drill: false, items: [] },
    orun(3, 'implement', null, 'yes', []),
  ]));
  assert.equal(p.sourceRunId, 40771939035);
  assert.equal(p.ghAwVersion, 'v0.92.0');
  assert.deepEqual(p.runs.map((r) => [r.runId, r.workflow, r.task, r.items.length]), [[1, 'implement', 'en/a', 2], [2, 'review', 'en/a', 1]]);
  assert.deepEqual(p.runs[1].diagnosis, { cause: 'x' });
  assert.equal(p.dropped, 3, 'two bad runs and one bad item');
  assert.deepEqual(p.runs[0].items[0], { type: 'create_pull_request', url: PRURL(54), status: 'accepted', evidence: 'strong', zeroTouch: true });
  for (const bad of [null, [], {}, { ...opayload(1, []), runs: 'x' }, { ...opayload(1, []), source_run_id: 0 }, { ...opayload(1, []), evaluated_at: 'soon' }]) assert.equal(parseOutcomesSnapshot(bad), null);
});

test('outcomes: the newest usable snapshot wins, malformed ones are ignored, and the checked marker sets freshness', () => {
  const events = [
    ev('outcomes_snapshot', '2026-10-28T20:00:00Z', opayload(1, [orun(1, 'implement', 'en/a', false, [oitem('create_pull_request', 'pending', null, 1)])], '2026-10-28T19:59:00Z')),
    ev('outcomes_snapshot', '2026-10-28T21:28:20Z', opayload(2, [orun(1, 'implement', 'en/a', false, [oitem('create_pull_request', 'accepted', true, 1)])], '2026-10-28T21:26:38Z')),
    ev('outcomes_snapshot', '2026-10-28T22:00:00Z', { source_run_id: 3, evaluated_at: '2026-10-28T22:00:00Z' }), // no runs: ignored
    ev('outcomes_checked', '2026-10-28T21:31:19Z', { same_as_run_id: 2, source_run_id: 4 }),
    ev('outcomes_checked', '2026-10-28T23:00:00Z', { same_as_run_id: 1, source_run_id: 5 }), // about an older snapshot
  ];
  const L = latestOutcomes(events);
  assert.equal(L.snapshot.sourceRunId, 2);
  assert.equal(L.ignored, 1);
  assert.equal(L.checkedAt, at('2026-10-28T21:31:19Z'));
  assert.equal(L.lastAt, at('2026-10-28T21:31:19Z'));
  assert.equal(latestOutcomes([]), null);
  assert.equal(latestOutcomes(events.slice(2, 3)), null);
  // Stale: over 48 h since the evaluation and no checked marker since.
  assert.equal(outcomesStale(L, L.lastAt + OUTCOMES_STALE_MS), false);
  assert.equal(outcomesStale(L, L.lastAt + OUTCOMES_STALE_MS + 1), true);
  const checkedLater = latestOutcomes([...events, ev('outcomes_checked', '2026-10-30T21:00:00Z', { same_as_run_id: 2 })]);
  assert.equal(outcomesStale(checkedLater, at('2026-10-31T00:00:00Z')), false);
  assert.equal(outcomesStale(null, Date.now()), false);
});

test('outcomes: real work and safety drills apart; PRs by status; zero-touch only for accepted PRs (live shape)', () => {
  const runs = [];
  for (let i = 0; i < 26; i++) runs.push(orun(100 + i, 'implement', `en/t${i}`, false, [oitem('create_pull_request', 'accepted', i === 0 ? null : true, 200 + i), oitem('add_comment', 'pending')]));
  runs.push(orun(130, 'implement', 'common/abbr', false, [oitem('create_pull_request', 'rejected', null, 136)]));
  runs.push(orun(131, 'repair', 'common/x', false, [oitem('push_to_pull_request_branch', 'rejected')]));
  runs.push(orun(132, 'review', null, false, [oitem('create_check_run', 'unknown')]));
  for (let i = 0; i < 12; i++) runs.push(orun(300 + i, 'implement', `drill/d${i}`, true, [oitem('create_pull_request', i < 3 ? 'accepted' : 'rejected', i < 2 ? true : null, 400 + i)]));
  runs.push(orun(320, 'review', 'drill/d0', false, [oitem('create_check_run', 'unknown')])); // a drill by its task name
  runs.push(orun(321, 'implement', 'en/odd', false, [oitem('create_pull_request', 'ignored', null, 500)]));
  const s = outcomesSummary(parseOutcomesSnapshot(opayload(9, runs)));
  assert.deepEqual(s.real.prs, { accepted: 26, rejected: 1, pending: 0, other: 1 });
  assert.equal(s.real.zeroTouch, 25);
  assert.deepEqual(s.drills.prs, { accepted: 3, rejected: 9, pending: 0, other: 0 });
  assert.equal(s.drills.zeroTouch, 2);
  assert.deepEqual(s.real.prStatus, { accepted: 26, rejected: 1, ignored: 1 });
  assert.deepEqual(s.real.items, { accepted: 26, pending: 26, rejected: 2, unknown: 1, ignored: 1 });
  assert.deepEqual([s.real.runs, s.drills.runs], [30, 13]);
});

test('the Actions run-list path is gone: no workflow-run API calls in the page', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../lib.js', import.meta.url), 'utf8');
  for (const src of [app, lib]) {
    assert.doesNotMatch(src, /actions\/workflows|lock\.yml\/runs|display_title|parseRunTitle|matchByTime/);
  }
  assert.doesNotMatch(app, /\/actions\/runs\?|workflow_runs/);
});
test('quality: reverts of real work · reviewer blocks · safety drills passed from drills.json (left out when invalid)', () => {
  const drills = validateDrills(read('drills.json'));
  const item = qualityItem({ reverts: 0, objections: 1 }, drills);
  assert.equal(segText(item.main), 'Quality: 0 reverts · reviewer blocked 1 change · 12 safety drills passed (6 defects fixed)');
  assert.equal(bigs(item), 1);
  assert.equal(item.main.find((s) => s.t === 'link').href, JOURNAL_URL);
  assert.equal(segText(qualityItem({ reverts: 1, objections: 2 }, { ok: false, error: 'drills.json: HTTP 404' }).main), 'Quality: 1 revert · reviewer blocked 2 changes');
  const one = validateDrills({ as_of: '2026-10-27', source: 'x', defects_found_and_fixed: 1, runs: [{ id: 'D1', result: 'pass' }, { id: 'D2', result: 'fail' }] });
  assert.match(segText(qualityItem({ reverts: 0, objections: 0 }, one).main), /· 1 safety drill passed \(1 defect fixed\)$/);
});

// --- lifetime numbers: the whole log, not the 14-day window -------------------------------------

test('cost: spend data is tracked apart from Outcomes; a real run with no measurement is "missing", a dry run a known zero', () => {
  const real = [ev('dispatched', '2026-10-27T10:00:00Z', { task: 'en/a', issue: 1, attempt: 1 })];
  const dry = [ev('dispatched', '2026-10-27T10:00:00Z', { task: 'en/a', issue: 1, attempt: 1, dry_run: true, effect: 'dispatch_workflow:implement' })];
  const snapRun = { runId: 7, workflow: 'implement', task: 'en/a', drill: false, aic: 5, items: [] };
  assert.equal(costJoin(real, [snapRun]).spend, 'missing', 'Outcomes known, spend missing');
  assert.equal(costJoin(real, null).spend, 'missing');
  assert.equal(costJoin(dry, null).spend, 'none');
  assert.equal(costJoin([], null).spend, 'none');
  const measured = [...real, ev('spend_snapshot', '2026-10-27T11:00:00Z', { day: '2026-10-27', aic_today: 8, runs: [{ run_id: 7, aic: 8, status: 'measured' }], runs_total: 1 })];
  assert.equal(costJoin(measured, null).spend, 'measured', 'spend known without Outcomes');
  assert.equal(text(costItem({ build, cost: costJoin(dry, null) }))[1], '= $1,110 one-time build + $0.00 running');
  assert.equal(text(costItem({ build, cost: costJoin(real, [snapRun]), acceptedPrs: 1 }))[1], '= $1,110 one-time build · running cost not available yet');
});

test('go-live and the manual steps use each action\'s own time, not the record time', () => {
  const events = [
    // Recorded late: the person enqueued at 10:05, the controller wrote it after go-live at 10:20.
    ev('queued', '2026-10-27T10:20:00Z', { pr: 54, actor: 'owner', at: '2026-10-27T10:05:00Z' }),
    ev('dispatched', '2026-10-27T10:10:00Z', { task: 'en/a', issue: 31, attempt: 1 }),
    ev('pr_opened', '2026-10-27T10:12:00Z', { pr: 54, task: 'en/a', author: 'agent[bot]' }),
    // Recorded before go-live's record order but done after it.
    ev('human_action', '2026-10-27T10:30:00Z', { action: 'label', pr: 54, reviewer: 'owner', submitted_at: '2026-10-27T10:31:00Z' }),
    ev('queued', '2026-10-27T10:40:00Z', { pr: 54, actor: 'owner', at: '2026-10-27T10:39:00Z' }),
  ];
  const h = humanSteps(events);
  assert.equal(h.goLive, at('2026-10-27T10:10:00Z'));
  assert.deepEqual(h.steps.map((x) => [x.kind, new Date(x.at).toISOString()]), [['label', '2026-10-27T10:31:00.000Z'], ['enqueue', '2026-10-27T10:39:00.000Z']],
    'the 10:05 enqueue came before go-live, although its record is later');
});

test('lifetime: after an idle fortnight the run cost, speed, go-live and human steps still count the old days', () => {
  const now = at('2026-11-20T12:00:00Z'); // 3+ weeks after the last activity
  const events = [
    ev('dispatched', '2026-10-21T22:12:01Z', { task: 'en/a', issue: 31, attempt: 1 }), // go-live, far outside 14 days
    ev('pr_opened', '2026-10-21T22:20:00Z', { pr: 54, task: 'en/a', author: 'agent[bot]' }),
    ev('queued', '2026-10-21T22:30:00Z', { pr: 54, actor: 'owner' }),
    ev('merged', '2026-10-21T22:31:00Z', { pr: 54, task: 'en/a', merged_at: '2026-10-21T22:31:00Z' }),
    ev('spend_snapshot', '2026-10-21T23:00:00Z', { day: '2026-10-21', aic_today: 31.4, runs: [{ run_id: 7, aic: 31.4, status: 'measured' }], runs_total: 1 }),
    ev('heartbeat', '2026-11-20T11:00:00Z', { factory_enabled: true }), // only check-ins since
  ];
  const c = costJoin(events, [{ runId: 7, workflow: 'implement', task: 'en/a', drill: false, aic: 20, items: [] }], { now });
  assert.equal(c.total, 31.4, 'the run cost is lifetime');
  assert.deepEqual(c.perTask, [{ task: 'en/a', aic: 31.4, runs: 1 }]);
  assert.equal(c.perDay.aic.reduce((x, y) => x + y, 0), 0, 'only the per-day list is windowed');
  assert.deepEqual(text(costItem({ build, cost: c, acceptedPrs: 1 }))[1], '= $1,110 one-time build + $0.31 running · about $0.31 per accepted PR');
  const speed = issueToMerged(events, { now, days: Infinity, tasks: new Set(['en/a']) });
  assert.deepEqual([speed.count, speed.medianMs], [1, 18 * MIN + 59000]);
  assert.equal(issueToMerged(events, { now }).count, 0, 'the 14-day window would have lost it');
  const h = humanSteps(events);
  assert.equal(h.goLive, at('2026-10-21T22:12:01Z'), 'go-live stays put outside the window');
  assert.equal(h.total, 1);
  assert.equal(text(handsOffItem(null, h))[1], '1 manual step after go-live');
});
