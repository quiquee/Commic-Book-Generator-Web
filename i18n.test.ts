import assert from 'node:assert/strict';
import { test } from 'node:test';
import { es } from './locales/es.ts';
import { en } from './locales/en.ts';
import { fr } from './locales/fr.ts';
import { de } from './locales/de.ts';
import { gl } from './locales/gl.ts';
import { translateServerText } from './locales/serverText.ts';
import { locale, t } from './i18n.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');

test('every catalog has the Spanish keys with the same placeholders', () => {
    for (const [name, catalog] of Object.entries({ en, fr, de, gl })) {
        assert.deepEqual(Object.keys(catalog).sort(), Object.keys(es).sort(), name);
        for (const [key, text] of Object.entries(es)) {
            assert.equal(placeholders(catalog[key as keyof typeof es]), placeholders(text), `${name} ${key}`);
            assert.ok(catalog[key as keyof typeof es].trim(), `${name} ${key} is empty`);
        }
    }
});

test('outside a browser the source language is used and placeholders are filled', () => {
    assert.equal(locale, 'es');
    assert.equal(t('launch.waitingFor', { name: 'LUIS' }), 'ESPERANDO A LUIS...');
    assert.equal(t('library.pages', { done: 3 }), '3/{total} páginas');
});

test('server messages are translated exactly, by pattern, or left as they are', () => {
    assert.equal(translateServerText('Historia no encontrada.', 'en'), 'Comic not found.');
    assert.equal(translateServerText('Historia no encontrada.', 'es'), 'Historia no encontrada.');
    assert.equal(translateServerText('Luis todavía no se ha unido a la invitación.', 'fr'), 'Luis n’a pas encore rejoint l’invitation.');
    assert.equal(translateServerText('El campo hero.desc no es válido.', 'de'), 'Das Feld hero.desc ist ungültig.');
    assert.equal(translateServerText('presupuesto diario agotado.', 'gl'), 'Esgotouse o orzamento diario.');
    assert.equal(translateServerText('Fallo desconocido', 'en'), 'Fallo desconocido');
});
