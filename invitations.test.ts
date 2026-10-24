import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationRequest, invitationUrl, normalizeBaseUrl } from './invitations.ts';
import { LANGUAGES } from './types.ts';

test('offers exactly the five requested languages with Spanish as the default', () => {
    assert.deepEqual(LANGUAGES.map(language => language.label), ['Español', 'Inglés', 'Francés', 'Gallego', 'Alemán']);
    assert.deepEqual(LANGUAGES.map(language => language.code), ['es-ES', 'en-US', 'fr-FR', 'gl-ES', 'de-DE']);
});

test('normalizes public base URLs without retaining query parameters or fragments', () => {
    assert.equal(normalizeBaseUrl(' https://comics.example.com/?old=1#previous '), 'https://comics.example.com');
    assert.equal(normalizeBaseUrl('http://192.168.1.10:3000'), 'http://192.168.1.10:3000');
    assert.equal(normalizeBaseUrl('https://example.com/comics/'), 'https://example.com/comics');
});

test('rejects invalid or unsafe base URLs and URLs too large for the QR code', () => {
    for (const url of ['', 'example.com', 'javascript:alert(1)', 'file:///tmp/app', 'https://user:password@example.com']) {
        assert.throws(() => normalizeBaseUrl(url));
    }
    assert.throws(() => normalizeBaseUrl(`https://example.com/${'x'.repeat(2000)}`), /2000/);
});

test('includes only guest credentials in the invitation fragment', () => {
    const link = new URL(invitationUrl('https://example.com', {
        id: 'invitation-id', guestToken: 'guest+token', ownerToken: 'private-owner-token'
    }));
    assert.equal(link.pathname, '/');
    assert.equal(link.search, '');
    assert.equal(new URLSearchParams(link.hash.slice(1)).get('join'), 'invitation-id');
    assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), 'guest+token');
    assert.ok(!link.href.includes('private-owner-token'));
});

test('sends invitation mutations with JSON and bearer authorization', async context => {
    const fetch = context.mock.method(globalThis, 'fetch', async (input, options) => {
        assert.equal(input, '/api/invitations/invitation-id/accept');
        assert.equal(options?.method, 'POST');
        assert.deepEqual(options?.headers, {
            'Content-Type': 'application/json', Authorization: 'Bearer owner-token'
        });
        assert.equal(options?.body, '{"responseId":"response-id"}');
        return Response.json({ id: 'response-id', status: 'accepted' });
    });
    assert.deepEqual(await invitationRequest('/invitation-id/accept', 'owner-token', { responseId: 'response-id' }), {
        id: 'response-id', status: 'accepted'
    });
    assert.equal(fetch.mock.callCount(), 1);
});

test('reports API authorization errors instead of returning a success-shaped value', async context => {
    context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Sin autorización.' }, { status: 401 }));
    await assert.rejects(invitationRequest('/id', 'wrong-token'), /Sin autorización/);
});

test('reports when a static-only frontend is used without the invitation server', async context => {
    context.mock.method(globalThis, 'fetch', async () => new Response('<html>SPA fallback</html>', {
        headers: { 'content-type': 'text/html' }
    }));
    await assert.rejects(invitationRequest('/id'), /servidor de invitaciones no está disponible/);
});
