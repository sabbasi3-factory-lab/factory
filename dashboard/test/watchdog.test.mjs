import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '../lib.js';
import {
  LABEL, MARKER_STEP, MAX_AGE_MIN, TITLE, VERIFIER_MAX_AGE_MIN, combine, decide, decideVerifier, describe, main, newestHeartbeat, planIssueActions, readPreviousVerdict,
  readAudit, readVerifier, syncIssue,
} from '../watchdog.mjs';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const TODAY = 'audit/2026/10/16.jsonl';
const YESTERDAY = 'audit/2026/10/15.jsonl';
const SHA = 'c0ffee'.padEnd(40, '0');

const line = (type, timestamp, payload = {}) => canonicalize({
  version: 1, id: '00000000-0000-4000-8000-000000000000', type, timestamp, parents: [],
  payload: { dedupe_key: 'k', factory_version: 'v', dry_run: true, ...payload }, sha: 'sha256:' + '0'.repeat(64),
});
const minutesAgo = (min) => new Date(NOW - min * 60000).toISOString().slice(0, 19) + 'Z';
const ok = (path, ...lines) => ({ path, status: 'ok', text: lines.join('\n') + '\n' });
const audit = (...files) => ({ branch: 'ok', headSha: SHA, files });

// --- age decision ----------------------------------------------------------------

test('fresh up to 12 h, stale after; the newest heartbeat across both days wins', () => {
  assert.equal(MAX_AGE_MIN, 720);
  // NOW is 12:00Z, so 12 h ago is still today; the older one is yesterday.
  const at = (min) => decide(audit(ok(YESTERDAY, line('heartbeat', minutesAgo(900))), ok(TODAY, line('heartbeat', minutesAgo(min)))), NOW);
  assert.equal(at(5).status, 'fresh');
  assert.equal(at(5).alert, false);
  assert.equal(at(456).status, 'fresh', 'a 7.6 h gap (the longest measured) is not an alert');
  assert.equal(at(720).status, 'fresh');
  const stale = at(721);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.alert, true);
  assert.equal(stale.reason, 'heartbeat-too-old');
  assert.equal(Math.round(stale.ageMin), 721);
  assert.equal(stale.last.timestamp, minutesAgo(721));

  // Just after midnight UTC, yesterday's file holds the newest heartbeat.
  const early = Date.parse('2026-10-17T00:20:00Z');
  const d = decide(audit(ok('audit/2026/10/16.jsonl', line('heartbeat', '2026-10-16T23:00:04Z')), { path: 'audit/2026/10/17.jsonl', status: 'missing' }), early);
  assert.equal(d.status, 'fresh');
  assert.equal(d.last.path, 'audit/2026/10/16.jsonl');
});

test('missing branch, no heartbeat and empty days are stale', () => {
  const missing = decide({ branch: 'missing', files: [] }, NOW);
  assert.deepEqual([missing.status, missing.alert, missing.reason, missing.last], ['stale', true, 'audit-branch-missing', null]);

  const none = decide(audit(ok(YESTERDAY, line('pr_opened', minutesAgo(30), { pr: 1 })), ok(TODAY, line('merged', minutesAgo(10), { pr: 1 }))), NOW);
  assert.deepEqual([none.status, none.alert, none.reason, none.ageMin], ['stale', true, 'no-heartbeat', null]);

  const empty = decide(audit({ path: YESTERDAY, status: 'missing' }, { path: TODAY, status: 'missing' }), NOW);
  assert.deepEqual([empty.status, empty.reason], ['stale', 'no-heartbeat']);
});

test('fails closed: unreadable data is unknown and alerts; junk never counts as a heartbeat', () => {
  const branchErr = decide({ branch: 'error', detail: 'HTTP 502' }, NOW);
  assert.deepEqual([branchErr.status, branchErr.alert, branchErr.reason], ['unknown', true, 'audit-branch-unreadable']);
  assert.equal(decide(undefined, NOW).status, 'unknown');
  assert.equal(decide({ branch: 'ok', files: [] }, NOW).status, 'unknown');

  // Today's file is unreadable and yesterday's heartbeat is old: unknown, not stale-but-known.
  const fileErr = decide(audit(ok(YESTERDAY, line('heartbeat', minutesAgo(800))), { path: TODAY, status: 'error', detail: 'HTTP 502 after 3 attempts' }), NOW);
  assert.deepEqual([fileErr.status, fileErr.alert, fileErr.reason, fileErr.unreadable], ['unknown', true, 'audit-file-unreadable', [{ path: TODAY, detail: 'HTTP 502 after 3 attempts' }]]);
  assert.match(describe(fileErr), /Unreadable: `audit\/2026\/10\/16.jsonl` \(HTTP 502 after 3 attempts\)/);
  // ...but a recent heartbeat that was actually read proves liveness.
  assert.equal(decide(audit(ok(YESTERDAY, line('heartbeat', minutesAgo(30))), { path: TODAY, status: 'error' }), NOW).status, 'fresh');

  const junk = ok(TODAY,
    '{not json',
    line('heartbeat', 'yesterday-ish'),
    line('heartbeat', '2026-10-16T11:59:59.000Z'), // not second precision
    canonicalize({ type: 'heartbeat', timestamp: 1792152000, payload: {} }),
    line('heartbeat', minutesAgo(-60)), // an hour in the future
    line('heartbeat_extra', minutesAgo(1)),
  );
  assert.equal(newestHeartbeat([junk], NOW), null);
  assert.equal(decide(audit(junk), NOW).reason, 'no-heartbeat');
});

// --- reading GitHub ----------------------------------------------------------------

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        const r = typeof handler === 'function' ? handler(url, init) : handler;
        if (r instanceof Error) throw r;
        return new Response(r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

test('readAudit: branch 404 is missing, API errors are errors, files are pinned to the head SHA', async () => {
  assert.equal((await readAudit({ fetch: fakeFetch([]), now: NOW })).branch, 'missing');
  assert.deepEqual(await readAudit({ fetch: fakeFetch([['/branches/audit', { status: 502 }]]), now: NOW }), { branch: 'error', detail: 'HTTP 502' });
  assert.equal((await readAudit({ fetch: fakeFetch([['/branches/audit', new Error('offline')]]), now: NOW })).branch, 'error');
  assert.equal((await readAudit({ fetch: fakeFetch([['/branches/audit', { body: { commit: {} } }]]), now: NOW })).branch, 'error');

  const calls = [];
  const fetch = fakeFetch([
    ['/branches/audit', { body: { commit: { sha: SHA } } }],
    [`/${SHA}/${TODAY}`, { body: line('heartbeat', minutesAgo(20)) }],
    [`/${SHA}/${YESTERDAY}`, { status: 500 }],
  ], calls);
  const res = await readAudit({ fetch, now: NOW, token: 'test-token', retryDelayMs: 0 });
  assert.equal(res.headSha, SHA);
  assert.deepEqual(res.files.map((f) => [f.path, f.status, f.detail]), [[YESTERDAY, 'error', 'HTTP 500 after 3 attempts'], [TODAY, 'ok', undefined]]);
  const raw = calls.filter((c) => c.url.startsWith('https://raw.githubusercontent.com/'));
  assert.equal(raw.length, 4, 'the failing file is tried 3 times, the good one once');
  for (const c of raw) {
    assert.ok(c.url.includes(`/${SHA}/audit/`));
    assert.equal(c.headers.Authorization, undefined, 'token must not go to raw');
  }
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(decide(res, NOW).status, 'fresh');
});

// --- the alert issue ------------------------------------------------------------------

test('issue plan: open one, comment while it lasts, comment and close on recovery', () => {
  const stale = decide({ branch: 'missing', files: [] }, NOW);
  const fresh = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(3)))), NOW);

  const [create] = planIssueActions(stale, []);
  assert.equal(create.op, 'create');
  assert.equal(create.title, TITLE);
  assert.deepEqual(create.labels, [LABEL]);
  assert.match(create.body, /audit-branch-missing/);
  assert.match(create.body, /Last heartbeat: none found/);

  const tooOld = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(725)))), NOW);
  const comment = planIssueActions(tooOld, [{ number: 9 }, { number: 4 }, { number: 2, pull_request: {} }], 'https://example.test/run/1');
  assert.deepEqual(comment.map((a) => [a.op, a.number]), [['comment', 4]]);
  assert.match(comment[0].body, /Last heartbeat: 2026-10-15T23:55:00Z/);
  assert.match(comment[0].body, /Age: 12 h \(725 min\)/);
  assert.match(comment[0].body, /Watchdog run: https:\/\/example\.test\/run\/1/);

  assert.deepEqual(planIssueActions(fresh, [{ number: 4 }]).map((a) => [a.op, a.number]), [['comment', 4], ['close', 4]]);
  assert.deepEqual(planIssueActions(fresh, []), []);
});

test('syncIssue creates the label and issue once, then closes it when fresh', async () => {
  const calls = [];
  const issues = [];
  const fetch = fakeFetch([
    ['/issues?state=open', () => ({ body: issues.filter((i) => i.state === 'open') })],
    ['/labels/heartbeat-alert', { status: 404 }],
    ['/labels', { status: 201, body: {} }],
    ['/issues/7/comments', { status: 201, body: {} }],
    ['/issues/7', (url, init) => {
      issues[0].state = JSON.parse(init.body).state;
      return { body: issues[0] };
    }],
    ['/issues', (url, init) => {
      issues.push({ number: 7, state: 'open', ...JSON.parse(init.body) });
      return { status: 201, body: issues[0] };
    }],
  ], calls);
  const repo = 'example/factory';
  const stale = decide({ branch: 'missing', files: [] }, NOW);

  await syncIssue({ fetch, token: 't', repo, decision: stale });
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].labels, [LABEL]);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/labels')));

  const again = await syncIssue({ fetch, token: 't', repo, decision: stale });
  assert.deepEqual(again.map((a) => a.op), ['comment']);
  assert.equal(issues.length, 1);

  const fresh = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(3)))), NOW);
  const dry = await syncIssue({ fetch, token: 't', repo, decision: fresh, dryRun: true });
  assert.deepEqual(dry.map((a) => a.op), ['comment', 'close']);
  assert.equal(issues[0].state, 'open', 'dry run writes nothing');

  await syncIssue({ fetch, token: 't', repo, decision: fresh });
  assert.equal(issues[0].state, 'closed');
  assert.ok(calls.every((c) => c.url.startsWith(`https://api.github.com/repos/${repo}/`)));
});

test('main runs end to end in dry-run mode and needs GITHUB_REPOSITORY', async () => {
  await assert.rejects(() => main({}, fakeFetch([]), NOW), /GITHUB_REPOSITORY/);
  const fetch = fakeFetch([['/issues?state=open', { body: [] }]]);
  const { decision, actions } = await main({ GITHUB_REPOSITORY: 'example/factory', WATCHDOG_DRY_RUN: '1' }, fetch, NOW);
  assert.equal(decision.reason, 'audit-branch-missing');
  assert.deepEqual(actions.map((a) => a.op), ['create']);
});

// --- workflow hygiene ----------------------------------------------------------------

test('workflows default to no permissions and pin every action to a commit SHA', () => {
  for (const name of ['pages.yml', 'heartbeat-watchdog.yml']) {
    const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.match(text, /^permissions: \{\}$/m, `${name}: workflow-level permissions: {}`);
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${u}`);
  }
  const watchdog = readFileSync(new URL('../../.github/workflows/heartbeat-watchdog.yml', import.meta.url), 'utf8');
  // Job permissions: contents read, issues write, and actions read for the verifier's runs.
  const block = watchdog.match(/^ {4}permissions:\n((?: {6}[\w-]+: \w+(?: +#[^\n]*)?\n)+)/m);
  assert.ok(block, 'job-level permissions block');
  const perms = block[1].trim().split('\n').map((l) => l.replace(/#.*/, '').trim()).sort();
  assert.deepEqual(perms, ['actions: read', 'contents: read', 'issues: write']);
  assert.match(watchdog, /cron:/);
  assert.match(watchdog, /60 days/);
});

test('review #3: an incomplete heartbeat record, a future one or an impossible date never counts as fresh', () => {
  // Only type + timestamp: not a valid audit event.
  const bare = JSON.stringify({ type: 'heartbeat', timestamp: minutesAgo(5) });
  assert.equal(decide(audit(ok(TODAY, bare)), NOW).status, 'stale');
  // 4 minutes in the future: rejected (no skew allowance).
  assert.equal(decide(audit(ok(TODAY, line('heartbeat', '2026-10-16T12:04:00Z'))), NOW).status, 'stale');
  // Sep 31 normalises to Oct 1 in Date.parse: rejected by the exact round-trip.
  const oct2 = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(decide(audit(ok('audit/2026/10/01.jsonl', line('heartbeat', '2026-09-31T23:30:00Z'))), oct2).status, 'stale');
  // A valid one exactly at now is fresh.
  assert.equal(decide(audit(ok(TODAY, line('heartbeat', '2026-10-16T12:00:00Z'))), NOW).status, 'fresh');
});

// --- the independent verifier (audit-verify) ----------------------------------------------

const RUNS = '/actions/workflows/audit-verify.yml/runs?branch=main&status=success&per_page=1';
const run = (startedMinAgo, over = {}) => ({
  id: 9001, head_branch: 'main', status: 'completed', conclusion: 'success', run_started_at: minutesAgo(startedMinAgo),
  updated_at: minutesAgo(startedMinAgo - 2), html_url: 'https://github.com/example/factory/actions/runs/9001', ...over,
});
const verifierAt = (min) => decideVerifier({ workflow: 'ok', run: run(min) }, NOW);

test('verifier fresh: a success within 26 h, timed by run_started_at', () => {
  assert.equal(VERIFIER_MAX_AGE_MIN, 1560);
  const v = verifierAt(45);
  assert.deepEqual([v.status, v.alert, v.reason], ['fresh', false, 'verifier-fresh']);
  assert.equal(Math.round(v.ageMin), 45);
  assert.deepEqual(v.last, { id: 9001, startedAt: minutesAgo(45), url: 'https://github.com/example/factory/actions/runs/9001' });
  assert.equal(verifierAt(1560).status, 'fresh');
});

test('verifier stale: the newest success is more than 26 h old', () => {
  const v = verifierAt(1561);
  assert.deepEqual([v.status, v.alert, v.reason], ['stale', true, 'verifier-too-old']);
  // updated_at doesn't rescue an old run.
  assert.equal(decideVerifier({ workflow: 'ok', run: run(1600, { updated_at: minutesAgo(1) }) }, NOW).status, 'stale');
});

test('verifier never succeeded, 404 and API errors alert (fail closed)', () => {
  const never = decideVerifier({ workflow: 'ok', run: null }, NOW);
  assert.deepEqual([never.status, never.alert, never.reason], ['missing', true, 'verifier-never-succeeded']);
  const missing = decideVerifier({ workflow: 'missing' }, NOW);
  assert.deepEqual([missing.status, missing.alert, missing.reason], ['missing', true, 'verifier-workflow-missing']);
  const err = decideVerifier({ workflow: 'error', detail: 'HTTP 502' }, NOW);
  assert.deepEqual([err.status, err.alert, err.reason, err.detail], ['unknown', true, 'verifier-unreadable', 'HTTP 502']);
  assert.equal(decideVerifier(undefined, NOW).status, 'unknown');
  // A run that isn't a completed success, has no usable time, or starts in the future is unknown.
  for (const bad of [{ head_branch: 'feature' }, { head_branch: undefined }, { conclusion: 'failure' }, { status: 'in_progress' }, { run_started_at: null }, { run_started_at: '2026-10-16T11:00:00.000Z' }, { run_started_at: minutesAgo(-5) }, { id: '9001' }]) {
    const d = decideVerifier({ workflow: 'ok', run: run(30, bad) }, NOW);
    assert.deepEqual([d.status, d.alert], ['unknown', true], JSON.stringify(bad));
  }
});

test('readVerifier: newest successful run with the token; 404 is missing, API errors are errors', async () => {
  const repo = 'example/factory';
  assert.deepEqual(await readVerifier({ fetch: fakeFetch([]), repo }), { workflow: 'missing' });
  assert.deepEqual(await readVerifier({ fetch: fakeFetch([[RUNS, { status: 500 }]]), repo }), { workflow: 'error', detail: 'HTTP 500' });
  assert.equal((await readVerifier({ fetch: fakeFetch([[RUNS, new Error('offline')]]), repo })).workflow, 'error');
  assert.equal((await readVerifier({ fetch: fakeFetch([[RUNS, { body: { total_count: 0 } }]]), repo })).workflow, 'error');
  assert.deepEqual(await readVerifier({ fetch: fakeFetch([[RUNS, { body: { total_count: 0, workflow_runs: [] } }]]), repo }), { workflow: 'ok', run: null });

  const calls = [];
  const res = await readVerifier({ fetch: fakeFetch([[RUNS, { body: { total_count: 1, workflow_runs: [run(30)] } }]], calls), token: 'test-token', repo });
  assert.equal(res.run.id, 9001);
  assert.equal(calls[0].url, `https://api.github.com/repos/${repo}${RUNS}`);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(decideVerifier(res, NOW).status, 'fresh');
});

test('one issue lists every failing check, stays open while either fails, and closes only when both are healthy', async () => {
  const hbFresh = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(3)))), NOW);
  const hbStale = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(725)))), NOW);
  const vFresh = verifierAt(30);
  const vStale = verifierAt(1600);

  const both = combine(hbStale, vStale);
  assert.deepEqual([both.alert, both.failing], [true, ['heartbeat-too-old', 'verifier-too-old']]);
  const [create] = planIssueActions(both, [], 'https://example.test/run/1');
  assert.equal(create.op, 'create');
  assert.equal(create.title, 'Factory liveness alert');
  assert.deepEqual(create.labels, ['heartbeat-alert']);
  assert.match(create.body, /Failing: `heartbeat-too-old`, `verifier-too-old`/);
  assert.match(create.body, /#### Controller heartbeat\n- Status: \*\*stale\*\*/);
  assert.match(create.body, /#### Audit verifier \(`audit-verify\.yml`\)\n- Status: \*\*stale\*\*/);
  assert.match(create.body, /Last success: run \[9001\]\(https:\/\/github\.com\/example\/factory\/actions\/runs\/9001\)/);
  assert.match(create.body, /Watchdog run: https:\/\/example\.test\/run\/1/);

  // Only the verifier failing still alerts; the heartbeat section reads healthy.
  const onlyVerifier = planIssueActions(combine(hbFresh, decideVerifier({ workflow: 'missing' }, NOW)), []);
  assert.equal(onlyVerifier[0].op, 'create');
  assert.match(onlyVerifier[0].body, /Failing: `verifier-workflow-missing`\n/);
  assert.match(onlyVerifier[0].body, /- Status: \*\*fresh\*\* \(`heartbeat-fresh`\)/);

  // Stateful run: open once, comment while either fails, close only when both are healthy.
  const issues = [];
  const fetch = fakeFetch([
    ['/issues?state=open', () => ({ body: issues.filter((i) => i.state === 'open') })],
    ['/labels/heartbeat-alert', { body: {} }],
    ['/issues/7/comments', { status: 201, body: {} }],
    ['/issues/7', (url, init) => {
      issues[0].state = JSON.parse(init.body).state;
      return { body: issues[0] };
    }],
    ['/issues', (url, init) => {
      issues.push({ number: 7, state: 'open', ...JSON.parse(init.body) });
      return { status: 201, body: issues[0] };
    }],
  ]);
  const sync = (hb, v) => syncIssue({ fetch, token: 't', repo: 'example/factory', decision: combine(hb, v) });
  assert.deepEqual((await sync(hbStale, vFresh)).map((a) => a.op), ['create']);
  assert.deepEqual((await sync(hbFresh, vStale)).map((a) => a.op), ['comment'], 'heartbeat recovered, verifier still failing');
  assert.equal(issues[0].state, 'open');
  assert.deepEqual((await sync(hbStale, vFresh)).map((a) => a.op), ['comment'], 'verifier recovered, heartbeat failing');
  assert.equal(issues[0].state, 'open');
  const closing = await sync(hbFresh, vFresh);
  assert.deepEqual(closing.map((a) => a.op), ['comment', 'close']);
  assert.match(closing[0].body, /^Heartbeat and audit verifier both healthy again/);
  assert.equal(issues[0].state, 'closed');
  assert.equal(issues.length, 1);
});

test('main checks the heartbeat and the verifier, in dry-run mode without writing', async () => {
  const repo = 'example/factory';
  const routes = (verifierRoute) => [
    ['/branches/audit', { body: { commit: { sha: SHA } } }],
    [`/${SHA}/${TODAY}`, { body: line('heartbeat', minutesAgo(20)) }],
    [`/${SHA}/${YESTERDAY}`, { status: 404 }],
    ['/issues?state=open', { body: [{ number: 3, title: 'Controller heartbeat stale' }] }],
    ...(verifierRoute ? [[RUNS, verifierRoute]] : []),
  ];
  const env = { GITHUB_REPOSITORY: repo, WATCHDOG_DRY_RUN: '1' };
  const calls = [];
  const healthy = await main(env, fakeFetch(routes({ body: { workflow_runs: [run(50)] } }), calls), NOW);
  assert.deepEqual([healthy.decision.status, healthy.verifier.status, healthy.liveness.alert], ['fresh', 'fresh', false]);
  assert.deepEqual(healthy.actions.map((a) => [a.op, a.number]), [['comment', 3], ['close', 3]]);
  assert.ok(calls.every((c) => c.method === 'GET'), 'dry run writes nothing');

  const stale = await main(env, fakeFetch(routes({ body: { workflow_runs: [run(1700)] } })), NOW);
  assert.deepEqual([stale.verifier.reason, stale.liveness.alert], ['verifier-too-old', true]);
  assert.deepEqual(stale.actions.map((a) => [a.op, a.number]), [['comment', 3]], 'the existing issue is found by label, whatever its title');

  const apiError = await main(env, fakeFetch(routes({ status: 503 })), NOW);
  assert.deepEqual([apiError.verifier.reason, apiError.liveness.alert], ['verifier-unreadable', true]);
  const never = await main(env, fakeFetch(routes({ body: { workflow_runs: [] } })), NOW);
  assert.deepEqual([never.verifier.reason, never.liveness.alert], ['verifier-never-succeeded', true]);
  const notFound = await main(env, fakeFetch(routes(null)), NOW);
  assert.deepEqual([notFound.verifier.reason, notFound.liveness.alert], ['verifier-workflow-missing', true]);
});

// --- day rollover and transient errors (factory#8 opened at 2026-10-20T01:56Z) -------------

test('day rollover: today\'s file not written yet is normal; yesterday\'s heartbeat counts', () => {
  const early = Date.parse('2026-10-20T01:56:00Z');
  const y = 'audit/2026/10/19.jsonl';
  const t = 'audit/2026/10/20.jsonl';
  const d = decide(audit(ok(y, line('heartbeat', '2026-10-19T22:10:00Z')), { path: t, status: 'missing' }), early);
  assert.deepEqual([d.status, d.alert, d.last.path], ['fresh', false, y]);
});

test('a transient raw error is retried, so it doesn\'t hide yesterday\'s heartbeat', async () => {
  const early = Date.parse('2026-10-20T01:56:00Z');
  let tries = 0;
  const fetch = fakeFetch([
    ['/branches/audit', { body: { commit: { sha: SHA } } }],
    [`/${SHA}/audit/2026/10/19.jsonl`, () => (++tries < 3 ? { status: 503 } : { body: line('heartbeat', '2026-10-19T22:10:00Z') })],
    [`/${SHA}/audit/2026/10/20.jsonl`, { status: 404 }],
  ]);
  const res = await readAudit({ fetch, now: early, retryDelayMs: 0 });
  assert.equal(tries, 3);
  assert.equal(decide(res, early).status, 'fresh');
});

// --- two consecutive failing runs before an alert opens ----------------------------------

test('a new alert needs two failing runs in a row; an open alert keeps being updated', () => {
  const stale = decide({ branch: 'missing', files: [] }, NOW);
  assert.deepEqual(planIssueActions(stale, [], null, 'healthy').map((a) => a.op), ['pending'], 'first failing run after a healthy one: no issue yet');
  assert.deepEqual(planIssueActions(stale, [], null, 'failing').map((a) => a.op), ['create']);
  assert.deepEqual(planIssueActions(stale, [], null, 'unknown').map((a) => a.op), ['create'], 'an unknown previous verdict counts as failing (fail closed)');
  assert.deepEqual(planIssueActions(stale, [{ number: 5 }], null, 'healthy').map((a) => [a.op, a.number]), [['comment', 5]]);
  const fresh = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(3)))), NOW);
  assert.deepEqual(planIssueActions(fresh, [{ number: 5 }], null, 'failing').map((a) => a.op), ['comment', 'close'], 'closes on the first healthy run');
});

test('readPreviousVerdict: the marker step of the previous completed run on main', async () => {
  const repo = 'example/factory';
  const runsUrl = '/actions/workflows/heartbeat-watchdog.yml/runs?branch=main&status=completed&per_page=5';
  const jobs = (conclusion, jobConclusion = 'success') => ({ body: { jobs: [{ name: 'watchdog', conclusion: jobConclusion, steps: [{ name: 'Check the controller heartbeat', conclusion: jobConclusion === 'success' ? 'success' : 'failure' }, ...(conclusion ? [{ name: MARKER_STEP, conclusion }] : [])] }] } });
  const world = (marker, jobConclusion = 'success') => fakeFetch([
    [runsUrl, { body: { workflow_runs: [{ id: 77, run_attempt: 1 }, { id: 76, run_attempt: 2 }] } }],
    ['/actions/runs/77/attempts/1/jobs', jobs('success')],
    ['/actions/runs/76/attempts/2/jobs', jobs(marker, jobConclusion)],
  ]);
  assert.equal(await readPreviousVerdict({ fetch: world('skipped'), repo, currentRunId: 77 }), 'healthy', 'skips the current run');
  assert.equal(await readPreviousVerdict({ fetch: world('success'), repo, currentRunId: 77 }), 'failing');
  assert.equal(await readPreviousVerdict({ fetch: world('skipped'), repo }), 'failing', 'without a current id the newest run is the previous one');
  assert.equal(await readPreviousVerdict({ fetch: world(null), repo, currentRunId: 77 }), 'unknown', 'an older run without the marker step');
  // Review: a skipped marker in a job that failed or was cancelled (setup/checkout failed, the
  // issue sync threw before the verdict was written) proves nothing: unknown, i.e. failing.
  for (const jobConclusion of ['failure', 'cancelled', 'timed_out', null]) {
    assert.equal(await readPreviousVerdict({ fetch: world('skipped', jobConclusion), repo, currentRunId: 77 }), 'unknown', `job ${jobConclusion}`);
  }
  assert.equal(await readPreviousVerdict({ fetch: world('success', 'failure'), repo, currentRunId: 77 }), 'failing', 'a marker that ran still means failing');
  assert.equal(await readPreviousVerdict({ fetch: fakeFetch([[runsUrl, { status: 500 }]]), repo }), 'unknown');
  assert.equal(await readPreviousVerdict({ fetch: fakeFetch([[runsUrl, new Error('offline')]]), repo }), 'unknown');
  assert.equal(await readPreviousVerdict({ fetch: fakeFetch([[runsUrl, { body: { workflow_runs: [] } }]]), repo }), 'unknown');
});

test('the workflow\'s marker step matches MARKER_STEP and runs only when failing', () => {
  const wf = readFileSync(new URL('../../.github/workflows/heartbeat-watchdog.yml', import.meta.url), 'utf8');
  assert.ok(wf.includes(`- name: ${MARKER_STEP}\n        if: steps.watch.outputs.failing == 'true'`));
  assert.match(wf, /id: watch\n\s+run: node dashboard\/watchdog\.mjs/);
});

test('main writes failing=true|false for the marker step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'));
  const out = join(dir, 'out');
  writeFileSync(out, '');
  const env = { GITHUB_REPOSITORY: 'example/factory', WATCHDOG_DRY_RUN: '1', GITHUB_OUTPUT: out };
  const r = await main(env, fakeFetch([['/issues?state=open', { body: [] }]]), NOW);
  assert.equal(r.liveness.alert, true);
  assert.equal(readFileSync(out, 'utf8'), 'failing=true\n');
  rmSync(dir, { recursive: true, force: true });
});
