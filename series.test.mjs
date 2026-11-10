import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSeries, planSeries, seriesEntry, seriesReport, validSeries } from './series.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const face = (image) => ({ id: 'cover', imageUrl: image, isLoading: false });
// An old record: no series data, only the continuation link and its pages.
const old = (n, { from, issue, cover = `cover-${n}`, createdAt = n } = {}) => seriesEntry({
  id: uuid(n), title: `Comic ${n}`, ownerToken: `token-${n}`, createdAt, updatedAt: createdAt,
  faces: cover ? [face(cover)] : [],
  ...(from ? { continuation: { fromId: uuid(from), issue, recap: 'r', direction: 'd' } } : {}),
});

test('validSeries accepts only complete series data', () => {
  assert.equal(validSeries({ id: uuid(1), issue: 1, originId: uuid(1), parentOriginId: null }), true);
  assert.equal(validSeries({ id: uuid(1), issue: 2, originId: uuid(2), parentOriginId: uuid(1) }), true);
  for (const bad of [undefined, null, {}, { id: uuid(1), issue: 0, originId: uuid(1), parentOriginId: null },
    { id: uuid(1), issue: 1, originId: 'x', parentOriginId: null }, { id: uuid(1), issue: 1, originId: uuid(1) }]) {
    assert.equal(validSeries(bad), false);
  }
});

test('old comics are chained by their continuation link', () => {
  const plan = planSeries([old(3, { from: 2, issue: 3 }), old(1), old(2, { from: 1, issue: 2 }), old(9)]);
  assert.deepEqual(plan.get(uuid(1)), { id: uuid(1), issue: 1, originId: uuid(1), parentOriginId: null });
  assert.deepEqual(plan.get(uuid(2)), { id: uuid(1), issue: 2, originId: uuid(2), parentOriginId: uuid(1) });
  assert.deepEqual(plan.get(uuid(3)), { id: uuid(1), issue: 3, originId: uuid(3), parentOriginId: uuid(2) });
  assert.deepEqual(plan.get(uuid(9)), { id: uuid(9), issue: 1, originId: uuid(9), parentOriginId: null });
});

test('an old copy has the cover of its original and takes its place in the tree', () => {
  // 4 is a copy of 2 (it kept the link to 1); 5 continues the copy: an alternative #3 next to 3.
  const entries = [old(1), old(2, { from: 1, issue: 2 }), old(3, { from: 2, issue: 3 }),
    old(4, { from: 1, issue: 2, cover: 'cover-2' }), old(5, { from: 4, issue: 3 })];
  const plan = planSeries(entries);
  assert.deepEqual(plan.get(uuid(4)), plan.get(uuid(2)));
  assert.deepEqual(plan.get(uuid(5)), { id: uuid(1), issue: 3, originId: uuid(5), parentOriginId: uuid(2) });
  const [series] = groupSeries(entries, plan);
  assert.deepEqual([series.issues, series.comics, series.nodes.length], [3, 5, 4]);
  assert.deepEqual(series.nodes.map((node) => [node.issue, node.depth, node.comics.map((entry) => entry.id.slice(-1)).join('')]),
    [[1, 0, '1'], [2, 1, '24'], [3, 2, '3'], [3, 2, '5']]);
});

test('stored series data wins, and comics without a cover are never taken for copies', () => {
  const stored = seriesEntry({ id: uuid(7), title: 'Stored', ownerToken: 't', createdAt: 7, faces: [face('cover-7')],
    series: { id: uuid(1), issue: 2, originId: uuid(6), parentOriginId: uuid(1) } });
  const plan = planSeries([stored, old(8, { cover: 'cover-7' }), old(10, { cover: null }), old(11, { cover: null }), old(12, { from: 7, issue: 3 })]);
  assert.deepEqual(plan.get(uuid(7)), { id: uuid(1), issue: 2, originId: uuid(6), parentOriginId: uuid(1) });
  // An old copy of a migrated comic joins it.
  assert.deepEqual(plan.get(uuid(8)), plan.get(uuid(7)));
  assert.equal(plan.get(uuid(10)).originId, uuid(10));
  assert.equal(plan.get(uuid(11)).originId, uuid(11));
  assert.deepEqual(plan.get(uuid(12)), { id: uuid(1), issue: 3, originId: uuid(12), parentOriginId: uuid(6) });
});

test('issues whose previous issue was deleted stay together and say so', () => {
  const entries = [old(3, { from: 2, issue: 3 }), old(4, { from: 2, issue: 3 }), old(5, { from: 5, issue: 2 })];
  const plan = planSeries(entries);
  assert.deepEqual(plan.get(uuid(3)), { id: uuid(2), issue: 3, originId: uuid(3), parentOriginId: uuid(2) });
  assert.equal(plan.get(uuid(4)).id, uuid(2));
  // A link to itself is ignored instead of looping.
  assert.deepEqual(plan.get(uuid(5)), { id: uuid(5), issue: 2, originId: uuid(5), parentOriginId: null });
  const groups = groupSeries(entries, plan);
  assert.equal(groups.length, 2);
  assert.ok(groups[0].nodes.every((node) => node.missingParent));
  const report = seriesReport(entries, { alias: (token) => `alias-${token}` });
  assert.match(report, /3 comics · 0 already carry series data · 3 would get it/);
  assert.match(report, /no longer exists/);
  assert.match(report, /alias-token-3/);
});
