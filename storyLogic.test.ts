import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComicFace } from './types.ts';
import { isUnlocked, cleanSoundEffects, mergeFaces, nextPageToGenerate, pendingDecision, previousImage, isStoryFinished, mustChangeScene, sceneRun, sceneStartImage } from './storyLogic.ts';

const done = (pageIndex: number, extra: Partial<ComicFace> = {}): ComicFace => ({
    id: pageIndex === 0 ? 'cover' : `page-${pageIndex}`,
    type: pageIndex === 0 ? 'cover' : pageIndex === 11 ? 'back_cover' : 'story',
    pageIndex, isLoading: false, imageUrl: `data:image/jpeg;base64,${pageIndex}`, choices: [], ...extra
});

test('generates the cover first, then pages in order', () => {
    assert.equal(nextPageToGenerate([]), 0);
    assert.equal(nextPageToGenerate([done(0)]), 1);
    assert.equal(nextPageToGenerate([done(0), done(1), { ...done(2), isLoading: true, imageUrl: undefined }]), 2);
});

test('pages after a decision wait until that decision is resolved', () => {
    const faces = [done(0), done(1), done(2), done(3, { isDecisionPage: true, choices: ['A', 'B'] })];
    assert.equal(isUnlocked(3, faces), true);
    assert.equal(isUnlocked(4, faces), false);
    assert.equal(nextPageToGenerate(faces), null);
    assert.equal(pendingDecision(faces)?.id, 'page-3');
    const resolved = [...faces.slice(0, 3), { ...faces[3], resolvedChoice: 'A' }];
    assert.equal(nextPageToGenerate(resolved), 4);
    assert.equal(pendingDecision(resolved), null);
});

test('reports completion only when every page including the back cover has an image', () => {
    const all = Array.from({ length: 12 }, (_, index) => done(index, index === 3 ? { isDecisionPage: true, resolvedChoice: 'A' } : {}));
    assert.equal(isStoryFinished(all), true);
    assert.equal(nextPageToGenerate(all), null);
    assert.equal(isStoryFinished(all.slice(0, 11)), false);
});

test('uses the most recent finished page as the visual reference', () => {
    const faces = [done(0), done(1), { ...done(2), imageUrl: undefined, isLoading: true }];
    assert.equal(previousImage(faces, 3), 'data:image/jpeg;base64,1');
    assert.equal(previousImage(faces, 1), 'data:image/jpeg;base64,0');
    assert.equal(previousImage([], 0), null);
});

test('owner merge keeps local page content but adopts remote decisions', () => {
    const local = [done(3, { isDecisionPage: true, choices: ['A', 'B'] })];
    const remote: ComicFace[] = [{ ...local[0], imageUrl: 'stale', resolvedChoice: 'B', version: 7 }, done(4)];
    const merged = mergeFaces(local, remote, 'owner');
    assert.equal(merged.length, 2);
    assert.equal(merged[0].imageUrl, 'data:image/jpeg;base64,3');
    assert.equal(merged[0].resolvedChoice, 'B');
    assert.equal(merged[0].version, 7);
    const guestMerged = mergeFaces(local, remote, 'guest');
    assert.equal(guestMerged[0].imageUrl, 'stale');
});

const storyFace = (pageIndex: number, new_scene?: boolean): ComicFace => ({
    id: `page-${pageIndex}`, type: 'story', pageIndex, isLoading: false, choices: [],
    narrative: { scene: 's', choices: [], focus_char: 'hero', ...(new_scene === undefined ? {} : { new_scene }) }
});

test('a location lasts at most three pages and an issue starts in a new one', () => {
    assert.equal(mustChangeScene([], 1), true);
    assert.equal(mustChangeScene([storyFace(1, true)], 2), false);
    assert.equal(sceneRun([storyFace(1, true), storyFace(2, false)], 3), 2);
    assert.equal(mustChangeScene([storyFace(1, true), storyFace(2, false)], 3), false);
    assert.equal(mustChangeScene([storyFace(1, true), storyFace(2, false), storyFace(3, false)], 4), true);
    assert.equal(mustChangeScene([storyFace(1, true), storyFace(2, false), storyFace(3, false), storyFace(4, true)], 5), false);
});

test('the first image of a location is passed along only once the scene has lasted two pages', () => {
    const withImage = (face: ComicFace, imageUrl: string): ComicFace => ({ ...face, imageUrl });
    const one = withImage(storyFace(1, true), 'one');
    const two = withImage(storyFace(2, false), 'two');
    assert.equal(sceneStartImage([one], 2), null);
    assert.equal(sceneStartImage([one, two], 3), 'one');
    assert.equal(sceneStartImage([withImage(storyFace(1, true), 'a'), withImage(storyFace(2, true), 'b'), withImage(storyFace(3, false), 'c')], 4), 'b');
});

test('pages made before scenes were tracked each count as their own scene', () => {
    assert.equal(sceneRun([storyFace(1), storyFace(2)], 3), 1);
    assert.equal(mustChangeScene([storyFace(1), storyFace(2)], 3), false);
});

test('cleanSoundEffects drops stock and repeated words and caps the list', () => {
  const result = cleanSoundEffects(['¡GLUP!', '¡BROT!', '¡brot!', ' ¡FSSS! ', '', 5, '¡CATAPLÚM!']);
  assert.deepEqual(result, ['¡BROT!', '¡FSSS!']);
  assert.equal(cleanSoundEffects(Array.from({ length: 30 }, (_, i) => `¡X${i}!`)).length, 12);
  assert.deepEqual(cleanSoundEffects('¡A!|¡B!'), ['¡A!', '¡B!']);
});
