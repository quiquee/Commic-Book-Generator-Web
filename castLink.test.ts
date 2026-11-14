import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCastLink, withoutCastLink } from './castLink.ts';

test('a link can name the hero and the co-star by photo address and name', () => {
    const search = `?hero=${encodeURIComponent('https://fotos.example/ana.jpg?talla=2&v=1')}&heroName=Ana%20Mar%C3%ADa&costar=https%3A%2F%2Ffotos.example%2Fluis.png&costarName=Luis`;
    assert.deepEqual(readCastLink(search), {
        hero: 'https://fotos.example/ana.jpg?talla=2&v=1', heroName: 'Ana María',
        costar: 'https://fotos.example/luis.png', costarName: 'Luis'
    });
    assert.deepEqual(readCastLink('?hero=%20https://fotos.example/ana.jpg%20'), { hero: 'https://fotos.example/ana.jpg', heroName: '', costar: '', costarName: '' });
    assert.deepEqual(readCastLink('?heroName=Ana'), { hero: '', heroName: 'Ana', costar: '', costarName: '' });
});

test('a link without a cast is not one, and a co-star name alone names no one', () => {
    assert.equal(readCastLink(''), null);
    assert.equal(readCastLink('?utm_source=mail'), null);
    assert.equal(readCastLink('?hero=&heroName=%20%20'), null);
    assert.equal(readCastLink('?costarName=Luis'), null);
    assert.equal(readCastLink('?heroName=Ana&costarName=Luis')?.costarName, '');
});

test('names are tidied and cut to eighty characters', () => {
    const link = readCastLink(`?heroName=${encodeURIComponent(`  Ana \n  María  ${'x'.repeat(100)}`)}`);
    assert.equal(link?.heroName.length, 80);
    assert.ok(link?.heroName.startsWith('Ana María x'));
});

test('the cast is taken out of the address and the rest stays', () => {
    assert.equal(withoutCastLink('?hero=https%3A%2F%2Ffotos.example%2Fa.jpg&heroName=Ana&costar=x&costarName=Luis'), '');
    assert.equal(withoutCastLink('?utm_source=mail&hero=x&lang=fr'), '?utm_source=mail&lang=fr');
    assert.equal(withoutCastLink(''), '');
});
