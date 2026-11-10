import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cost, drills, languages, prLanguage, summarize, v1Spend, zeroTouch } from '../lib.mjs';

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

test('summarize: per-language work, hands-off and time; drills left out; reverts listed', () => {
  const langs = languages(paths).filter((l) => l.code !== 'zh-hans');
  const issues = [
    { title: 'ar/a: Port A', state: 'closed', closed_at: '2026-11-07T09:00:00Z' },
    { title: 'ar/b: Port B', state: 'closed', closed_at: '2026-11-07T10:00:00Z' },
    { title: 'en/x: Port X', state: 'open', created_at: '2026-10-20T00:00:00Z', closed_at: null },
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
  assert.deepEqual(row('ar'), { code: 'ar', method: 'v1 (generated onboarding)', steps: 2, tasks: 2, tasks_done: 2, prs: 2, agent_prs: 2, hands_off: 1, finished: true, hours: 4 });
  assert.deepEqual([row('en').finished, row('en').hours], [false, null]);
  assert.deepEqual([row('it').prs, row('it').hands_off, row('it').hours, row('it').finished], [1, 1, 1.6, true]);
  // vi: from its oracle's merge (22:03) to its last port merge (22:31); not agent PRs.
  assert.deepEqual([row('vi').prs, row('vi').agent_prs, row('vi').hours], [2, 0, 0.5]);
  assert.deepEqual(s.totals, { languages: 4, finished: 3, tasks_done: 2, agent_prs: 4, hands_off: 2, hands_off_known: 3, reverts: 1, drill_reverts: 1 });
  assert.deepEqual(s.reverts, [
    { number: 130, title: 'Revert #129', merged_at: '2026-10-28T10:00:00Z', drill: false },
    { number: 126, title: 'Revert #125 (factory auto-revert)', merged_at: '2026-10-27T16:18:48Z', drill: true },
  ]);
});

test('cost: build sessions plus measured runs (final run_spend per run; dry runs never count)', () => {
  const ev = (run_id, aic, dry_run = false) => ({ type: 'run_spend', payload: { run_id, aic, dry_run } });
  const v1 = v1Spend([ev(1, 10), ev(1, 12), ev(2, 30.4), ev(3, 99, true), { type: 'spend_snapshot', payload: { dry_run: false, runs: [{ run_id: 4, aic: 2600 }] } }]);
  assert.deepEqual(v1, { runs: 2, aic: 42.4 });
  const build = JSON.parse(readFileSync(new URL('../build-cost.json', import.meta.url), 'utf8'));
  const c = cost(build, v1, { runs: 2, aic: 384.25, unknown: 1 });
  assert.equal(c.total_aic, Math.round(build.ai_units + 42.4 + 384.25));
  assert.deepEqual([c.v1_aic, c.v2_aic, c.v2_unknown, c.runs_aic], [42, 384, 1, 427]);
});

test('drills: the journal record and the canary (cancelled runs aside)', () => {
  const record = JSON.parse(readFileSync(new URL('../drills.json', import.meta.url), 'utf8'));
  const d = drills(record, [{ conclusion: 'success' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]);
  assert.deepEqual([d.fire_drills_passed, d.fire_drills, d.canary_passed, d.canary_runs], [record.runs.filter((r) => r.result === 'pass').length, record.runs.length, 1, 2]);
});

test('the page links CAO for operations and loads only same-origin data under a strict CSP', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /href="https:\/\/sabbasi3-factory-lab\.github\.io\/cao-control\/">CAO</);
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'/);
  assert.doesNotMatch(readFileSync(new URL('../page.js', import.meta.url), 'utf8'), /innerHTML|https?:\/\/(?!github\.com)/);
});
