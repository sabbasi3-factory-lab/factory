import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cost, drills, languages, prLanguage, summarize, v1Spend, v2RunUsage, zeroTouch } from '../lib.mjs';

const paths = [
  'src/locales/en/mod.rs', 'src/locales/ar/locale.json', 'src/locales/ar/mod.rs', 'src/locales/zh_hans/locale.json',
  'src/locales/vi/locale.json', 'src/locales/it/locale.json', 'src/locales/mod.rs',
  'contracts/ar/a.yaml', 'contracts/ar/b.yaml', 'contracts/ar/fix-0123abcd.yaml', 'contracts/zh-hans/c.yaml', 'contracts/common/x.yaml',
];

test('languages: every locale module on main, with how it was ported and its steps (fix contracts aside)', () => {
  assert.deepEqual(languages(paths), [
    { code: 'ar', method: 'v1 (generated onboarding)', steps: 2 },
    { code: 'en', method: 'v1 (waves)', steps: 0 },
    { code: 'it', method: 'factory v2', steps: 0 },
    { code: 'vi', method: 'goal agent (A/B)', steps: 0 },
    { code: 'zh-hans', method: 'v1 (generated onboarding)', steps: 1 },
  ]);
});

test('zeroTouch: only bots commented, reviewed and committed; a truncated list is unknown', () => {
  const ok = { pageInfo: { hasNextPage: false } };
  const bot = { author: { __typename: 'Bot', login: 'copilot' } };
  const botCommit = { commit: { author: { email: '1+sabbasi3-factory-agent[bot]@users.noreply.github.com', user: null } } };
  const pr = (c, r, m) => ({ comments: { ...ok, nodes: c }, reviews: { ...ok, nodes: r }, commits: { ...ok, nodes: m } });
  assert.equal(zeroTouch(pr([bot], [bot], [botCommit])), true);
  assert.equal(zeroTouch(pr([{ author: { __typename: 'User', login: 'sabbasi3' } }], [], [botCommit])), false);
  assert.equal(zeroTouch(pr([], [], [{ commit: { author: { email: 'me@example.com', user: { login: 'sabbasi3' } } } }])), false);
  assert.equal(zeroTouch({ ...pr([], [], []), comments: { pageInfo: { hasNextPage: true }, nodes: [] } }), null);
});

test('prLanguage: task, v2 and external PR titles', () => {
  assert.equal(prLanguage('[factory] ar/constants: Port constants.ts'), 'ar');
  assert.equal(prLanguage('[factory] zh-hant/weekday-parser: Port'), 'zh-hant');
  assert.equal(prLanguage('[factory] it: port the it locale'), 'it');
  assert.equal(prLanguage('vi: port date parsers'), 'vi');
  assert.equal(prLanguage('README: status before 0.1.0'), null);
});

test('summarize: per-language work, hands-off and time; drills left out; cancelled tasks never shipped; shared core counted; reverts listed', () => {
  const langs = languages(paths);
  const issues = [
    { title: 'ar/a: Port A', state: 'closed', state_reason: 'completed', closed_at: '2026-11-07T09:00:00Z' },
    { title: 'ar/b: Port B', state: 'closed', state_reason: 'completed', closed_at: '2026-11-07T10:00:00Z' },
    // Cancelled after the last completed task: neither shipped nor the end of ar's time.
    { title: 'ar/c: Port C', state: 'closed', state_reason: 'not_planned', closed_at: '2026-11-08T10:00:00Z' },
    { title: 'en/x: Port X', state: 'open', created_at: '2026-10-20T00:00:00Z', closed_at: null },
    // A language whose only task was cancelled isn't shipped.
    { title: 'zh-hans/a: Port A', state: 'closed', state_reason: 'not_planned', created_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-02T00:00:00Z' },
    { title: 'common/overlap-removal-refiner: Port', state: 'closed', state_reason: 'completed', closed_at: '2026-10-21T00:00:00Z' },
    { title: 'common/cancelled: Port', state: 'closed', state_reason: 'not_planned', closed_at: '2026-10-21T00:00:00Z' },
    { title: 'drill/activation-canary: canary', state: 'closed', closed_at: '2026-11-01T01:00:00Z' },
  ];
  const merged = [
    { number: 456, title: 'onboard: ar (generated scaffold, golden cases and contracts)', head: 'factory/onboard/ar', merged_at: '2026-11-07T06:00:00Z' },
    { number: 536, title: 'it: onboarding oracle (generator output only)', head: 'sabbasi/it-oracle', merged_at: '2026-11-10T00:46:00Z' },
    { number: 553, title: '[factory] it: port the it locale', head: 'factory-v2/it-port-1', merged_at: '2026-11-10T02:22:00Z' },
    { number: 491, title: 'vi: onboarding oracle (generator output only)', head: 'sabbasi/vi-oracle', merged_at: '2026-11-09T22:03:00Z' },
    { number: 495, title: 'vi: port constants.ts', head: 'sabbasi/vi-constants', merged_at: '2026-11-09T22:18:00Z' },
    { number: 499, title: 'vi: port date parsers', head: 'sabbasi/vi-dates', merged_at: '2026-11-09T22:31:00Z' },
    { number: 125, title: '[factory] drill/post-merge: port FactoryDrillPostMerge', head: 'factory/drill-post-merge-1', merged_at: '2026-10-27T16:00:00Z' },
    { number: 130, title: 'Revert #129', head: 'factory/revert-129', merged_at: '2026-10-28T10:00:00Z' },
    { number: 126, title: 'Revert #125 (factory auto-revert)', head: 'factory/revert-125', created_at: '2026-10-27T16:10:00Z', merged_at: '2026-10-27T16:18:48Z' },
  ];
  const agentPrs = [
    { number: 1, title: '[factory] ar/a: Port A', zero_touch: true },
    { number: 2, title: '[factory] ar/b: Port B', zero_touch: false },
    { number: 553, title: '[factory] it: port the it locale', zero_touch: true },
    { number: 9, title: '[factory] drill/activation-canary: canary', zero_touch: true },
    { number: 10, title: '[factory] en/y: Port Y', zero_touch: null },
  ];
  const s = summarize({ langs, issues, merged, agentPrs });
  const row = (c) => s.rows.find((r) => r.code === c);
  assert.deepEqual(row('ar'), { code: 'ar', method: 'v1 (generated onboarding)', steps: 2, tasks: 3, tasks_done: 2, tasks_cancelled: 1, prs: 2, agent_prs: 2, hands_off: 1, hands_off_known: 2, finished: true, hours: 4 });
  assert.deepEqual([row('zh-hans').tasks_done, row('zh-hans').tasks_cancelled, row('zh-hans').finished, row('zh-hans').hours], [0, 1, false, null]);
  // en/y's zero-touch is unknown: in neither the hands-off count nor its known denominator.
  assert.deepEqual([row('en').finished, row('en').hours, row('en').agent_prs, row('en').hands_off, row('en').hands_off_known], [false, null, 1, 0, 0]);
  assert.deepEqual([row('it').prs, row('it').hands_off, row('it').hours, row('it').finished], [1, 1, 1.6, true]);
  // vi: from its oracle's merge (22:03) to its last port merge (22:31); not agent PRs.
  assert.deepEqual([row('vi').prs, row('vi').agent_prs, row('vi').hours], [2, 0, 0.5]);
  assert.deepEqual(s.totals, { languages: 5, finished: 3, tasks_done: 3, core_tasks_done: 1, agent_prs: 4, hands_off: 2, hands_off_known: 3, reverts: 1, drill_reverts: 1 });
  assert.deepEqual(s.reverts, [
    { number: 130, title: 'Revert #129', merged_at: '2026-10-28T10:00:00Z', drill: false },
    { number: 126, title: 'Revert #125 (factory auto-revert)', merged_at: '2026-10-27T16:18:48Z', drill: true },
  ]);
});

test('v1Spend: newest final run_spend per run, else its newest snapshot (no reservations); bounded at what it recorded', () => {
  const ev = (run_id, aic, extra = {}) => ({ type: 'run_spend', payload: { run_id, aic, dry_run: false, status: 'measured', ...extra } });
  const snapshot = (dry_run, runs) => ({ type: 'spend_snapshot', payload: { dry_run, runs } });
  const v1 = v1Spend([
    snapshot(false, [{ run_id: 1, status: 'reserved', aic: 2600 }, { run_id: 5, status: 'reserved', aic: 2600 }, { run_id: 6, status: 'measured', aic: 3 }]),
    ev(1, 10), ev(1, 12), ev(2, 30.4),
    ev(3, 99, { dry_run: true }),
    ev(4, 2600, { status: 'bounded', reason: 'usage_file_missing', readable_aic: 59.5, observed_aic: 46.5 }),
    ev(7, 2600, { status: 'bounded', reason: 'rerun' }),
    ev(8, 0, { status: 'no_inference' }),
    // Run 5 finished before run_spend existed: its newest snapshot counts; run 6's measurement too.
    snapshot(true, [{ run_id: 5, status: 'measured', aic: 20 }, { run_id: 9, status: 'bounded', aic: 2600, readable_aic: 1, observed_aic: 4 }]),
  ]);
  assert.deepEqual(v1, { runs: 7, aic: 12 + 30.4 + 59.5 + 0 + 20 + 3 + 4, measured_runs: 5, from_snapshots: 3, bounded_runs: 2, bounded_aic: 63.5, bounded_cap_aic: 5200, unknown: 1 });
});

test('v2RunUsage: every AI job that ran needs its usage; incomplete or malformed is unknown, never 0', () => {
  const line = (v, t) => JSON.stringify({ ai_credits_this_response: v, ...(t === undefined ? {} : { ai_credits_total: t }) });
  const files = { agent: `${line(100, 100)}\n${line(81, 181)}\n`, detection: line(11.5), evals: line(1.25) };
  assert.equal(v2RunUsage(files, ['agent', 'detection', 'evals']), 193.75);
  assert.equal(v2RunUsage({ agent: files.agent }, ['agent', 'detection']), null);
  assert.equal(v2RunUsage({ ...files, detection: '' }, ['agent', 'detection']), null);
  assert.equal(v2RunUsage({ agent: `${line(100, 100)}\n${line(81, 300)}` }, ['agent']), null);
  assert.equal(v2RunUsage({ agent: '{bad' }, ['agent']), null);
  assert.equal(v2RunUsage({ agent: line(-1) }, ['agent']), null);
});

test('cost: build sessions plus agent runs, bounded runs at what they recorded and caps beside them', () => {
  const v1 = { runs: 3, aic: 42.4, bounded_runs: 1, bounded_aic: 4, bounded_cap_aic: 2600, unknown: 1 };
  const build = JSON.parse(readFileSync(new URL('../build-cost.json', import.meta.url), 'utf8'));
  const c = cost(build, v1, { runs: 2, aic: 384.25, unknown: 1 });
  assert.equal(c.total_aic, Math.round(build.ai_units + 42.4 + 384.25));
  assert.deepEqual([c.v1_aic, c.v1_bounded_runs, c.v1_bounded_aic, c.v1_bounded_cap_aic, c.v1_unknown, c.v2_aic, c.v2_unknown, c.runs_aic], [42, 1, 4, 2600, 1, 384, 1, 427]);
});

test('build-cost.json: the breakdown adds up to the total, and no token counts without a source', () => {
  const build = JSON.parse(readFileSync(new URL('../build-cost.json', import.meta.url), 'utf8'));
  assert.equal(build.breakdown.reduce((n, b) => n + b.ai_units, 0), build.ai_units);
  assert.match(build.as_of, /^\d{4}-\d{2}-\d{2}$/);
  // Session usage checkpoints give AIC only: token and call counts stopped on 2026-10-30.
  assert.equal(build.tokens, undefined);
});

test('drills: the journal record and the canary (only live checks and failures count; dry and cancelled runs aside)', () => {
  const record = JSON.parse(readFileSync(new URL('../drills.json', import.meta.url), 'utf8'));
  const d = drills(record, [
    { conclusion: 'success', checked: true }, { conclusion: 'failure', checked: null }, { conclusion: 'cancelled', checked: null },
    { conclusion: 'success', checked: false }, { conclusion: 'success', checked: false }, { conclusion: 'success', checked: null },
  ]);
  assert.deepEqual([d.fire_drills_passed, d.fire_drills], [record.runs.filter((r) => r.result === 'pass').length, record.runs.length]);
  assert.deepEqual([d.canary_passed, d.canary_runs, d.canary_dry, d.canary_unknown], [1, 2, 2, 1]);
});

test('the page links CAO for operations and loads only same-origin data under a strict CSP', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /href="https:\/\/sabbasi3-factory-lab\.github\.io\/cao-control\/">CAO</);
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/);
  assert.doesNotMatch(readFileSync(new URL('../page.js', import.meta.url), 'utf8'), /innerHTML|https?:\/\/(?!github\.com)/);
});
