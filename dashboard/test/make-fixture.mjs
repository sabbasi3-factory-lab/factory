// Builds dashboard/test/fixtures/sample.jsonl: a small, hash-chained audit log
// with real SHA-256 values, used by the tests and by the ?fixture=1 preview.
//
//   node dashboard/test/make-fixture.mjs
//
// The output is deterministic, so a test checks the committed file is current.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalize } from '../lib.js';

export const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/sample.jsonl', import.meta.url));
// The preview pins its clock here, so ages and "today" read as they would live.
export const FIXTURE_NOW = '2026-10-16T11:12:00Z';

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
  ['2026-10-15T13:50:00Z', { type: 'ready', task: 'en/ordinal', issue: 41, contract_sha: hex('c41', 7) }],
  ['2026-10-15T13:58:00Z', { type: 'picked', task: 'en/ordinal', issue: 41, effect: 'pick', reason: 'priority' }],
  ['2026-10-15T14:00:00Z', { type: 'dispatched', task: 'en/ordinal', issue: 41, attempt: 1, contract_sha: hex('c41', 7), workflow: 'implement', run_id: 4001, model: 'pinned-model-a', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-15T14:35:00Z', { type: 'run_finished', task: 'en/ordinal', attempt: 1, run_id: 4001, model: 'pinned-model-a', tokens_input: 812000, tokens_output: 21400, tokens_cache: 640000, aic: 280, duration_ms: 2040000 }],
  ['2026-10-15T14:36:00Z', { type: 'pr_opened', pr: 6, task: 'en/ordinal', head_sha: hex('h6'), author: AGENT, opened_at: '2026-10-15T14:35:40Z' }],
  ['2026-10-15T14:50:00Z', { type: 'check_result', workflow: 'ci', run_id: 3003, run_attempt: 1, event: 'pull_request', head_sha: hex('h6'), prs: [6], conclusion: 'success', completed_at: '2026-10-15T14:49:30Z' }],
  ['2026-10-15T14:55:00Z', { type: 'check_result', workflow: 'gates', run_id: 3004, run_attempt: 1, event: 'pull_request', head_sha: hex('h6'), prs: [6], conclusion: 'success', completed_at: '2026-10-15T14:54:31Z', heldout_seed: '17345990012231457' }],
  ['2026-10-15T15:10:00Z', { type: 'human_action', action: 'review', pr: 6, reviewer: OWNER, state: 'commented', submitted_at: '2026-10-15T15:09:12Z' }],
  ['2026-10-15T15:12:00Z', { type: 'queued', pr: 6, actor: CONTROLLER, at: '2026-10-15T15:11:58Z' }],
  ['2026-10-15T15:30:00Z', { type: 'merged', pr: 6, task: 'en/ordinal', merge_commit_sha: hex('m6'), merged_at: '2026-10-15T15:29:44Z' }],
  ['2026-10-15T15:45:00Z', { type: 'deployed', task: 'en/ordinal', pr: 6, merge_commit_sha: hex('m6'), deployment_id: 5001 }],
  ['2026-10-16T07:00:00Z', { type: 'needs_human', task: 'en/time-expression', issue: 45, attempt: 3, effect: 'label', reason: 'same-failure-signature' }],
  ['2026-10-16T08:00:00Z', { type: 'ready', task: 'en/weekday-parser', issue: 42, contract_sha: hex('c42', 7) }],
  ['2026-10-16T08:05:00Z', { type: 'picked', task: 'en/weekday-parser', issue: 42, effect: 'pick', reason: 'priority' }],
  ['2026-10-16T08:06:00Z', { type: 'dispatched', task: 'en/weekday-parser', issue: 42, attempt: 1, contract_sha: hex('c42', 7), workflow: 'implement', run_id: 4101, model: 'pinned-model-a', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-16T08:31:00Z', { type: 'run_finished', task: 'en/weekday-parser', attempt: 1, run_id: 4101, model: 'pinned-model-a', tokens_input: 905000, tokens_output: 24800, tokens_cache: 701000, aic: 312, duration_ms: 1490000 }],
  ['2026-10-16T08:32:00Z', { type: 'pr_opened', pr: 7, task: 'en/weekday-parser', head_sha: hex('h7'), author: AGENT, opened_at: '2026-10-16T08:31:44Z' }],
  ['2026-10-16T08:45:00Z', { type: 'check_result', workflow: 'ci', run_id: 3005, run_attempt: 1, event: 'pull_request', head_sha: hex('h7'), prs: [7], conclusion: 'success', completed_at: '2026-10-16T08:44:21Z' }],
  ['2026-10-16T08:50:00Z', { type: 'check_result', workflow: 'gates', run_id: 3006, run_attempt: 1, event: 'pull_request', head_sha: hex('h7'), prs: [7], conclusion: 'success', completed_at: '2026-10-16T08:49:40Z', heldout_seed: '5521300987112340021' }],
  ['2026-10-16T08:52:00Z', { type: 'queued', pr: 7, actor: CONTROLLER, at: '2026-10-16T08:51:51Z' }],
  ['2026-10-16T09:00:06Z', hb('2026-10-16T09', 2025, 1, 6)],
  ['2026-10-16T09:00:30Z', { type: 'picked', task: 'en/month-parser', issue: 43, effect: 'pick', reason: 'priority' }],
  ['2026-10-16T09:01:00Z', { type: 'dispatched', task: 'en/month-parser', issue: 43, attempt: 1, contract_sha: hex('c43', 7), workflow: 'implement', run_id: 4102, model: 'pinned-model-a', effect: 'dispatch', reason: 'ready' }],
  ['2026-10-16T09:10:00Z', { type: 'merged', pr: 7, task: 'en/weekday-parser', merge_commit_sha: hex('m7'), merged_at: '2026-10-16T09:09:37Z' }],
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
  ['2026-10-16T11:00:03Z', hb('2026-10-16T11', 2027, 3, 13)],
];

export function buildFixtureLines() {
  const lines = [];
  let parent = null;
  STEPS.forEach(([timestamp, { type, ...fields }], i) => {
    const sources = Object.keys(fields).sort().map((k) => `${k}=${canonicalize(fields[k])}`).join('&');
    const payload = {
      dedupe_key: 'sha256:' + hex(`${type}|${sources}`, 64),
      dry_run: false,
      factory_version: FACTORY_VERSION,
      ...fields,
    };
    const record = { version: 1, id: uuid(i), type, timestamp, parents: parent ? [parent] : [], payload };
    const sha = 'sha256:' + createHash('sha256').update(canonicalize(record)).digest('hex');
    lines.push(canonicalize({ ...record, sha }));
    parent = sha;
  });
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = buildFixtureLines();
  writeFileSync(FIXTURE_PATH, lines.join('\n') + '\n');
  console.log(`wrote ${lines.length} events to dashboard/test/fixtures/sample.jsonl`);
}
