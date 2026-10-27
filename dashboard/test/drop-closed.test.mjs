import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropClosed } from '../lib.js';

// Shaped like deriveMetrics(): drill hand-offs whose issue or PR was closed long ago, plus live ones.
const metrics = () => ({
  needsYou: {
    count: 5,
    humanTierDerivable: false,
    items: [
      { key: 'task:drill/a', kind: 'needs_human', issue: 111, pr: null },
      { key: 'pr:125', kind: 'needs_human', issue: null, pr: 125 },
      { key: 'task:drill/b', kind: 'needs_human', issue: 114, pr: 122 },
      { key: 'task:common/x', kind: 'needs_human', issue: 28, pr: 143 },
      { key: 'task:en/y', kind: 'stale_contract', issue: null, pr: null },
    ],
  },
  running: {
    available: true,
    count: 3,
    wipLimit: 2,
    rows: [
      { key: 'drill/b#a1', task: 'drill/b', issue: 114, pr: 127 },
      { key: 'drill/c#a2', task: 'drill/c', issue: null, pr: 131 },
      { key: 'common/z#a1', task: 'common/z', issue: 32, pr: null },
    ],
  },
});

test('dropClosed: items and running rows with a closed issue or PR go; open and unnumbered ones stay', () => {
  const open = new Set([28, 143, 32]);
  const m = dropClosed(metrics(), open);
  assert.deepEqual(m.needsYou.items.map((i) => i.key), ['task:common/x', 'task:en/y']);
  assert.equal(m.needsYou.count, 2);
  assert.equal(m.needsYou.closedDropped, 3);
  assert.deepEqual(m.running.rows.map((r) => r.key), ['common/z#a1']);
  assert.equal(m.running.count, 1);
  assert.equal(m.running.closedDropped, 2);
  // An open issue with a closed PR still counts as closed (the PR it points at is gone).
  assert.deepEqual(dropClosed(metrics(), new Set([114, 28, 143, 32])).needsYou.items.map((i) => i.key), ['task:common/x', 'task:en/y']);
});

test('dropClosed: unknown current state changes nothing; the input is not mutated', () => {
  const m = metrics();
  assert.equal(dropClosed(m, null), m);
  assert.equal(dropClosed(m, undefined), m);
  dropClosed(m, new Set());
  assert.equal(m.needsYou.items.length, 5);
  assert.equal(m.running.rows.length, 3);
  // Unavailable run status keeps its null count.
  const u = metrics();
  u.running.count = null;
  assert.equal(dropClosed(u, new Set()).running.count, null);
});
