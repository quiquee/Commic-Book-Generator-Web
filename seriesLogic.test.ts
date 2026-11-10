import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupLibrary, seriesName, seriesPosition, type SeriesNode, type SeriesTree } from './seriesLogic.ts';

const node = (originId: string, issue: number, parentOriginId: string | null, extra: Partial<SeriesNode> = {}): SeriesNode => ({
    originId, parentOriginId, issue, storyId: originId, stories: [originId], title: `Serie #${issue}`, direction: '',
    completedPages: 12, totalPages: 12, updatedAt: issue, mine: false, ...extra,
});

test('the series is named after its first issue, without the number', () => {
    assert.equal(seriesName('Aquel misterio #3'), 'Aquel misterio');
    assert.equal(seriesName('Aquel misterio'), 'Aquel misterio');
    assert.equal(seriesName('Agente #7 vuelve'), 'Agente #7 vuelve');
});

test('a comic knows the issue before it, the ones after it and the pages of its branch', () => {
    const tree: SeriesTree = { id: 'a', title: 'Serie', nodes: [
        node('a', 1, null, { mine: true, stories: ['a', 'a-copy'] }),
        node('b', 2, 'a', { mine: true }),
        node('c', 3, 'b', { updatedAt: 5 }),
        node('d', 3, 'b', { mine: true, updatedAt: 9, completedPages: 4 }),
        node('e', 4, 'c'),
    ] };

    const second = seriesPosition(tree, 'b')!;
    assert.equal(second.previous?.originId, 'a');
    // The reader's own continuation comes first even though the other one is older and finished.
    assert.deepEqual(second.next.map(item => item.originId), ['d', 'c']);
    assert.deepEqual(second.path.map(item => item.originId), ['a', 'b', 'd']);
    assert.deepEqual([second.index, second.pagesBefore, second.pagesTotal], [1, 12, 28]);
    assert.deepEqual(second.versions.map(item => item.originId), ['b']);

    // Reading the other #3 follows its own branch, and offers the reader's #3 as another version.
    const other = seriesPosition(tree, 'c')!;
    assert.deepEqual(other.path.map(item => item.originId), ['a', 'b', 'c', 'e']);
    assert.deepEqual(other.versions.map(item => item.originId), ['c', 'd']);
    assert.deepEqual([other.pagesBefore, other.pagesTotal], [24, 48]);

    // A copy is the same issue as its original; the keys the reader holds decide what is theirs.
    const copy = seriesPosition(tree, 'a-copy', item => item.originId === 'c')!;
    assert.equal(copy.node.originId, 'a');
    assert.equal(copy.previous, null);
    assert.deepEqual(copy.path.map(item => item.originId), ['a', 'b', 'c', 'e']);
    assert.equal(seriesPosition(tree, 'nope'), null);
});

test('a series whose first issue is gone still reads from the issue that is left', () => {
    const tree: SeriesTree = { id: 'gone', title: 'Serie', nodes: [node('b', 2, 'gone'), node('c', 3, 'b')] };
    const position = seriesPosition(tree, 'c')!;
    assert.deepEqual(position.path.map(item => item.originId), ['b', 'c']);
    assert.equal(position.previous?.originId, 'b');
    assert.equal(seriesPosition(tree, 'b')!.previous, null);
});

test('the library shows one entry per series with its issues and pages', () => {
    const comic = (id: string, title: string, issue: number, seriesId: string, completedPages = 12, updatedAt = issue) =>
        ({ id, title, completedPages, totalPages: 12, updatedAt, series: { id: seriesId, issue } });
    const groups = groupLibrary([
        comic('b', 'Lucía #2', 2, 'a'),
        comic('x', 'Sola', 1, 'x', 5, 50),
        comic('a', 'Lucía', 1, 'a'),
        comic('c', 'Lucía #3', 3, 'a', 7, 40),
        comic('c2', 'Lucía #3 otra', 3, 'a', 12, 30),
        { id: 'old', title: 'Sin serie #9', completedPages: 12, totalPages: 12, updatedAt: 1 },
    ]);
    assert.deepEqual(groups.map(group => [group.id, group.name, group.issues, group.pages, group.updatedAt, group.last.id]), [
        ['a', 'Lucía', 3, 43, 40, 'c'],
        ['x', 'Sola', 1, 5, 50, 'x'],
        ['old', 'Sin serie', 1, 12, 1, 'old'],
    ]);
    assert.deepEqual(groups[0].comics.map(item => item.id), ['a', 'b', 'c2', 'c']);
});
