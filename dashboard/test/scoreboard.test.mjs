// The results scoreboard: the status line, the five sentences, the build-cost and drill files, and
// the human-steps rule. Builders return segments; segText() reads them as a person would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  JOURNAL_URL, costItem, earliestSpendDay, healthSummary, humanItem, humanSteps, issueToMerged, plainDuration, plainProblem, qualityItem, segText,
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
  const file = read('build-cost.json');
  assert.deepEqual(file, { ai_units: 111000, usd: 1110, as_of: '2026-10-27', source: 'build journal (coordinator + build sessions)' });
  assert.deepEqual(validateBuildCost(file), { ok: true, value: { aiUnits: 111000, usd: 1110, asOf: '2026-10-27', source: 'build journal (coordinator + build sessions)' } });
  const bad = (patch, msg) => {
    const r = validateBuildCost({ ...file, ...patch });
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
  const { usd: _usd, ...missing } = file;
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

test('shipped: done of total, split into routine and core by tier', () => {
  const b = { counts: { done: 26 }, total: 26, byTier: { 'auto-strict': { done: 8, total: 8 }, auto: { done: 18, total: 18 } } };
  assert.deepEqual(text(shippedItem(b)), ['Shipped: 26 of 26 tasks', '18 routine + 8 core, ported from JavaScript to Rust']);
  assert.equal(bigs(shippedItem(b)), 1);
  assert.deepEqual(text(shippedItem({ counts: { done: 1 }, total: 3, byTier: { auto: { done: 1, total: 2 }, unknown: { done: 0, total: 1 } } })),
    ['Shipped: 1 of 3 tasks', '1 routine + 0 other, ported from JavaScript to Rust']);
  assert.deepEqual(text(shippedItem({ counts: { done: 0 }, total: 0, byTier: {} })), ['Shipped: 0 of 0 tasks']);
});

test('speed: about M min (or hours past 90 min) per task, with the first and last finish dates', () => {
  assert.deepEqual(text(speedItem({ medianMs: 9.6 * MIN, count: 26, firstAt: at('2026-10-22T18:44:00Z'), lastAt: at('2026-10-27T23:49:06Z') })), ['Speed: about 10 min per task', 'Oct 22 → Oct 27']);
  assert.deepEqual(text(speedItem({ medianMs: 3 * 60 * MIN, count: 2, firstAt: at('2026-10-22T00:00:00Z'), lastAt: at('2026-10-22T05:00:00Z') })), ['Speed: about 3 hours per task', 'Oct 22 → Oct 22']);
  assert.deepEqual(text(speedItem({})), ['Speed: — no task merged yet']);
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

test('cost: build (one-time) + run, the run split into real tasks and safety drills', () => {
  const item = costItem({ build, cost: cost(), medianAic: 32.78 });
  assert.deepEqual(text(item), [
    'Total cost: about $1,126',
    '= $1,110 to build the factory (one-time) + $16.32 to run it',
    '$11.43 real tasks (median $0.33 each) + $4.89 safety drills',
  ]);
  assert.equal(bigs(item), 1);
  // Unattributed run cost is part of "real tasks" (total minus drills); no drills, no drill clause.
  assert.equal(text(costItem({ build, cost: cost({ drillAic: 0, unattributed: 100 }), medianAic: null }))[2], '$16.32 real tasks');
  // The run lists couldn't be read: the build cost, and say the run cost is unavailable.
  assert.deepEqual(text(costItem({ build, cost: cost({ known: false }) })), ['Total cost: about $1,110', '= $1,110 to build the factory (one-time) · running cost not available right now']);
  // No build cost: the run cost only.
  const noBuild = { ok: false, error: 'build-cost.json: HTTP 404' };
  assert.deepEqual(text(costItem({ build: noBuild, cost: cost(), medianAic: 32.78 })), ['Running cost: about $16.32', '$11.43 real tasks (median $0.33 each) + $4.89 safety drills']);
  assert.deepEqual(text(costItem({ build: noBuild, cost: cost({ known: false }) })), ['Total cost: — not available right now']);
  // No measured runs at all (a dry run): the run cost is $0, known without the run lists.
  assert.deepEqual(text(costItem({ build, cost: cost({ known: false, total: 0, drillAic: 0, measuredRuns: 0 }) })), ['Total cost: about $1,110', '= $1,110 to build the factory (one-time) + $0.00 to run it']);
});

test('human effort: N manual steps after go-live, linked to the list', () => {
  const item = humanItem({ goLive: 1, total: 2 });
  assert.deepEqual(text(item), ['Human effort after go-live: 2 manual steps']);
  assert.deepEqual(item.main.find((s) => s.t === 'link'), { t: 'link', text: 'manual steps', href: '#human-steps' });
  assert.equal(text(humanItem({ goLive: 1, total: 1 }))[0], 'Human effort after go-live: 1 manual step');
  assert.equal(text(humanItem({ goLive: null, total: 0 }))[0], 'Human effort: 0 manual steps; not live yet');
});

test('quality: reverts of real work · reviewer blocks · safety drills passed from drills.json (left out when invalid)', () => {
  const drills = validateDrills(read('drills.json'));
  const item = qualityItem({ reverts: 0, objections: 1 }, drills);
  assert.equal(segText(item.main), 'Quality: 0 reverts of real work · reviewer blocked 1 bad change before merge · 12 safety drills passed (6 defects found and fixed)');
  assert.equal(bigs(item), 1);
  assert.equal(item.main.find((s) => s.t === 'link').href, JOURNAL_URL);
  assert.equal(segText(qualityItem({ reverts: 1, objections: 2 }, { ok: false, error: 'drills.json: HTTP 404' }).main), 'Quality: 1 revert of real work · reviewer blocked 2 bad changes before merge');
  const one = validateDrills({ as_of: '2026-10-27', source: 'x', defects_found_and_fixed: 1, runs: [{ id: 'D1', result: 'pass' }, { id: 'D2', result: 'fail' }] });
  assert.match(segText(qualityItem({ reverts: 0, objections: 0 }, one).main), /· 1 safety drill passed \(1 defect found and fixed\)$/);
});
