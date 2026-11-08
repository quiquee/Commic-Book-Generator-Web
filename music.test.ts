import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { MUSIC, moodFor, randomTrack } from './music.ts';
import { GENRES, TONES } from './types.ts';

test('every genre and tone maps to a mood with music', () => {
  for (const genre of GENRES) for (const tone of TONES) assert.ok(MUSIC[moodFor(genre, tone)]?.length, `${genre} / ${tone}`);
  assert.equal(moodFor('Classic Horror', TONES[0]), 'horror');
  assert.equal(moodFor('Custom', 'QUIPPY (humor)'), 'comedy');
});

test('every listed track exists as a file', () => {
  for (const [mood, names] of Object.entries(MUSIC)) for (const name of names) assert.ok(existsSync(`public/music/${mood}/${name}.mp3`), `${mood}/${name}`);
});

test('randomTrack stays in the mood and avoids repeating the last track', () => {
  for (let i = 0; i < 20; i++) assert.ok(randomTrack('noir').startsWith('/music/noir/'));
  const first = randomTrack('horror');
  for (let i = 0; i < 20; i++) assert.notEqual(randomTrack('horror', first), first);
  assert.ok(randomTrack(null).startsWith('/music/'));
});
