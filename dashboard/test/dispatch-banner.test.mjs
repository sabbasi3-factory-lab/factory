import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchBanner } from '../lib.js';

const NOW = Date.parse('2026-10-20T19:00:00Z');
let n = 0;
const ds = (timestamp, payload) => ({ type: 'dispatch_state', timestamp, id: `e${n++}`, payload: { ready: 0, in_flight: 0, spend_known: true, unreadable_runs: 0, dry_run: false, ...payload } });
const hb = (timestamp) => ({ type: 'heartbeat', timestamp, payload: {} });

test('dispatch banner: none without a dispatch_state event, or while running', () => {
  assert.equal(dispatchBanner([hb('2026-10-20T18:00:00Z')], { now: NOW }), null);
  assert.equal(dispatchBanner([ds('2026-10-20T17:00:00Z', { state: 'running', reason: 'none', in_flight: 1 })], { now: NOW }), null);
  assert.equal(dispatchBanner([ds('2026-10-20T17:00:00Z', { state: 'bogus' })], { now: NOW }), null);
});

test('dispatch banner: paused on unknown spend names the unreadable runs, and the count does not reset "since"', () => {
  const b = dispatchBanner([
    ds('2026-10-20T16:00:00Z', { state: 'running', reason: 'none' }),
    ds('2026-10-20T17:43:10Z', { state: 'paused', reason: 'budget_unknown', ready: 1, spend_known: false, unreadable_runs: 1 }),
    hb('2026-10-20T18:00:00Z'),
    ds('2026-10-20T18:30:00Z', { state: 'paused', reason: 'budget_unknown', ready: 1, spend_known: false, unreadable_runs: 2 }),
  ], { now: NOW });
  assert.equal(b.level, 'warn');
  assert.equal(b.since, '2026-10-20T17:43:10Z');
  assert.equal(b.text, 'Paused since 17:43Z: spend unknown, 2 unreadable runs');
  assert.match(b.tip, /2 runs of today unreadable/);
});

test('dispatch banner: each gate has its own words; an older day shows the date', () => {
  const text = (reason) => dispatchBanner([ds('2026-10-20T17:00:00Z', { state: 'paused', reason })], { now: NOW }).text;
  assert.equal(text('kill_switch'), 'Paused since 17:00Z: factory off (kill switch)');
  assert.equal(text('budget_pause'), 'Paused since 17:00Z: daily AI budget reached');
  assert.equal(text('actions_busy'), 'Paused since 17:00Z: Actions busy');
  assert.equal(text('busy_jobs_unknown'), 'Paused since 17:00Z: Actions load unknown');
  assert.equal(text('new_gate'), 'Paused since 17:00Z: unknown gate');
  assert.equal(dispatchBanner([ds('2026-10-19T23:10:00Z', { state: 'paused', reason: 'actions_busy' })], { now: NOW }).text,
    'Paused since 2026-10-19T23:10Z: Actions busy');
});

test('dispatch banner: waiting and idle are told apart from paused', () => {
  const w = dispatchBanner([ds('2026-10-20T17:00:00Z', { state: 'waiting', reason: 'limits', ready: 3, in_flight: 3 })], { now: NOW });
  assert.equal(w.level, 'info');
  assert.equal(w.text, 'Waiting since 17:00Z: 3 ready, held by limits');
  const i = dispatchBanner([ds('2026-10-20T17:00:00Z', { state: 'idle', reason: 'none' })], { now: NOW });
  assert.equal(i.text, 'Idle since 17:00Z: nothing ready');
  const iu = dispatchBanner([ds('2026-10-20T17:00:00Z', { state: 'idle', reason: 'none', spend_known: false, unreadable_runs: 1 })], { now: NOW });
  assert.equal(iu.text, 'Idle since 17:00Z: nothing ready; spend unknown');
  assert.match(iu.tip, /1 run of today unreadable/);
});

test('dispatch banner: a new state after a change starts a new "since"', () => {
  const b = dispatchBanner([
    ds('2026-10-20T10:00:00Z', { state: 'paused', reason: 'budget_unknown', spend_known: false }),
    ds('2026-10-20T12:00:00Z', { state: 'paused', reason: 'actions_busy' }),
    ds('2026-10-20T13:00:00Z', { state: 'paused', reason: 'budget_unknown', spend_known: false }),
  ], { now: NOW });
  assert.equal(b.since, '2026-10-20T13:00:00Z');
  assert.equal(b.text, 'Paused since 13:00Z: spend unknown');
});
