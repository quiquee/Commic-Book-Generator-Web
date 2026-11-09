import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerAlias } from './alias.ts';

test('the alias is stable per token and differs between tokens', () => {
  assert.equal(ownerAlias('abc'), ownerAlias('abc'));
  assert.match(ownerAlias('abc'), /^\S+ \S+ \d{1,2}$/);
  const names = new Set(Array.from({ length: 200 }, (_, index) => ownerAlias(`token-${index}`)));
  assert.ok(names.size > 150);
});
