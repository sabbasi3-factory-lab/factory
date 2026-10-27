import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropClosed } from '../lib.js';

const AS_OF = Date.parse('2026-10-27T12:00:00Z');

// Shaped like deriveMetrics(): drill hand-offs whose issue or PR was closed long ago, plus live ones.
const metrics = () => ({
  needsYou: {
    count: 5,
    humanTierDerivable: false,
    items: [
      { key: 'task:drill/a', kind: 'needs_human', issue: 111, pr: null, since: '2026-10-27T10:00:00Z' },
      { key: 'pr:125', kind: 'needs_human', issue: null, pr: 125, since: '2026-10-27T10:00:00Z' },
      { key: 'task:drill/b', kind: 'needs_human', issue: 114, pr: 122, since: '2026-10-27T10:00:00Z' },
      { key: 'task:common/x', kind: 'needs_human', issue: 28, pr: 143, since: '2026-10-27T10:00:00Z' },
      { key: 'task:en/y', kind: 'stale_contract', issue: null, pr: null, since: '2026-10-27T10:00:00Z' },
    ],
  },
  running: {
    available: true,
    count: 3,
    wipLimit: 2,
    rows: [
      { key: 'drill/b#a1', task: 'drill/b', issue: 114, pr: 127, startedAt: Date.parse('2026-10-27T10:00:00Z') },
      { key: 'drill/c#a2', task: 'drill/c', issue: null, pr: 131, startedAt: Date.parse('2026-10-27T10:00:00Z') },
      { key: 'common/z#a1', task: 'common/z', issue: 32, pr: null, startedAt: Date.parse('2026-10-27T10:00:00Z') },
    ],
  },
});

test('dropClosed: items and running rows with a closed issue or PR go; open and unnumbered ones stay', () => {
  const open = new Set([28, 143, 32]);
  const m = dropClosed(metrics(), open, AS_OF);
  assert.deepEqual(m.needsYou.items.map((i) => i.key), ['task:common/x', 'task:en/y']);
  assert.equal(m.needsYou.count, 2);
  assert.equal(m.needsYou.closedDropped, 3);
  assert.deepEqual(m.running.rows.map((r) => r.key), ['common/z#a1']);
  assert.equal(m.running.count, 1);
  assert.equal(m.running.closedDropped, 2);
  // An open issue with a closed PR still counts as closed (the PR it points at is gone).
  assert.deepEqual(dropClosed(metrics(), new Set([114, 28, 143, 32]), AS_OF).needsYou.items.map((i) => i.key), ['task:common/x', 'task:en/y']);
});

test('dropClosed: unknown current state changes nothing; the input is not mutated', () => {
  const m = metrics();
  assert.equal(dropClosed(m, null), m);
  assert.equal(dropClosed(m, undefined), m);
  dropClosed(m, new Set(), AS_OF);
  // Without a snapshot time, nothing is dropped either.
  assert.equal(dropClosed(m, new Set()), m);
  assert.equal(m.needsYou.items.length, 5);
  assert.equal(m.running.rows.length, 3);
  // Unavailable run status keeps its null count.
  const u = metrics();
  u.running.count = null;
  assert.equal(dropClosed(u, new Set(), AS_OF).running.count, null);
});

test('dropClosed: items and runs newer than the open-list snapshot are kept (it may predate them)', () => {
  const m = metrics();
  m.needsYou.items.push({ key: 'task:new', kind: 'needs_human', issue: 150, pr: null, since: '2026-10-27T12:05:00Z' });
  m.running.rows.push({ key: 'new#a1', task: 'new', issue: 151, pr: null, startedAt: Date.parse('2026-10-27T12:05:00Z') });
  const out = dropClosed(m, new Set([28, 143, 32]), AS_OF);
  assert.ok(out.needsYou.items.some((i) => i.key === 'task:new'));
  assert.ok(out.running.rows.some((r) => r.key === 'new#a1'));
});
