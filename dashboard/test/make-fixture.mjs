// Builds the hash-chained sample audit logs (real SHA-256 values) used by the tests and
// the previews, and the independent-verifier anchors over each:
//
// - fixtures/sample.jsonl and fixtures/anchors.jsonl (?fixture=1): a busy factory with
//   work in every stage, two items that need the owner and hourly anchors.
// - fixtures/quiet.jsonl and fixtures/quiet-anchors.jsonl (?fixture=quiet): the quiet
//   state the live page is usually in: nothing needs the owner, factory off, dry run,
//   no agents running, ten merged PRs, and heartbeats and anchors at the irregular
//   cadence GitHub's scheduler really delivers (every 2 to 8 h, not hourly), plus three
//   tasks done earlier, so the board reads "all done".
// - fixtures/sample-meta.json and quiet-meta.json: the task map, contracts, task issues, build
//   cost and drill record each sample uses instead of GitHub.
// - fixtures/outcomes.json: the busy sample's gh-aw Outcomes file; the quiet sample has none
//   ("gh-aw Outcomes not available yet").
//
//   node dashboard/test/make-fixture.mjs
//
// The output is deterministic, so a test checks the committed file is current.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalize } from '../lib.js';

export const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/sample.jsonl', import.meta.url));
export const ANCHORS_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/anchors.jsonl', import.meta.url));
export const QUIET_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/quiet.jsonl', import.meta.url));
export const QUIET_ANCHORS_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/quiet-anchors.jsonl', import.meta.url));
// Stand-ins for the task map, the contracts, the task issues, the build cost and the drill record,
// so sample mode reads nothing from GitHub: { taskmap, contracts: { id: yaml }, issues, buildCost?, drills }.
export const META_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/sample-meta.json', import.meta.url));
export const OUTCOMES_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/outcomes.json', import.meta.url));
export const QUIET_META_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/quiet-meta.json', import.meta.url));
// The preview pins its clock 12 min after the last event, so ages and "today" read as
// they would live.
export const FIXTURE_NOW = '2026-10-16T11:12:00Z';
export const QUIET_FIXTURE_NOW = '2026-10-17T13:12:00Z';

const FACTORY_VERSION = 'f4c1a9e';
const OWNER = 'example-owner';
const CONTROLLER = 'sabbasi3-factory-controller[bot]';
const AGENT = 'github-actions[bot]';

const hex = (seed, len = 40) => createHash('sha256').update(String(seed)).digest('hex').slice(0, len);

// Deterministic UUID v4 (version and variant bits set) for a reproducible fixture.
function uuid(seed) {
  const h = hex(`uuid:${seed}`, 32).split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16], 16) % 4];
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// The busy sample's outcomes.json: PR 6 accepted (not zero-touch: the owner reviewed
// and enqueued it), PR 7 accepted zero-touch, PR 8 pending under repair, casual-date's run still
// without outputs, a reviewer run with no task, a drill PR rejected, and one malformed run.
export function buildOutcomes() {
  const PR = (n) => `https://github.com/sabbasi3-factory-lab/chrono-node-rs/pull/${n}`;
  const item = (type, url, status, zeroTouch = null) => ({ type, object_url: url, outcome_status: status, zero_touch: zeroTouch });
  const run = (run_id, workflow, task, drill, created_at, aic, items) => ({ run_id, workflow, title: `${workflow} ${task ?? 'one factory PR'}`, created_at, aic, task, drill, items });
  const runs = [
    run(4001, 'implement', 'en/ordinal', false, '2026-10-15T14:00:09Z', 179, [item('create_pull_request', PR(6), 'accepted', false), item('add_comment', null, 'pending')]),
    run(4101, 'implement', 'en/weekday-parser', false, '2026-10-16T08:06:08Z', 200, [item('create_pull_request', PR(7), 'accepted', true)]),
    run(4102, 'implement', 'en/month-parser', false, '2026-10-16T09:01:07Z', 262, [item('create_pull_request', PR(8), 'pending')]),
    run(4103, 'repair', 'en/month-parser', false, '2026-10-16T10:00:08Z', null, [item('push_to_pull_request_branch', PR(8), 'pending')]),
    run(4104, 'implement', 'en/casual-date', false, '2026-10-16T10:31:06Z', null, []),
    run(4105, 'review', null, false, '2026-10-16T08:51:10Z', 61, [item('create_check_run', null, 'unknown')]),
    run(4200, 'implement', 'drill/repair-ok', true, '2026-10-15T10:00:00Z', 150, [item('create_pull_request', PR(3), 'rejected')]),
    { run_id: 'not-a-number', workflow: 'implement', drill: false, items: [] },
  ];
  return { generated_at: '2026-10-16T10:58:00Z', gh_aw_version: 'v0.92.0', runs, summary: { accepted: 2, rejected: 1, pending: 3, unknown: 1 } };
}

const hb = (hour, runId, openPrs, decisions) => ({
  type: 'heartbeat',
  run_id: runId,
  open_pr_count: openPrs,
  decision_count: decisions,
  factory_enabled: true,
  hour,
  trigger: 'schedule',
});

// [timestamp, type, payload-without-common-fields]
const STEPS = [
  ['2026-10-15T09:00:07Z', hb('2026-10-15T09', 2001, 0, 0)],
  ['2026-10-15T10:00:05Z', { type: 'dispatched', task: 'en/ordinal', issue: 41, attempt: 1, contract_sha: hex('c41', 7), workflow: 'implement', effect: 'dispatch', reason: 'ready', dry_run: true }],
  ['2026-10-15T12:30:00Z', { type: 'pr_opened', pr: 5, head_sha: hex('h5'), author: OWNER, opened_at: '2026-10-15T12:29:41Z' }],
  ['2026-10-15T12:41:10Z', { type: 'check_result', workflow: 'ci', run_id: 3001, run_attempt: 1, event: 'pull_request', head_sha: hex('h5'), prs: [5], conclusion: 'success', completed_at: '2026-10-15T12:40:55Z' }],
  ['2026-10-15T12:44:02Z', { type: 'check_result', workflow: 'gates', run_id: 3002, run_attempt: 1, event: 'pull_request', head_sha: hex('h5'), prs: [5], conclusion: 'success', completed_at: '2026-10-15T12:43:50Z', heldout_seed: '8231774409126655213' }],
  ['2026-10-15T13:02:00Z', { type: 'human_action', action: 'review', pr: 5, reviewer: OWNER, state: 'approved', submitted_at: '2026-10-15T13:01:48Z' }],
  ['2026-10-15T13:03:00Z', { type: 'queued', pr: 5, actor: OWNER, at: '2026-10-15T13:02:55Z' }],
  ['2026-10-15T13:20:00Z', { type: 'merged', pr: 5, merge_commit_sha: hex('m5'), merged_at: '2026-10-15T13:19:30Z' }],
  // Post-merge ci on main fails for the owner's PR 5: an escaped defect.
  ['2026-10-15T13:31:00Z', { type: 'check_result', workflow: 'ci', run_id: 3010, run_attempt: 1, event: 'push', head_sha: hex('m5'), prs: [], conclusion: 'failure', completed_at: '2026-10-15T13:30:41Z', failure_signature: 'test:golden-en-casual' }],
  ['2026-10-15T13:50:00Z', { type: 'ready', task: 'en/ordinal', issue: 41, contract_sha: hex('c41', 7) }],
  ['2026-10-15T13:58:00Z', { type: 'picked', task: 'en/ordinal', issue: 41, effect: 'pick', reason: 'priority' }],
  ['2026-10-15T14:00:00Z', { type: 'dispatched', task: 'en/ordinal', issue: 41, attempt: 1, contract_sha: hex('c41', 7), workflow: 'implement', run_id: 4001, model: 'pinned-model-a', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-15T14:35:00Z', { type: 'run_finished', task: 'en/ordinal', attempt: 1, run_id: 4001, model: 'pinned-model-a', tokens_input: 812000, tokens_output: 21400, tokens_cache: 640000, aic: 280, duration_ms: 2040000 }],
  ['2026-10-15T14:36:00Z', { type: 'pr_opened', pr: 6, task: 'en/ordinal', head_sha: hex('h6'), author: AGENT, opened_at: '2026-10-15T14:35:40Z' }],
  ['2026-10-15T14:50:00Z', { type: 'check_result', workflow: 'ci', run_id: 3003, run_attempt: 1, event: 'pull_request', head_sha: hex('h6'), prs: [6], conclusion: 'success', completed_at: '2026-10-15T14:49:30Z' }],
  ['2026-10-15T14:55:00Z', { type: 'check_result', workflow: 'gates', run_id: 3004, run_attempt: 1, event: 'pull_request', head_sha: hex('h6'), prs: [6], conclusion: 'success', completed_at: '2026-10-15T14:54:31Z', heldout_seed: '17345990012231457' }],
  ['2026-10-15T15:10:00Z', { type: 'human_action', action: 'review', pr: 6, reviewer: OWNER, state: 'commented', submitted_at: '2026-10-15T15:09:12Z' }],
  // The owner puts the agent's PR 6 in the merge queue by hand: one manual step after go-live.
  ['2026-10-15T15:12:00Z', { type: 'queued', pr: 6, actor: OWNER, at: '2026-10-15T15:11:58Z' }],
  ['2026-10-15T15:30:00Z', { type: 'merged', pr: 6, task: 'en/ordinal', merge_commit_sha: hex('m6'), merged_at: '2026-10-15T15:29:44Z' }],
  ['2026-10-15T15:31:00Z', { type: 'task_done', task: 'en/ordinal', issue: 41, pr: 6, effect: 'close_task', reason: 'task_merged' }],
  ['2026-10-15T15:45:00Z', { type: 'deployed', task: 'en/ordinal', pr: 6, merge_commit_sha: hex('m6'), deployment_id: 5001 }],
  ['2026-10-15T15:46:00Z', { type: 'spend_snapshot', day: '2026-10-15', aic_today: 280, runs: [{ run_id: 4001, aic: 280, status: 'measured' }], runs_total: 1 }],
  ['2026-10-16T07:00:00Z', { type: 'needs_human', task: 'en/time-expression', issue: 45, attempt: 3, effect: 'label', reason: 'same-failure-signature' }],
  ['2026-10-16T08:00:00Z', { type: 'ready', task: 'en/weekday-parser', issue: 42, contract_sha: hex('c42', 7) }],
  ['2026-10-16T08:05:00Z', { type: 'picked', task: 'en/weekday-parser', issue: 42, effect: 'pick', reason: 'priority' }],
  ['2026-10-16T08:06:00Z', { type: 'dispatched', task: 'en/weekday-parser', issue: 42, attempt: 1, contract_sha: hex('c42', 7), workflow: 'implement', run_id: 4101, model: 'pinned-model-a', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-16T08:31:00Z', { type: 'run_finished', task: 'en/weekday-parser', attempt: 1, run_id: 4101, model: 'pinned-model-a', tokens_input: 905000, tokens_output: 24800, tokens_cache: 701000, aic: 312, duration_ms: 1490000 }],
  ['2026-10-16T08:32:00Z', { type: 'pr_opened', pr: 7, task: 'en/weekday-parser', head_sha: hex('h7'), author: AGENT, opened_at: '2026-10-16T08:31:44Z' }],
  ['2026-10-16T08:45:00Z', { type: 'check_result', workflow: 'ci', run_id: 3005, run_attempt: 1, event: 'pull_request', head_sha: hex('h7'), prs: [7], conclusion: 'success', completed_at: '2026-10-16T08:44:21Z' }],
  ['2026-10-16T08:50:00Z', { type: 'check_result', workflow: 'gates', run_id: 3006, run_attempt: 1, event: 'pull_request', head_sha: hex('h7'), prs: [7], conclusion: 'success', completed_at: '2026-10-16T08:49:40Z', heldout_seed: '5521300987112340021' }],
  ['2026-10-16T08:50:30Z', { type: 'review_dispatched', task: 'en/weekday-parser', issue: 42, pr: 7, head_sha: hex('h7'), run_id: 3006, effect: 'dispatch_workflow:review', reason: 'review_needed' }],
  ['2026-10-16T08:52:00Z', { type: 'queued', pr: 7, actor: CONTROLLER, at: '2026-10-16T08:51:51Z' }],
  ['2026-10-16T09:00:06Z', hb('2026-10-16T09', 2025, 1, 6)],
  ['2026-10-16T09:00:20Z', { type: 'spend_snapshot', day: '2026-10-16', aic_today: 1307, runs: [{ run_id: 4101, aic: 312, status: 'measured' }, { run_id: 4105, aic: 95, status: 'measured' }, { run_id: 4102, aic: 900, status: 'reserved' }], runs_total: 3 }],
  ['2026-10-16T09:00:30Z', { type: 'picked', task: 'en/month-parser', issue: 43, effect: 'pick', reason: 'priority' }],
  ['2026-10-16T09:01:00Z', { type: 'dispatched', task: 'en/month-parser', issue: 43, attempt: 1, contract_sha: hex('c43', 7), workflow: 'implement', run_id: 4102, model: 'pinned-model-a', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-16T09:10:00Z', { type: 'merged', pr: 7, task: 'en/weekday-parser', merge_commit_sha: hex('m7'), merged_at: '2026-10-16T09:09:37Z' }],
  ['2026-10-16T09:10:30Z', { type: 'task_done', task: 'en/weekday-parser', issue: 42, pr: 7, effect: 'close_task', reason: 'task_merged' }],
  ['2026-10-16T09:25:00Z', { type: 'deployed', task: 'en/weekday-parser', pr: 7, merge_commit_sha: hex('m7'), deployment_id: 5002 }],
  ['2026-10-16T09:40:00Z', { type: 'run_finished', task: 'en/month-parser', attempt: 1, run_id: 4102, model: 'pinned-model-a', tokens_input: 1130000, tokens_output: 30100, tokens_cache: 880000, aic: 410, duration_ms: 2280000 }],
  ['2026-10-16T09:41:00Z', { type: 'pr_opened', pr: 8, task: 'en/month-parser', head_sha: hex('h8'), author: AGENT, opened_at: '2026-10-16T09:40:39Z' }],
  ['2026-10-16T09:55:00Z', { type: 'check_result', workflow: 'gates', run_id: 3007, run_attempt: 1, event: 'pull_request', head_sha: hex('h8'), prs: [8], conclusion: 'failure', completed_at: '2026-10-16T09:54:12Z', heldout_seed: '9007199254740993', failure_signature: 'golden:en/month#3' }],
  ['2026-10-16T10:00:00Z', { type: 'repair_dispatched', task: 'en/month-parser', issue: 43, pr: 8, attempt: 2, contract_sha: hex('c43', 7), workflow: 'repair', run_id: 4103, model: 'pinned-model-a', effect: 'dispatch', reason: 'ci-failed' }],
  ['2026-10-16T10:00:04Z', hb('2026-10-16T10', 2026, 2, 9)],
  ['2026-10-16T10:30:00Z', { type: 'picked', task: 'en/casual-date', issue: 44, effect: 'pick', reason: 'priority' }],
  ['2026-10-16T10:31:00Z', { type: 'dispatched', task: 'en/casual-date', issue: 44, attempt: 1, contract_sha: hex('c44', 7), workflow: 'implement', run_id: 4104, model: 'pinned-model-b', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-16T10:40:00Z', { type: 'stale_contract', task: 'en/relative', issue: 46, contract_sha: hex('c46', 7), effect: 'hold', reason: 'contract-changed' }],
  ['2026-10-16T10:45:00Z', { type: 'pr_opened', pr: 9, head_sha: hex('h9'), author: OWNER, opened_at: '2026-10-16T10:44:20Z' }],
  ['2026-10-16T10:50:00Z', { type: 'queued', pr: 9, actor: OWNER, at: '2026-10-16T10:49:51Z' }],
  ['2026-10-16T10:55:00Z', { type: 'dequeued', pr: 9, actor: CONTROLLER, at: '2026-10-16T10:54:40Z' }],
  ['2026-10-16T10:58:00Z', { type: 'queued', pr: 9, actor: OWNER, at: '2026-10-16T10:57:30Z' }],
  ['2026-10-16T10:59:00Z', { type: 'auto_ready', task: 'common/iso-date', issue: 47, reason: 'deps_merged' }],
  ['2026-10-16T11:00:00Z', { type: 'spend_snapshot', day: '2026-10-16', aic_today: 2617, runs: [{ run_id: 4101, aic: 312, status: 'measured' }, { run_id: 4105, aic: 95, status: 'measured' }, { run_id: 4102, aic: 410, status: 'measured' }, { run_id: 4103, aic: 900, status: 'reserved' }, { run_id: 4104, aic: 900, status: 'reserved' }], runs_total: 5 }],
  ['2026-10-16T11:00:03Z', hb('2026-10-16T11', 2027, 3, 13)],
];

function chainLines(steps, { dryRun = false, seed = '' } = {}) {
  const lines = [];
  let parent = null;
  steps.forEach(([timestamp, { type, ...fields }], i) => {
    const sources = Object.keys(fields).sort().map((k) => `${k}=${canonicalize(fields[k])}`).join('&');
    const payload = {
      dedupe_key: 'sha256:' + hex(`${type}|${sources}`, 64),
      dry_run: dryRun,
      factory_version: FACTORY_VERSION,
      ...fields,
    };
    const record = { version: 1, id: uuid(`${seed}${i}`), type, timestamp, parents: parent ? [parent] : [], payload };
    const sha = 'sha256:' + createHash('sha256').update(canonicalize(record)).digest('hex');
    lines.push(canonicalize({ ...record, sha }));
    parent = sha;
  });
  return lines;
}

export function buildFixtureLines() {
  return chainLines(STEPS);
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// One anchor per time in `times`, as the audit-verify workflow would append them, each
// covering the events logged by then.
function anchorLines(eventLines, times, firstRunId) {
  const events = eventLines.map((l) => JSON.parse(l));
  return times.map((ms, i) => {
    const at = isoSeconds(ms);
    const covered = events.filter((e) => e.timestamp <= at);
    return canonicalize({
      at,
      audit_head: covered.length ? hex(`audit-head:${covered.length}`) : null,
      events: covered.length,
      last_sha: covered.length ? covered.at(-1).sha : null,
      run_id: firstRunId + i,
      source: 'sabbasi3-factory-lab/chrono-node-rs',
      v: 1,
    });
  });
}

// One anchor an hour at :47.
export function buildAnchorLines() {
  const times = [];
  for (let ms = Date.parse('2026-10-15T09:47:12Z'); ms <= Date.parse('2026-10-16T10:47:12Z'); ms += 3600000) times.push(ms);
  return anchorLines(buildFixtureLines(), times, 5001);
}

// --- The quiet fixture -------------------------------------------------------------

// Times walking back from `last` by the given gaps (in hours), oldest first.
function backFrom(last, gapsH) {
  const out = [Date.parse(last)];
  for (const g of gapsH) out.unshift(out[0] - Math.round(g * 3600000));
  return out;
}

// Heartbeat gaps as measured live over 48 h on a Free-plan org: median about 2.4 h,
// with some gaps of 4 to 8 h. The newest heartbeat is the last event.
const QUIET_HEARTBEAT_GAPS_H = [2.3, 4.4, 2.1, 7.6, 2.4, 1.9, 5.2, 2.6, 2.2, 3.1, 2.4, 1.8, 2.5, 4.1, 2.4, 2.0, 6.3, 2.7, 2.2, 2.4];
const QUIET_HEARTBEATS = backFrom('2026-10-17T13:00:00Z', QUIET_HEARTBEAT_GAPS_H);
// Verifier anchors at a similar cadence; the newest is 1 h 35 min before the pinned clock.
const QUIET_ANCHORS = backFrom('2026-10-17T11:37:00Z', [2.9, 5.1, 2.4, 3.3, 2.9, 2.2, 4.6, 2.9, 3.5, 2.6, 2.9, 1.9, 4.2, 2.9, 3.0]);

// Owner PRs, all merged: [pr, opened, minutes to the CI result (gates a minute later),
// minutes from the gates result to queued, minutes from queued to merged].
const QUIET_PRS = [
  [12, '2026-10-14T16:05:10Z', 3, 0.3, 0.1],
  [13, '2026-10-14T17:40:22Z', 4, 6, 1],
  [14, '2026-10-14T19:12:40Z', 9, 45, 5],
  [15, '2026-10-15T08:31:05Z', 8, 41, 5],
  [18, '2026-10-15T10:02:47Z', 5, 6, 1],
  [20, '2026-10-15T13:20:00Z', 12, 350, 9],
  [22, '2026-10-15T21:44:31Z', 14, 300, 120],
  [23, '2026-10-16T08:15:03Z', 3, 0.3, 0.2],
  [24, '2026-10-16T09:02:19Z', 4, 3, 2],
  [25, '2026-10-16T11:30:44Z', 3, 0.4, 0.2],
];

// Tasks done earlier in the quiet week: [task, issue, pr, auto_ready time, minutes to the PR,
// minutes to the merge]. The check lands 4 min and the queue 5 min after the PR, so the merge must
// come later than that. Their dispatches are dry-run plans; the merges are observed facts.
const QUIET_TASKS = [
  ['en/casual-time-parser', 31, 30, '2026-10-15T15:10:00Z', 6, 14],
  ['en/month-name-parser', 32, 31, '2026-10-16T05:20:00Z', 7, 15],
  ['common/iso-format-parser', 33, 32, '2026-10-16T14:40:00Z', 8, 21],
];

function quietSteps() {
  const steps = [];
  const add = (ms, payload) => steps.push([isoSeconds(ms), payload]);
  let runId = 7001;
  QUIET_HEARTBEATS.forEach((ms, i) => add(ms, {
    type: 'heartbeat', run_id: 6001 + i, open_pr_count: 0, decision_count: 0, factory_enabled: false,
    hour: isoSeconds(ms).slice(0, 13), trigger: 'schedule',
  }));
  // The factory is off, so the controller records one paused state (the dispatch banner).
  add(QUIET_HEARTBEATS[0] + 1000, {
    type: 'dispatch_state', state: 'paused', reason: 'kill_switch', ready: 0, in_flight: 0, spend_known: true, unreadable_runs: 0, since_source: 'transition',
  });
  for (const [pr, opened, checkMin, queueMin, mergeMin] of QUIET_PRS) {
    const t0 = Date.parse(opened);
    const head = hex(`qh${pr}`);
    const check = (ms, workflow, event, extra = {}) => add(ms + 20000, {
      type: 'check_result', workflow, run_id: runId++, run_attempt: 1, event, head_sha: head,
      ...(event === 'pull_request' ? { prs: [pr] } : {}), conclusion: 'success', completed_at: isoSeconds(ms), ...extra,
    });
    add(t0 + 15000, { type: 'pr_opened', pr, head_sha: head, author: OWNER, opened_at: isoSeconds(t0) });
    check(t0 + checkMin * 60000, 'ci', 'pull_request');
    check(t0 + (checkMin + 1) * 60000, 'gates', 'pull_request', { heldout_seed: String(BigInt(`0x${hex(`seed${pr}`, 15)}`)) });
    const queued = t0 + (checkMin + 1 + queueMin) * 60000 + 90000;
    add(queued + 5000, { type: 'queued', pr, actor: OWNER, at: isoSeconds(queued) });
    const merged = queued + mergeMin * 60000 + 30000;
    check(merged - 10000, 'ci', 'merge_group');
    add(merged + 30000, { type: 'merged', pr, merge_commit_sha: hex(`qm${pr}`), merged_at: isoSeconds(merged) });
  }
  for (const [task, issue, pr, ready, prMin, mergeMin] of QUIET_TASKS) {
    const t0 = Date.parse(ready);
    const head = hex(`qt${pr}`);
    add(t0, { type: 'auto_ready', task, issue, reason: 'deps_merged' });
    add(t0 + 20000, { type: 'dispatched', task, issue, attempt: 1, contract_sha: hex(`qc${issue}`), effect: 'dispatch_workflow:implement', reason: 'would_dispatch' });
    add(t0 + prMin * 60000, { type: 'pr_opened', pr, head_sha: head, author: AGENT, opened_at: isoSeconds(t0 + prMin * 60000 - 10000) });
    add(t0 + (prMin + 4) * 60000, { type: 'check_result', workflow: 'ci', run_id: runId++, run_attempt: 1, event: 'pull_request', head_sha: head, prs: [pr], conclusion: 'success', completed_at: isoSeconds(t0 + (prMin + 4) * 60000 - 15000) });
    add(t0 + (prMin + 5) * 60000, { type: 'queued', pr, actor: CONTROLLER, at: isoSeconds(t0 + (prMin + 5) * 60000 - 5000) });
    add(t0 + mergeMin * 60000, { type: 'merged', pr, task, merge_commit_sha: hex(`qtm${pr}`), merged_at: isoSeconds(t0 + mergeMin * 60000 - 20000) });
    add(t0 + mergeMin * 60000 + 5000, { type: 'task_done', task, issue, pr, effect: 'close_task', reason: 'task_merged' });
  }
  return steps.sort((a, b) => a[0].localeCompare(b[0]));
}

export function buildQuietFixtureLines() {
  return chainLines(quietSteps(), { dryRun: true, seed: 'quiet:' });
}

export function buildQuietAnchorLines() {
  return anchorLines(buildQuietFixtureLines(), QUIET_ANCHORS, 8001);
}

// --- Task map, contracts and agent run lists -----------------------------------------

const tierOf = (id) => (id.startsWith('common/') ? 'auto-strict' : 'auto');
const upstreamOf = (id) => id.split('/').pop().split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

function contractYaml(id, area, deps, blockDeps) {
  return [
    '# Generated by scripts/seed-backlog/seed.js from scripts/seed-backlog/taskmap.yaml.',
    `id: ${id}`,
    `title: Port ${upstreamOf(id)}`,
    `tier: ${tierOf(id)}`,
    `area: ${area}`,
    'priority: 3',
    ...(blockDeps && deps.length ? ['depends_on:', ...deps.map((d) => `  - ${d}`)] : [`depends_on: [${deps.join(', ')}]`]),
    `upstream_class: ${upstreamOf(id)}`,
    'acceptance:',
    '  - golden:',
    `      step: ${upstreamOf(id)}`,
    '',
  ].join('\n');
}

// [id, area, depends_on, block-style list]
const SAMPLE_TASKS = [
  ['common/iso-date', 'common-parsers', [], false],
  ['en/ordinal', 'en-numeric-dates', [], true],
  ['en/weekday-parser', 'en-casual', [], false],
  ['en/casual-date', 'en-casual', ['en/weekday-parser'], true],
  ['en/time-expression', 'en-casual', [], false],
  ['en/month-parser', 'en-month-names', [], false],
  ['en/range', 'en-month-names', ['en/month-parser', 'en/ordinal'], true],
  ['en/relative', 'en-relative', [], false],
];

function taskmapYaml(tasks) {
  const lines = [
    '# Sample task map (make-fixture.mjs): flow and block entries, like scripts/seed-backlog/taskmap.yaml.',
    'version: 1',
    'done:',
    '  - { step: ENCasualDateParser, rust: src/locales/en/parsers/casual_date.rs }',
    'tasks:',
  ];
  tasks.forEach(([id, area], i) => {
    if (i === 3) {
      // One block-style entry with a nested list, as in the real task map.
      lines.push(`  - id: ${id}`, `    step: ${upstreamOf(id)}`, `    area: ${area} # comment`, '    unit:', '      cases:', '        - { test: today, text: "today", expect: { text: "today" } }');
    } else lines.push(`  - { id: ${id}, step: ${upstreamOf(id)}, source: x/${upstreamOf(id)}.ts, area: ${area} }`);
  });
  lines.push('acceptance:', '  clippy: deny-warnings', '');
  return lines.join('\n');
}


// A task-issue list entry as GitHub returns it (only the fields the page reads). `marker: false`
// leaves the body without the hidden task marker, so the title prefix is used.
const issue = (number, task, state, closedAt = null, { marker = true, reason = state === 'closed' ? 'completed' : null, pr = false } = {}) => ({
  number,
  title: `${task}: Port ${upstreamOf(task)}`,
  body: `${marker ? `<!-- factory-task: ${task} -->\n` : ''}Port \`${upstreamOf(task)}\`.`,
  state,
  state_reason: reason,
  closed_at: closedAt,
  ...(pr ? { pull_request: { url: 'x' } } : {}),
});

export function buildMeta() {
  return {
    taskmap: taskmapYaml(SAMPLE_TASKS),
    contracts: Object.fromEntries(SAMPLE_TASKS.map(([id, area, deps, block]) => [id, contractYaml(id, area, deps, block)])),
    // build-cost.json and drills.json stand-ins (one drill failed, to show the count is computed).
    buildCost: { ai_units: 111000, usd: 1110, as_of: '2026-10-15', source: 'sample build journal' },
    drills: {
      as_of: '2026-10-15', source: 'docs/JOURNAL.md', defects_found_and_fixed: 1,
      runs: [{ id: 'D1', result: 'pass', note: 'after 1 manual replay' }, { id: 'D2', result: 'fail', note: 'gate missed' }, { id: 'D3', result: 'pass' }],
    },
    // GET /issues?state=all&labels=factory:task. en/range has no issue (its tile links the contract).
    issues: [
      issue(47, 'common/iso-date', 'open'),
      issue(46, 'en/relative', 'open', null, { marker: false }),
      issue(45, 'en/time-expression', 'open'),
      issue(44, 'en/casual-date', 'open'),
      issue(43, 'en/month-parser', 'open'),
      issue(42, 'en/weekday-parser', 'closed', '2026-10-16T09:10:31Z'),
      issue(41, 'en/ordinal', 'closed', '2026-10-15T15:31:02Z'),
      issue(40, 'drill/repair-ok', 'closed', '2026-10-15T09:00:00Z', { reason: 'not_planned' }),
      issue(7, 'en/weekday-parser', 'closed', '2026-10-16T09:10:00Z', { pr: true }), // a PR: ignored
    ],
  };
}

export function buildQuietMeta() {
  const tasks = QUIET_TASKS.map(([id]) => [id, id.startsWith('common/') ? 'common-parsers' : id.includes('month') ? 'en-month-names' : 'en-casual', [], false]);
  return {
    taskmap: taskmapYaml(tasks),
    contracts: Object.fromEntries(tasks.map(([id, area, deps, block]) => [id, contractYaml(id, area, deps, block)])),
    // No buildCost: the quiet sample shows the "build cost unavailable" path.
    drills: { as_of: '2026-10-17', source: 'docs/JOURNAL.md', defects_found_and_fixed: 0, runs: [{ id: 'D1', result: 'pass' }] },
    issues: QUIET_TASKS.map(([id, num, , ready, , mergeMin]) => issue(num, id, 'closed', new Date(Date.parse(ready) + mergeMin * 60000 + 10000).toISOString().replace(/\.\d{3}Z$/, 'Z'))),
  };
}

export const metaText = (meta) => JSON.stringify(meta, null, 2) + '\n';
// outcomes.json with one run per line, so the fixture stays short and diffs well.
export const outcomesText = ({ runs, ...head }) => `${JSON.stringify(head).slice(0, -1)},"runs":[\n${runs.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = buildFixtureLines();
  writeFileSync(FIXTURE_PATH, lines.join('\n') + '\n');
  console.log(`wrote ${lines.length} events to dashboard/test/fixtures/sample.jsonl`);
  const anchors = buildAnchorLines();
  writeFileSync(ANCHORS_FIXTURE_PATH, anchors.join('\n') + '\n');
  console.log(`wrote ${anchors.length} anchors to dashboard/test/fixtures/anchors.jsonl`);
  const quiet = buildQuietFixtureLines();
  writeFileSync(QUIET_FIXTURE_PATH, quiet.join('\n') + '\n');
  console.log(`wrote ${quiet.length} events to dashboard/test/fixtures/quiet.jsonl`);
  const quietAnchors = buildQuietAnchorLines();
  writeFileSync(QUIET_ANCHORS_FIXTURE_PATH, quietAnchors.join('\n') + '\n');
  console.log(`wrote ${quietAnchors.length} anchors to dashboard/test/fixtures/quiet-anchors.jsonl`);
  writeFileSync(META_FIXTURE_PATH, metaText(buildMeta()));
  writeFileSync(QUIET_META_FIXTURE_PATH, metaText(buildQuietMeta()));
  writeFileSync(OUTCOMES_FIXTURE_PATH, outcomesText(buildOutcomes()));
  console.log('wrote dashboard/test/fixtures/sample-meta.json, quiet-meta.json and outcomes.json');
}
