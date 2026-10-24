import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTitle, isTitleTaken, normalizeTitle, pickUniqueTitle, titleSlug } from './titles.ts';

test('normalizes accents, case, punctuation and spacing before comparing titles', () => {
    assert.equal(normalizeTitle('  ¡La Sombra del Río!  '), 'la sombra del rio');
    assert.equal(isTitleTaken('la sombra del rio', ['La Sombra del Río']), true);
    assert.equal(isTitleTaken('La sombra del mar', ['La Sombra del Río']), false);
    assert.equal(isTitleTaken('', []), true);
});

test('cleans model output: quotes, markdown, newlines and length', () => {
    assert.equal(cleanTitle('"Noche de Neón"'), 'Noche de Neón');
    assert.equal(cleanTitle('**«Ecos del Puerto».**'), 'Ecos del Puerto');
    assert.equal(cleanTitle('Título\ncon salto'), 'Título con salto');
    assert.equal(cleanTitle('x'), '');
    assert.equal(cleanTitle(42), '');
    const long = cleanTitle('Palabra '.repeat(20));
    assert.ok(long.length <= 60 && !long.endsWith(' '));
});

test('picks the first unused candidate and numbers the title when all are taken', () => {
    assert.equal(pickUniqueTitle(['"Ecos"', 'Sombras', 'Faros'], ['ecos']), 'Sombras');
    assert.equal(pickUniqueTitle(['Ecos', 'Sombras'], ['Ecos', 'Sombras']), 'Ecos II');
    assert.equal(pickUniqueTitle(['Ecos'], ['Ecos', 'Ecos II']), 'Ecos III');
    assert.equal(pickUniqueTitle([], []), null);
    assert.equal(pickUniqueTitle(['', null, 7], []), null);
});

test('builds safe file-name slugs', () => {
    assert.equal(titleSlug('¡Noche de Neón: Año 2!'), 'noche-de-neon-ano-2');
    assert.equal(titleSlug('***'), 'comic');
});
