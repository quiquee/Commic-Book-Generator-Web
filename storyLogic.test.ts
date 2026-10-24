import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComicFace } from './types.ts';
import { isUnlocked, mergeFaces, nextPageToGenerate, pendingDecision, previousImage, isStoryFinished } from './storyLogic.ts';

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
