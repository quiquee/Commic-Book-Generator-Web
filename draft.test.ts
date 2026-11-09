import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEmptyDraft, parseDraft, type Draft } from './draft.ts';

const draft: Draft = { genre: 'High Fantasy', language: 'es-ES', premise: 'Un dragón', richMode: false, title: 'Dragón' };

test('parseDraft restores a saved draft and drops old or broken ones', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(parseDraft(JSON.stringify({ ...draft, savedAt: now - 1000 }), now), draft);
  assert.equal(parseDraft(JSON.stringify({ ...draft, savedAt: now - 8 * 24 * 3600 * 1000 }), now), null);
  assert.equal(parseDraft('not json', now), null);
  assert.equal(parseDraft(null, now), null);
  assert.equal(parseDraft(JSON.stringify({ ...draft }), now), null);
});

test('parseDraft sanitises unknown values', () => {
  const now = 5;
  const result = parseDraft(JSON.stringify({ genre: 'Nope', language: 'xx', premise: 7, richMode: 'x', title: 'x'.repeat(100), savedAt: now }), now);
  assert.deepEqual(result, { genre: 'Custom', language: '', premise: '', richMode: true, title: 'x'.repeat(60) });
});

test('an untouched form is not kept', () => {
  assert.ok(isEmptyDraft({ genre: 'Custom', language: 'es-ES', premise: ' ', richMode: true, title: '' }, 'es-ES'));
  assert.ok(!isEmptyDraft(draft, 'es-ES'));
});
