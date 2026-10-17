import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEALTH_LABELS, PIPELINE_LANES, combineNeedsYou, compactAge, costSummary, dailySeries, dayPaths, deriveMetrics, existingDayPaths,
  healthSummary, isHumanTierPr, parseJsonl, prRef, reviewItems, shortTitle, sparkSegments, summarizePr, unmergedPrs, pipeline, shortSha,
  stageBreakdown, typicalRunMs,
} from '../lib.js';
import { FIXTURE_NOW, FIXTURE_PATH } from './make-fixture.mjs';

const at = (iso) => Date.parse(iso);
const fixture = () => parseJsonl(readFileSync(FIXTURE_PATH, 'utf8'), 'sample.jsonl').map((r) => r.event);
const mk = (type, timestamp, payload, dryRun = false) => ({
  type, timestamp, payload: { dedupe_key: 'k', factory_version: 'v', dry_run: dryRun, ...payload },
});

test('shortSha shows 7 characters of a full SHA and leaves other values alone', () => {
  assert.equal(shortSha('320c4fcedefc03648caa4cda140bd93932367986'), '320c4fc');
  assert.equal(shortSha('f4c1a9e'), 'f4c1a9e');
  assert.equal(shortSha('v1.2.3'), 'v1.2.3');
  assert.equal(shortSha(null), null);
});

test('daily series: 7 UTC days, counts per day, gaps where there is nothing to measure', () => {
  const s = dailySeries(fixture(), { now: at(FIXTURE_NOW) });
  assert.deepEqual(s.days, ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.deepEqual(s.merged, [0, 0, 0, 0, 0, 2, 1]);
  assert.deepEqual(s.aic, [0, 0, 0, 0, 0, 280, 722]);
  assert.deepEqual(s.heartbeats, [0, 0, 0, 0, 0, 1, 3]);
  assert.deepEqual(s.checksPassPct.slice(0, 5), [null, null, null, null, null]);
  assert.equal(s.checksPassPct[5], 100);
  assert.equal(Math.round(s.checksPassPct[6]), 67); // 2 of 3 on the 16th
  assert.deepEqual([s.checks.passed, s.checks.total], [6, 7]);
  // Zero-touch is cumulative: PR 6 (reviewed) on the 15th, PR 7 (untouched) on the 16th.
  assert.deepEqual(s.zeroTouchPct, [null, null, null, null, null, 0, 50]);
  // PR open -> merged: #5 50m, #6 54m on the 15th; #7 38m on the 16th.
  assert.equal(Math.round(s.mergeMedianMin[6]), 38);
  assert.equal(Math.round(s.mergeMedianAllMin), 50);

  const empty = dailySeries([], { now: at(FIXTURE_NOW), days: 3 });
  assert.deepEqual(empty.merged, [0, 0, 0]);
  assert.deepEqual(empty.checksPassPct, [null, null, null]);
  assert.equal(empty.checks.pct, null);
  assert.equal(empty.mergeMedianAllMin, null);
});

test('pipeline: one card per task or task-less PR, in the lane of its latest stage, with tags', () => {
  const { lanes, total } = pipeline(fixture());
  assert.deepEqual(lanes.map((l) => l.key), PIPELINE_LANES.map((l) => l.key));
  assert.equal(lanes.length, 7);
  const lane = (k) => lanes.find((l) => l.key === k).cards;
  const where = Object.fromEntries(lanes.flatMap((l) => l.cards.map((c) => [c.label, l.key])));
  assert.deepEqual(where, {
    'en/time-expression': 'ready',
    'en/relative': 'ready',
    'en/month-parser': 'running',
    'en/casual-date': 'running',
    'PR #9': 'queued',
    'PR #5': 'merged',
    'en/weekday-parser': 'deployed',
    'en/ordinal': 'deployed',
  });
  assert.equal(total, 8);
  const month = lane('running').find((c) => c.label === 'en/month-parser');
  assert.deepEqual(month.tags.map((t) => t.text), ['repair a2', 'gates failure']);
  assert.equal(month.tags[1].title, 'golden:en/month#3');
  assert.deepEqual([month.issue, month.prs, month.attempt, month.model], [43, [8], 2, 'pinned-model-a']);
  assert.deepEqual(lane('ready').map((c) => c.tags[0].text), ['needs human', 'stale contract']);
  // Done lanes put the newest first.
  assert.deepEqual(lane('deployed').map((c) => c.label), ['en/weekday-parser', 'en/ordinal']);
  assert.deepEqual(pipeline([]).total, 0);
});

test('pipeline: dry-run decisions never move a card; cancelled removes it', () => {
  const events = [
    mk('ready', '2026-10-16T08:00:00Z', { task: 't/a', issue: 1 }),
    mk('dispatched', '2026-10-16T08:05:00Z', { task: 't/a', issue: 1, attempt: 1, effect: 'dispatch', reason: 'ready' }, true),
    mk('ready', '2026-10-16T08:00:00Z', { task: 't/b', issue: 2 }),
    mk('cancelled', '2026-10-16T08:10:00Z', { task: 't/b', issue: 2, effect: 'close', reason: 'owner' }),
  ];
  const { lanes } = pipeline(events);
  const ready = lanes.find((l) => l.key === 'ready').cards;
  assert.deepEqual(ready.map((c) => c.label), ['t/a']);
  assert.deepEqual(ready[0].tags.map((t) => t.text), ['dry-run plan']);
  assert.equal(lanes.find((l) => l.key === 'running').cards.length, 0);
});

test('stage breakdown: stacked segments per task and the stage with the largest share', () => {
  const m = deriveMetrics(fixture(), { now: at(FIXTURE_NOW) });
  const sb = stageBreakdown(m.stageTimes);
  const weekday = sb.rows.find((r) => r.label === 'en/weekday-parser');
  assert.deepEqual(weekday.segments.map((s) => s.stage), ['ready', 'picked', 'running', 'pr-open', 'checks', 'queued', 'merged']);
  assert.equal(weekday.totalMs, at('2026-10-16T09:25:00Z') - at('2026-10-16T08:00:00Z'));
  assert.equal(sb.maxMs, Math.max(...sb.rows.map((r) => r.totalMs)));
  assert.equal(sb.insight.stage, 'running');
  assert.equal(sb.insight.label, 'Agent running');
  assert.equal(Math.round(sb.insight.pct), 33);
  assert.equal(sb.insight.tasks, sb.rows.length);
  assert.equal(sb.average.label, 'Average');
  assert.equal(Math.round(sb.average.totalMs), Math.round(sb.rows.reduce((a, r) => a + r.totalMs, 0) / sb.rows.length));
  assert.deepEqual(stageBreakdown([]), { rows: [], average: null, maxMs: 0, insight: null });
});

test('cost summary: highest first, average against the 1,000 AIC per-task budget', () => {
  const m = deriveMetrics(fixture(), { now: at(FIXTURE_NOW) });
  const c = costSummary(m.tokensPerTask);
  assert.deepEqual(c.rows.map((r) => [r.task, r.aic]), [['en/month-parser', 410], ['en/weekday-parser', 312], ['en/ordinal', 280]]);
  assert.equal(c.maxAic, 410);
  assert.equal(c.avgAic, 334);
  assert.equal(Math.round(c.pct * 10) / 10, 33.4);
  assert.deepEqual(c.overBudget, []);
  assert.deepEqual(costSummary({ rows: [{ task: 'x', aic: 1500 }] }).overBudget, ['x']);
  assert.equal(costSummary({ rows: [] }).avgAic, null);
  assert.equal(typicalRunMs(fixture()), 2040000); // median of 34m, 24m50s, 38m
  assert.equal(typicalRunMs([]), null);
});

test('only day files listed in the audit tree are fetched, so missing days cause no 404s', () => {
  const wanted = dayPaths(at(FIXTURE_NOW), 7);
  const tree = [
    { path: '2026', type: 'tree' },
    { path: '2026/10', type: 'tree' },
    { path: '2026/10/09.jsonl', type: 'blob' }, // outside the window
    { path: '2026/10/15.jsonl', type: 'blob' },
    { path: '2026/10/16.jsonl', type: 'blob' },
    { path: '2026/10/14.jsonl', type: 'tree' }, // not a file
  ];
  assert.deepEqual(existingDayPaths(tree, wanted), ['audit/2026/10/15.jsonl', 'audit/2026/10/16.jsonl']);
  assert.deepEqual(existingDayPaths([], wanted), []);
  assert.deepEqual(existingDayPaths(null, wanted), []);
});

// --- closed PRs and owner reviews (factory#4 data fixes) ----------------------------

const prEvents = () => [
  mk('pr_opened', '2026-10-16T08:00:00Z', { pr: 16, author: 'owner' }),
  mk('pr_opened', '2026-10-16T08:01:00Z', { pr: 17, author: 'owner' }),
  mk('check_result', '2026-10-16T08:10:00Z', { workflow: 'ci', prs: [17], conclusion: 'success' }),
  mk('pr_opened', '2026-10-16T08:02:00Z', { pr: 20, author: 'owner' }),
  mk('check_result', '2026-10-16T08:12:00Z', { workflow: 'ci', prs: [20], conclusion: 'success' }),
  mk('pr_opened', '2026-10-16T08:03:00Z', { pr: 21, author: 'owner' }),
  mk('queued', '2026-10-16T08:20:00Z', { pr: 21, actor: 'owner', at: '2026-10-16T08:20:00Z' }),
  mk('pr_opened', '2026-10-16T08:04:00Z', { pr: 22, author: 'owner' }),
  mk('pr_opened', '2026-10-16T08:05:00Z', { pr: 5, author: 'owner' }),
  mk('merged', '2026-10-16T08:30:00Z', { pr: 5, merge_commit_sha: 'a'.repeat(40) }),
  mk('pr_opened', '2026-10-16T08:06:00Z', { pr: 30, task: 't/x', author: 'bot' }),
  mk('check_result', '2026-10-16T08:40:00Z', { workflow: 'gates', prs: [30], conclusion: 'failure' }),
];

test('closed PRs: only open PRs stay in PR lanes; closed ones are counted, merged ones untouched', () => {
  const pl = pipeline(prEvents(), { openPrs: new Set([20, 22]) });
  const where = Object.fromEntries(pl.lanes.flatMap((l) => l.cards.map((c) => [c.label, l.key])));
  assert.deepEqual(where, { 'PR #20': 'checks', 'PR #22': 'pr-open', 'PR #5': 'merged' });
  assert.deepEqual(pl.closed.map((c) => c.label), ['PR #16', 'PR #17', 'PR #21', 't/x']);
  assert.equal(pl.prStateKnown, true);
  assert.ok(pl.lanes.every((l) => !l.prStateUnknown));
  assert.equal(pl.total, 3);
});

test('closed PRs: without the open-PR list, cards stay and PR lanes say the state is unknown', () => {
  for (const pl of [pipeline(prEvents()), pipeline(prEvents(), { openPrs: null })]) {
    assert.equal(pl.prStateKnown, false);
    assert.deepEqual(pl.closed, []);
    const unknown = pl.lanes.filter((l) => l.prStateUnknown).map((l) => l.key);
    assert.deepEqual(unknown, ['pr-open', 'checks', 'queued']);
    assert.equal(pl.lanes.find((l) => l.key === 'merged').prStateUnknown, false);
    assert.equal(pl.total, 7);
  }
  // Sample data: PRs opened and never merged count as open.
  assert.deepEqual([...unmergedPrs(prEvents())].sort((a, b) => a - b), [16, 17, 20, 21, 22, 30]);
  assert.equal(pipeline(fixture(), { openPrs: unmergedPrs(fixture()) }).closed.length, 0);
});

test('tier matcher: bold or plain "Tier:" with human or owner, labels, drafts excluded', () => {
  const yes = [
    '**Tier:** human (controller + workflow); **owner merges.**',
    '**Tier:** owner-tier (factory repo).',
    'Some text\nTier: Human\nmore',
    '**Tier**: owner',
    'Tier: **human**',
    '__Tier:__ OWNER',
  ];
  for (const body of yes) assert.equal(isHumanTierPr({ body }), true, body);
  const no = ['Tier: auto', '**Tier:** auto-strict', 'frontier: human', 'No tier line here', '', null];
  for (const body of no) assert.equal(isHumanTierPr({ body }), false, String(body));
  assert.equal(isHumanTierPr({ body: 'Tier: auto', labels: [{ name: 'owner-review' }] }), true);
  assert.equal(isHumanTierPr({ labels: ['Human-Tier'] }), true);
  assert.equal(isHumanTierPr({ labels: [{ name: 'needs-human' }] }), true);
  assert.equal(isHumanTierPr({ labels: [{ name: 'bug' }] }), false);
  assert.equal(isHumanTierPr({ draft: true, body: '**Tier:** human' }), false);
  assert.equal(isHumanTierPr({ draft: true, labels: ['owner-review'] }), false);
  assert.equal(isHumanTierPr(null), false);
  const sum = summarizePr({ number: 20, title: 'T', draft: false, created_at: '2026-10-16T22:14:03Z', body: '**Tier:** human', labels: [] });
  assert.deepEqual(sum, { number: 20, title: 'T', draft: false, createdAt: '2026-10-16T22:14:03Z', humanTier: true });
  assert.equal('body' in sum, false, 'the body is not kept');
});

test('needs-you: owner reviews are listed oldest first, after deduping audit items', () => {
  const now = at('2026-10-16T23:00:00Z');
  const pr = (number, createdAt, humanTier = true, draft = false) => ({ number, title: `PR ${number}`, draft, createdAt, humanTier });
  const reviews = reviewItems([
    { repo: 'sabbasi3-factory-lab/chrono-node-rs', prs: [pr(23, '2026-10-16T22:26:13Z', true, true), pr(22, '2026-10-16T22:21:26Z'), pr(20, '2026-10-16T22:14:03Z'), pr(19, '2026-10-16T21:00:00Z', false)] },
    { repo: 'sabbasi3-factory-lab/factory', prs: [pr(4, '2026-10-16T22:43:47Z'), pr(3, '2026-10-16T22:22:55Z')] },
    { repo: 'not a repo', prs: [pr(1, '2026-10-16T20:00:00Z')] },
  ], now);
  assert.deepEqual(reviews.map((r) => `${r.repo.split('/')[1]}#${r.number}`), ['chrono-node-rs#20', 'chrono-node-rs#22', 'factory#3', 'factory#4']);
  assert.equal(reviews[0].url, 'https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/20');
  assert.equal(reviews[0].kind, 'review');
  assert.equal(Math.round(reviews[0].ageMs / 60000), 46);

  const audit = [
    { key: 'task:t/a', kind: 'needs_human', pr: null, since: '2026-10-16T22:00:00Z' },
    { key: 'pr:22', kind: 'needs_human', pr: 22, since: '2026-10-16T22:30:00Z' },
  ];
  const all = combineNeedsYou(audit, reviews, 'sabbasi3-factory-lab/chrono-node-rs');
  assert.deepEqual(all.map((i) => i.key), [
    'task:t/a',
    'review:sabbasi3-factory-lab/chrono-node-rs#20',
    'review:sabbasi3-factory-lab/factory#3',
    'pr:22', // the audit item replaces the chrono-node-rs#22 review
    'review:sabbasi3-factory-lab/factory#4',
  ]);
  assert.deepEqual(combineNeedsYou([], [], 'x/y'), []);
});

// --- review of factory#4 -----------------------------------------------------------

const laneOf = (events, label, opts) => {
  for (const l of pipeline(events, opts).lanes) for (const c of l.cards) if (c.label === label) return l.key;
  return null;
};
const cardOf = (events, label, opts) => pipeline(events, opts).lanes.flatMap((l) => l.cards).find((c) => c.label === label);

test('pipeline: a late run_finished never moves a merged or deployed card back; a real repair does', () => {
  const T = { task: 't/a', issue: 1 };
  const base = [
    mk('dispatched', '2026-10-16T08:00:00Z', { ...T, attempt: 1, effect: 'dispatch', reason: 'ready' }),
    mk('pr_opened', '2026-10-16T08:30:00Z', { ...T, pr: 10, head_sha: 'a'.repeat(40), author: 'bot' }),
    mk('merged', '2026-10-16T09:00:00Z', { ...T, pr: 10, merge_commit_sha: 'b'.repeat(40) }),
  ];
  const finished = mk('run_finished', '2026-10-17T02:00:00Z', { ...T, attempt: 1, aic: 100 });
  const deployed = mk('deployed', '2026-10-16T09:20:00Z', { ...T, pr: 10 });
  // Collector record after the merge (and after the deploy): the card stays put.
  assert.equal(laneOf([...base, finished], 't/a'), 'merged');
  assert.equal(laneOf([...base, deployed, finished], 't/a'), 'deployed');
  // Record before the merge: the merge still wins.
  assert.equal(laneOf([base[0], base[1], finished, base[2]], 't/a'), 'merged');
  // Other late records don't undo a merge either (the merge queue may log dequeued after merged).
  assert.equal(laneOf([...base, mk('dequeued', '2026-10-16T09:00:01Z', { pr: 10, actor: 'bot' })], 't/a'), 'merged');
  // A real repair moves it back to Running; a dry-run one doesn't.
  const repair = (dry) => mk('repair_dispatched', '2026-10-16T10:00:00Z', { ...T, pr: 10, attempt: 2, effect: 'dispatch', reason: 'regression' }, dry);
  assert.equal(laneOf([...base, finished, repair(false)], 't/a'), 'running');
  assert.equal(laneOf([...base, finished, repair(true)], 't/a'), 'merged');
  // Forward moves by records still work: dispatched (ready lane) -> run_finished stays Running.
  assert.equal(laneOf([mk('ready', '2026-10-16T07:00:00Z', T), base[0], finished], 't/a'), 'running');
});

test('pipeline: human_action and contract_pinned clear side-state tags; dry-run decisions do not', () => {
  const nh = mk('needs_human', '2026-10-16T08:00:00Z', { task: 't/a', issue: 1, pr: 10, effect: 'label', reason: 'r' });
  const opened = mk('pr_opened', '2026-10-16T07:00:00Z', { task: 't/a', pr: 10, author: 'bot' });
  const review = mk('human_action', '2026-10-16T09:00:00Z', { action: 'review', pr: 10, reviewer: 'owner', state: 'approved', submitted_at: '2026-10-16T09:00:00Z' }, true);
  const tags = (events) => cardOf(events, 't/a', { openPrs: new Set([10]) }).tags.map((t) => t.text);
  assert.deepEqual(tags([opened, nh]), ['needs human']);
  assert.deepEqual(tags([opened, nh, review]), [], 'human_action is a fact, even with dry_run: true');

  const stale = mk('stale_contract', '2026-10-16T08:00:00Z', { task: 't/b', issue: 2, effect: 'hold', reason: 'contract-changed' });
  const pinned = mk('contract_pinned', '2026-10-16T09:00:00Z', { task: 't/b', issue: 2, contract_sha: 'abc1234' });
  const tagsB = (events) => cardOf(events, 't/b').tags.map((t) => t.text);
  assert.deepEqual(tagsB([stale]), ['stale contract']);
  assert.deepEqual(tagsB([stale, pinned]), []);
  const dryPick = mk('picked', '2026-10-16T09:00:00Z', { task: 't/b', issue: 2, effect: 'pick', reason: 'priority' }, true);
  assert.deepEqual(tagsB([stale, dryPick]), ['stale contract', 'dry-run plan']);
});

test('pipeline: failure tags come from the latest result per workflow on the current head', () => {
  const head1 = '1'.repeat(40);
  const head2 = '2'.repeat(40);
  const chk = (t, workflow, conclusion, head, extra = {}) => mk('check_result', t, { workflow, conclusion, prs: [7], head_sha: head, ...extra });
  const opened = mk('pr_opened', '2026-10-16T08:00:00Z', { pr: 7, head_sha: head1, author: 'owner' });
  const tags = (events) => cardOf(events, 'PR #7', { openPrs: new Set([7]) }).tags.map((t) => t.text);
  // gates fails, then ci succeeds on the same head: the gates failure is still shown.
  assert.deepEqual(tags([opened, chk('2026-10-16T08:10:00Z', 'gates', 'failure', head1, { failure_signature: 'golden:x#1' }), chk('2026-10-16T08:11:00Z', 'ci', 'success', head1)]), ['gates failure']);
  // A later gates success on that head clears it.
  assert.deepEqual(tags([opened, chk('2026-10-16T08:10:00Z', 'gates', 'failure', head1), chk('2026-10-16T08:20:00Z', 'gates', 'success', head1)]), []);
  // Both workflows failing show both.
  assert.deepEqual(tags([opened, chk('2026-10-16T08:10:00Z', 'gates', 'failure', head1), chk('2026-10-16T08:11:00Z', 'ci', 'timed_out', head1)]), ['gates failure', 'ci timed_out']);
  // A new head starts afresh, and a late result for the old head is ignored.
  assert.deepEqual(tags([opened, chk('2026-10-16T08:10:00Z', 'gates', 'failure', head1), chk('2026-10-16T09:00:00Z', 'ci', 'success', head2), chk('2026-10-16T09:01:00Z', 'gates', 'failure', head1)]), []);
  // Skipped and neutral aren't failures.
  assert.deepEqual(tags([opened, chk('2026-10-16T08:10:00Z', 'gates', 'skipped', head1), chk('2026-10-16T08:11:00Z', 'ci', 'neutral', head1)]), []);
});

test('sparkline geometry marks every valid point and never bridges a gap', () => {
  const g = sparkSegments([100, null, 50, null, 75]);
  assert.deepEqual(g.points.map((p) => [p.i, p.v]), [[0, 100], [2, 50], [4, 75]]);
  assert.deepEqual(g.segments, []);
  const h = sparkSegments([1, 2, null, 3, null, 4, 5, 6]);
  assert.equal(h.points.length, 6);
  assert.deepEqual(h.segments.map((seg) => seg.map((p) => p.i)), [[0, 1], [5, 6, 7]]);
  assert.deepEqual(sparkSegments([null, null]), { points: [], segments: [] });
  assert.deepEqual(sparkSegments(undefined), { points: [], segments: [] });
});

// --- glance view (one health chip, compact numbers) ----------------------------------

test('health chip: Healthy only with fresh data, a verified chain and a heartbeat within 70 min', () => {
  const events = fixture();
  const lastHb = at('2026-10-16T11:00:03Z');
  const hbAt = (min) => deriveMetrics(events, { now: lastHb + min * 60000 }).heartbeat;
  const verified = { status: 'verified', total: 46 };
  const ok = { loaded: true, chain: verified, heartbeat: hbAt(12), dataAgeMin: 1 };
  const health = (over) => healthSummary({ ...ok, ...over });

  assert.deepEqual(health({}), { level: 'ok', label: 'Healthy', reasons: [] });
  assert.equal(health({ dataAgeMin: null }).level, 'ok', 'sample data has no age');

  // Degraded: late heartbeat, unknown heartbeat, stale data, failed refresh, unverified chain.
  assert.deepEqual(health({ heartbeat: hbAt(75) }), { level: 'warn', label: 'Degraded', reasons: ['Heartbeat late (75 min)'] });
  assert.equal(health({ heartbeat: null }).level, 'warn');
  assert.deepEqual(health({ dataAgeMin: 25 }).reasons, ['Data is 25 min old']);
  assert.equal(health({ dataAgeMin: 10 }).level, 'ok', 'up to 10 min old is fresh');
  assert.deepEqual(health({ error: 'GitHub API error (HTTP 502).' }).reasons, ['Last refresh failed: GitHub API error (HTTP 502).']);
  assert.equal(health({ error: 'x', dataAgeMin: 60 }).reasons.length, 1, 'a failed refresh explains the age');
  assert.equal(health({ chain: { status: 'empty' } }).level, 'warn');
  assert.equal(health({ chain: null }).level, 'warn');

  // Down: stale or missing heartbeat, broken chain, no log, nothing loaded because of an error.
  assert.deepEqual(health({ heartbeat: hbAt(3 * 60 + 5) }), { level: 'alert', label: 'Down', reasons: ['Heartbeat stale (3 h)'] });
  assert.equal(health({ heartbeat: deriveMetrics([], { now: lastHb }).heartbeat }).level, 'alert');
  assert.equal(health({ chain: { status: 'broken', brokenAt: 7 } }).reasons[0], 'Chain broken at event 7');
  assert.deepEqual(healthSummary({ loaded: true, noLog: true }), { level: 'alert', label: 'Down', reasons: ['No audit log yet'] });
  assert.equal(healthSummary({ loaded: false, error: 'offline' }).level, 'alert');

  // The worst condition wins, and reasons list worst first.
  const both = health({ heartbeat: hbAt(75), chain: { status: 'broken', brokenAt: 3 } });
  assert.equal(both.level, 'alert');
  assert.deepEqual(both.reasons, ['Chain broken at event 3', 'Heartbeat late (75 min)']);

  assert.deepEqual(healthSummary({ loaded: false }), { level: 'info', label: 'Checking', reasons: ['Loading the audit log'] });
  assert.deepEqual(Object.values(HEALTH_LABELS), ['Healthy', 'Degraded', 'Down', 'Checking']);
});

test('compact ages are one token; short titles keep at most N words; refs are repo-prefixed off the home repo', () => {
  assert.equal(compactAge(12000), '12s');
  assert.equal(compactAge(59999), '59s');
  assert.equal(compactAge(60000), '1m');
  assert.equal(compactAge(49 * 60000 + 30000), '49m');
  assert.equal(compactAge(7 * 3600000 + 9 * 60000), '7h');
  assert.equal(compactAge(47 * 3600000), '47h');
  assert.equal(compactAge(50 * 3600000), '2d');
  for (const v of [null, undefined, -5, NaN]) assert.equal(compactAge(v), '—');

  assert.equal(shortTitle('Dashboard v2: needs-you hero, KPI trends, pipeline'), 'Dashboard v2: needs-you hero, KPI…');
  assert.equal(shortTitle('Dashboard v2: needs-you hero, KPI trends', 4), 'Dashboard v2: needs-you hero…');
  assert.equal(shortTitle('  Fix   the  parser  '), 'Fix the parser');
  assert.equal(shortTitle(''), '');
  assert.equal(shortTitle(null), '');
  assert.ok(shortTitle('x'.repeat(80)).length <= 48);
  assert.ok(shortTitle('x'.repeat(80)).endsWith('…'));

  const home = 'sabbasi3-factory-lab/chrono-node-rs';
  assert.equal(prRef(home, 22, home), '#22');
  assert.equal(prRef('sabbasi3-factory-lab/factory', 3, home), 'factory#3');
  assert.equal(prRef(home, null, home), '—');
});
