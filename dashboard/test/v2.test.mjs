import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEALTH_LABELS, canonicalize, combineNeedsYou, compactAge, verifierReason, verifierStatus, dayPaths, deriveMetrics, existingDayPaths,
  healthSummary, isHumanTierPr, parseContract, parseJsonl, parseTaskmap, prRef, reviewItems, shortTitle, stateLine, summarizePr, shortSha,
  taskBoard, taskCatalog,
} from '../lib.js';
import { FIXTURE_NOW, FIXTURE_PATH, QUIET_FIXTURE_NOW, QUIET_FIXTURE_PATH, QUIET_META_FIXTURE_PATH, buildQuietAnchorLines } from './make-fixture.mjs';

const at = (iso) => Date.parse(iso);
const fixture = () => parseJsonl(readFileSync(FIXTURE_PATH, 'utf8'), 'sample.jsonl').map((r) => r.event);
test('shortSha shows 7 characters of a full SHA and leaves other values alone', () => {
  assert.equal(shortSha('320c4fcedefc03648caa4cda140bd93932367986'), '320c4fc');
  assert.equal(shortSha('f4c1a9e'), 'f4c1a9e');
  assert.equal(shortSha('v1.2.3'), 'v1.2.3');
  assert.equal(shortSha(null), null);
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

// --- glance view (one health chip, compact numbers) ----------------------------------

test('health chip: Healthy only with fresh data, a verified chain and a heartbeat within 8 h', () => {
  const events = fixture();
  const lastHb = at('2026-10-16T11:00:03Z');
  const hbAt = (min) => deriveMetrics(events, { now: lastHb + min * 60000 }).heartbeat;
  const verified = { status: 'verified', total: 46 };
  const ok = { loaded: true, chain: verified, heartbeat: hbAt(12), dataAgeMin: 1 };
  const health = (over) => healthSummary({ ...ok, ...over });

  assert.deepEqual(health({}), { level: 'ok', label: 'Healthy', reasons: [] });
  assert.equal(health({ dataAgeMin: null }).level, 'ok', 'sample data has no age');

  // Dispatch held by a gate is never Healthy: Paused (amber) alone, Degraded with other warnings.
  const pausedSpend = { state: 'paused', reason: 'budget_unknown', text: 'Paused since 17:43Z: spend unknown' };
  assert.deepEqual(health({ dispatch: pausedSpend }), { level: 'warn', label: 'Paused', reasons: ['Paused since 17:43Z: spend unknown'] });
  assert.equal(health({ dispatch: pausedSpend, dataAgeMin: 60 }).label, 'Degraded');
  assert.ok(health({ dispatch: pausedSpend, dataAgeMin: 60 }).reasons.includes(pausedSpend.text));
  assert.equal(health({ dispatch: { state: 'paused', reason: 'kill_switch', text: 'x' } }).label, 'Healthy', 'factory off has its own chip');
  for (const st of ['waiting', 'idle']) assert.equal(health({ dispatch: { state: st, reason: 'none', text: 'x' } }).label, 'Healthy', st);

  // The heartbeat limits sit above the cadence GitHub's scheduler delivers: Healthy up to
  // exactly 8 h, Degraded after it and up to exactly 12 h, Down after that.
  assert.equal(health({ heartbeat: hbAt(75) }).level, 'ok', 'a 75-minute gap is normal');
  assert.equal(health({ heartbeat: hbAt(7.6 * 60) }).level, 'ok', 'the longest observed gap is still healthy');
  assert.equal(health({ heartbeat: hbAt(480) }).level, 'ok');
  assert.deepEqual(health({ heartbeat: hbAt(481) }), { level: 'warn', label: 'Degraded', reasons: ['Heartbeat late (8 h)'] });
  assert.deepEqual(health({ heartbeat: hbAt(720) }), { level: 'warn', label: 'Degraded', reasons: ['Heartbeat late (12 h)'] });
  assert.deepEqual(health({ heartbeat: hbAt(721) }), { level: 'alert', label: 'Down', reasons: ['Heartbeat stale (12 h)'] });

  // Degraded: late heartbeat, unknown heartbeat, stale data, failed refresh, unverified chain.
  assert.deepEqual(health({ heartbeat: hbAt(9 * 60) }), { level: 'warn', label: 'Degraded', reasons: ['Heartbeat late (9 h)'] });
  assert.equal(health({ heartbeat: null }).level, 'warn');
  assert.deepEqual(health({ dataAgeMin: 25 }).reasons, ['Data is 25 min old']);
  assert.equal(health({ dataAgeMin: 10 }).level, 'ok', 'up to 10 min old is fresh');
  assert.deepEqual(health({ error: 'GitHub API error (HTTP 502).' }).reasons, ['Last refresh failed: GitHub API error (HTTP 502).']);
  assert.equal(health({ error: 'x', dataAgeMin: 60 }).reasons.length, 1, 'a failed refresh explains the age');
  assert.equal(health({ chain: { status: 'empty' } }).level, 'warn');
  assert.equal(health({ chain: null }).level, 'warn');

  // Down: stale or missing heartbeat, broken chain, no log, nothing loaded because of an error.
  assert.deepEqual(health({ heartbeat: hbAt(13 * 60 + 5) }), { level: 'alert', label: 'Down', reasons: ['Heartbeat stale (13 h)'] });
  assert.equal(health({ heartbeat: deriveMetrics([], { now: lastHb }).heartbeat }).level, 'alert');
  assert.equal(health({ chain: { status: 'broken', brokenAt: 7 } }).reasons[0], 'Chain broken at event 7');
  assert.deepEqual(healthSummary({ loaded: true, noLog: true }), { level: 'alert', label: 'Down', reasons: ['No audit log yet'] });
  assert.equal(healthSummary({ loaded: false, error: 'offline' }).level, 'alert');

  // The worst condition wins, and reasons list worst first.
  const both = health({ heartbeat: hbAt(9 * 60), chain: { status: 'broken', brokenAt: 3 } });
  assert.equal(both.level, 'alert');
  assert.deepEqual(both.reasons, ['Chain broken at event 3', 'Heartbeat late (9 h)']);

  assert.deepEqual(Object.values(HEALTH_LABELS), ['Healthy', 'Degraded', 'Down', 'Loading', 'Paused']);
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

test('not loaded yet is neutral: the health chip and the state say Loading, never red', () => {
  // Before the first load there are no events, so the raw heartbeat level is "none" (an alert).
  const hb = deriveMetrics([], { now: at(FIXTURE_NOW) }).heartbeat;
  assert.equal(hb.level, 'none');
  assert.deepEqual(healthSummary({ loaded: false, heartbeat: hb, chain: null }), { level: 'loading', label: 'Loading', reasons: ['Loading the audit log'] });
  assert.deepEqual(stateLine({ loaded: false }), { text: 'Loading…', level: 'loading' });
  // Even a stale verifier doesn't turn the loading state red; a real failure does.
  const stale = { level: 'alert', reason: 'verifier-stale', ageMin: 30 * 60, count: 3 };
  assert.equal(healthSummary({ loaded: false, verifier: stale }).level, 'loading');
  assert.equal(healthSummary({ loaded: false, error: 'offline' }).level, 'alert');
  // After the load: real levels; the heartbeat turns amber after 8 h and red after 12 h.
  const m = deriveMetrics(fixture(), { now: at(FIXTURE_NOW) });
  assert.equal(m.heartbeat.level, 'ok');
  assert.equal(deriveMetrics(fixture(), { now: at(FIXTURE_NOW) + 8 * 60 * 60000 }).heartbeat.level, 'warn');
  assert.equal(deriveMetrics(fixture(), { now: at(FIXTURE_NOW) + 12 * 60 * 60000 }).heartbeat.level, 'alert');
});

test('health chip folds in the verifier: stale or unknown is Down, late or not set up is Degraded', () => {
  const NOW = at('2026-10-17T06:00:00Z');
  const line = (min, n = 41) => canonicalize({
    at: new Date(NOW - min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'), audit_head: 'a'.repeat(40), events: n,
    last_sha: 'sha256:' + 'e'.repeat(64), run_id: 7, source: 'sabbasi3-factory-lab/chrono-node-rs', v: 1,
  });
  const v = (fetched) => verifierStatus(fetched, NOW);
  const fresh = v({ status: 'ok', text: `${line(30, 40)}\n${line(23)}\n` });
  const okAt8h = v({ status: 'ok', text: `${line(480)}\n` });
  const lateV = v({ status: 'ok', text: `${line(481)}\n` });
  const lateAt26h = v({ status: 'ok', text: `${line(1560)}\n` });
  const staleAt26h = v({ status: 'ok', text: `${line(1561)}\n` });
  const staleV = v({ status: 'ok', text: `${line(27 * 60)}\n` });
  const missing = v({ status: 'missing' });
  const unreadable = v({ status: 'error', detail: 'HTTP 500' });
  const malformed = v({ status: 'ok', text: '{not json\n' });
  const future = v({ status: 'ok', text: `${line(-10)}\n` });
  const outOfOrder = v({ status: 'ok', text: `${line(20, 50)}\n${line(10, 40)}\n` });

  assert.equal(verifierReason(fresh), 'Verified 23m ago · 2 anchors');
  assert.equal(verifierReason(lateV), 'Verified 8h ago · 1 anchor');
  assert.equal(verifierReason(missing), 'Verifier not set up');
  assert.match(verifierReason(unreadable), /^Verifier unknown: couldn't read the anchors file: HTTP 500$/);
  assert.equal(verifierReason(v({ status: 'pending' })), 'Verifier: checking');

  const verifiedChain = { status: 'verified', total: 46 };
  const hb = deriveMetrics(fixture(), { now: at(FIXTURE_NOW) }).heartbeat;
  const health = (verifier) => healthSummary({ loaded: true, chain: verifiedChain, heartbeat: hb, dataAgeMin: 1, verifier });
  assert.deepEqual(health(fresh), { level: 'ok', label: 'Healthy', reasons: [] });
  // Healthy up to exactly 8 h, Degraded after it and up to exactly 26 h, Down after that.
  assert.deepEqual(health(v({ status: 'ok', text: `${line(150)}\n` })), { level: 'ok', label: 'Healthy', reasons: [] }, 'a 2.5 h gap is normal');
  assert.deepEqual(health(okAt8h), { level: 'ok', label: 'Healthy', reasons: [] });
  assert.deepEqual(health(lateV), { level: 'warn', label: 'Degraded', reasons: ['Verified 8h ago · 1 anchor'] });
  assert.deepEqual(health(lateAt26h), { level: 'warn', label: 'Degraded', reasons: ['Verified 26h ago · 1 anchor'] });
  assert.deepEqual(health(staleAt26h), { level: 'alert', label: 'Down', reasons: ['Verified 26h ago · 1 anchor'] });
  assert.deepEqual(health(missing), { level: 'warn', label: 'Degraded', reasons: ['Verifier not set up'] });
  for (const bad of [staleV, unreadable, malformed, future, outOfOrder]) {
    const r = health(bad);
    assert.equal(r.level, 'alert', JSON.stringify(bad));
    assert.equal(r.label, 'Down');
    assert.equal(r.reasons.length, 1);
  }
  assert.equal(health(staleV).reasons[0], 'Verified 27h ago · 1 anchor');
  assert.match(health(malformed).reasons[0], /^Verifier unknown: anchor line 1: invalid JSON$/);
  // Still being checked, or left out: no effect either way.
  assert.equal(health(v({ status: 'pending' })).level, 'ok');
  assert.equal(health(null).level, 'ok');
});

test('the quiet fixture reads as the quiet live page: Healthy, nothing needs you, factory off, dry run, verified', () => {
  const NOW = at(QUIET_FIXTURE_NOW);
  const records = parseJsonl(readFileSync(QUIET_FIXTURE_PATH, 'utf8'), 'quiet.jsonl');
  const events = records.map((r) => r.event);
  const m = deriveMetrics(events, { now: NOW });
  const v = verifierStatus({ status: 'ok', text: buildQuietAnchorLines().join('\n') + '\n' }, NOW);
  assert.deepEqual([v.level, v.count, verifierReason(v)], ['ok', 16, 'Verified 1h ago · 16 anchors']);
  assert.deepEqual(healthSummary({ loaded: true, chain: { status: 'verified' }, heartbeat: m.heartbeat, dataAgeMin: null, verifier: v }), { level: 'ok', label: 'Healthy', reasons: [] });
  assert.equal(m.heartbeat.level, 'ok');
  assert.equal(Math.round(m.heartbeat.ageMin), 12);
  assert.deepEqual(combineNeedsYou(m.needsYou.items, [], 'sabbasi3-factory-lab/chrono-node-rs'), []);
  assert.deepEqual([m.killSwitch.enabled, m.dryRun, m.running.available, m.running.rows.length], [false, true, false, 0]);
  // The board: the three quiet-week tasks are done (their merges are facts, even in dry run).
  const meta = JSON.parse(readFileSync(QUIET_META_FIXTURE_PATH, 'utf8'));
  const entries = parseTaskmap(meta.taskmap);
  const board = taskBoard(events, taskCatalog(entries, new Map(entries.map((e) => [e.id, parseContract(meta.contracts[e.id])]))), { needsItems: m.needsYou.items });
  assert.deepEqual(board.counts, { done: 3, running: 0, needs: 0, waiting: 0 });
  assert.deepEqual(stateLine({ board, dispatch: { state: 'paused', reason: 'kill_switch' } }), { text: 'Idle: all 3 tasks done', level: 'ok' });
});

