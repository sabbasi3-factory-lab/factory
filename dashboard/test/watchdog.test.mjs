import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize } from '../lib.js';
import {
  LABEL, MAX_AGE_MIN, TITLE, decide, main, newestHeartbeat, planIssueActions, readAudit, syncIssue,
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

test('fresh up to 2 h, stale after; the newest heartbeat across both days wins', () => {
  assert.equal(MAX_AGE_MIN, 120);
  const at = (min) => decide(audit(ok(YESTERDAY, line('heartbeat', minutesAgo(600))), ok(TODAY, line('heartbeat', minutesAgo(min)))), NOW);
  assert.equal(at(5).status, 'fresh');
  assert.equal(at(5).alert, false);
  assert.equal(at(120).status, 'fresh');
  const stale = at(121);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.alert, true);
  assert.equal(stale.reason, 'heartbeat-too-old');
  assert.equal(Math.round(stale.ageMin), 121);
  assert.equal(stale.last.timestamp, minutesAgo(121));

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
  const fileErr = decide(audit(ok(YESTERDAY, line('heartbeat', minutesAgo(700))), { path: TODAY, status: 'error' }), NOW);
  assert.deepEqual([fileErr.status, fileErr.alert, fileErr.reason, fileErr.unreadable], ['unknown', true, 'audit-file-unreadable', [TODAY]]);
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
  const res = await readAudit({ fetch, now: NOW, token: 'test-token' });
  assert.equal(res.headSha, SHA);
  assert.deepEqual(res.files.map((f) => [f.path, f.status]), [[YESTERDAY, 'error'], [TODAY, 'ok']]);
  const raw = calls.filter((c) => c.url.startsWith('https://raw.githubusercontent.com/'));
  assert.equal(raw.length, 2);
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

  const tooOld = decide(audit(ok(TODAY, line('heartbeat', minutesAgo(185)))), NOW);
  const comment = planIssueActions(tooOld, [{ number: 9 }, { number: 4 }, { number: 2, pull_request: {} }], 'https://example.test/run/1');
  assert.deepEqual(comment.map((a) => [a.op, a.number]), [['comment', 4]]);
  assert.match(comment[0].body, /Last heartbeat: 2026-10-16T08:55:00Z/);
  assert.match(comment[0].body, /Age: 3 h \(185 min\)/);
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
  assert.match(watchdog, /permissions:\n\s+contents: read\n\s+issues: write\n/);
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
