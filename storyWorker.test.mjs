import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import sharp from 'sharp';
import { createAppServer } from './server.mjs';

const PNG = (await sharp({ create: { width: 200, height: 300, channels: 3, background: '#3366cc' } }).png().toBuffer()).toString('base64');
const JPEG = (await sharp({ create: { width: 64, height: 64, channels: 3, background: '#cc3333' } }).jpeg().toBuffer()).toString('base64');

let dir;
let upstream;
let server;
let base;
let failing = false;
let blocked = false;
let calls = [];
let sent = [];

// A fake Gemini: JSON for the text model (style guide or page script), a PNG for the image model.
async function startUpstream() {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const prompt = JSON.stringify(body.contents);
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (blocked) {
      res.end(JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { totalTokenCount: 5 } }));
      return;
    }
    if (failing) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: 500, message: 'Fallo simulado', status: 'INTERNAL' } }));
      return;
    }
    const part = req.url.includes('nano-banana') ? { inlineData: { mimeType: 'image/png', data: PNG } }
      : { text: JSON.stringify(prompt.includes('art director')
        ? { hero_look: 'Red cape', costar_look: 'Blue scarf', world_style: 'Bold ink' }
        : { caption: 'Texto', scene: 'HERO walks', focus_char: 'hero', choices: ['Ir', 'Quedarse'] }) };
    res.end(JSON.stringify({ candidates: [{ content: { parts: [part] } }], usageMetadata: { totalTokenCount: 10 } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
}

async function startServer() {
  server = createAppServer({
    dataDir: join(dir, 'invitations'), storiesDir: join(dir, 'stories'), usageDir: join(dir, 'usage'),
    auditFile: join(dir, 'audit.log'), geminiLogFile: join(dir, 'gemini.log'), adminPassword: 'secret', pricingFile: join(dir, 'pricing.json'),
    geminiApiKey: 'TEST_KEY', geminiUpstream: `http://127.0.0.1:${upstream.address().port}`,
    generationRetryDelayMs: 5,
    pushService: { publicKey: async () => 'PUBLIC', send: async (subscription, payload) => { sent.push(payload); return 'sent'; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

const stopServer = () => new Promise((resolve) => server.close(resolve));

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: response.status, payload: response.status === 204 ? null : await response.json() };
}

async function until(read, check, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`Tiempo agotado esperando: ${label} (${JSON.stringify(value?.generation)})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const done = (story) => story.faces.filter((face) => face.imageUrl && !face.isLoading).map((face) => face.pageIndex);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'comic-worker-test-'));
  failing = false;
  blocked = false;
  calls = [];
  sent = [];
  await startUpstream();
  await startServer();
});

afterEach(async () => {
  if (server.listening) await stopServer();
  await new Promise((resolve) => upstream.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function createComic() {
  const created = await api('/api/stories', { method: 'POST', body: {
    title: 'Cómic de prueba', hostName: 'Ana', guestName: '', hero: { base64: JPEG, desc: 'Héroe' }, friend: null,
    settings: { genre: 'Custom', language: 'es-ES', premise: 'Una idea', richMode: true }, tone: 'QUIPPY', invitation: null,
  } });
  assert.equal(created.status, 201);
  return created.payload;
}

test('the server draws a comic on its own, waits for the decision and notifies once per event in the subscriber language', async () => {
  const { id, ownerToken } = await createComic();
  const read = async () => (await api(`/api/stories/${id}`, { token: ownerToken })).payload;
  const subscribed = await api(`/api/stories/${id}/subscriptions`, { method: 'POST', token: ownerToken, body: {
    subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }, url: `/#story=${id}`, lang: 'en',
  } });
  assert.equal(subscribed.status, 201);
  assert.equal((await api(`/api/stories/${id}/subscriptions`, { method: 'POST', token: ownerToken, body: {
    subscription: { endpoint: 'http://insecure.example', keys: { p256dh: 'p', auth: 'a' } }, url: '/#story=x',
  } })).status, 400);

  const waiting = await until(read, (story) => story.generation?.state === 'waiting', 'decisión pendiente');
  assert.deepEqual(done(waiting), [0, 1, 2, 3]);
  assert.ok(waiting.styleGuide.includes('Red cape'));
  const page = waiting.faces.find((face) => face.pageIndex === 3);
  assert.deepEqual(page.choices, ['Ir', 'Quedarse']);
  assert.match(page.imageUrl, /^data:image\/jpeg;base64,\/9j\//);
  assert.deepEqual(sent.map(({ body, url }) => ({ body, url })), [{
    body: 'A decision is waiting! Come in and choose how the story goes on.', url: `/#story=${id}`,
  }]);
  assert.equal('subscriptions' in waiting || 'notified' in waiting, false);

  // A page left half-done (as the old in-browser generator did) is redrawn after a restart, without a second notice.
  await stopServer();
  const file = join(dir, 'stories', `${id}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  const stuck = record.faces.find((face) => face.pageIndex === 2);
  delete stuck.imageUrl;
  stuck.isLoading = true;
  await writeFile(file, JSON.stringify(record));
  await startServer();
  const resumed = await until(read, (story) => done(story).includes(2) && story.generation?.state === 'waiting', 'reanudación');
  assert.deepEqual(done(resumed), [0, 1, 2, 3]);
  assert.equal(sent.length, 1);

  const choice = await api(`/api/stories/${id}/choices`, { method: 'POST', token: ownerToken, body: { faceId: 'page-3', choice: 'Ir' } });
  assert.equal(choice.status, 200);
  const finished = await until(read, (story) => story.generation?.state === 'finished', 'cómic completo');
  assert.equal(done(finished).length, 12);
  assert.equal(finished.faces.find((face) => face.pageIndex === 3).resolvedChoice, 'Ir');
  assert.deepEqual(sent.map((payload) => payload.body).at(-1), 'Your comic is finished! Tap to read it.');
  assert.equal(sent.length, 2);
});

test('after repeated failures generation stops, and only the owner can restart it', async () => {
  failing = true;
  const { id, ownerToken } = await createComic();
  const read = async () => (await api(`/api/stories/${id}`, { token: ownerToken })).payload;
  const stopped = await until(read, (story) => story.generation?.state === 'stopped', 'parada por errores');
  assert.equal(stopped.generation.reason, 'Fallo simulado');
  assert.equal(calls.length, 5);

  assert.equal((await api(`/api/stories/${id}/generate`, { method: 'POST' })).status, 401);
  failing = false;
  assert.equal((await api(`/api/stories/${id}/generate`, { method: 'POST', token: ownerToken })).status, 202);
  await until(read, (story) => story.generation?.state === 'waiting', 'reanudación manual');
});

test('refused content stops at once without retrying, is logged, and the owner can rewrite the instructions', async () => {
  blocked = true;
  const { id, ownerToken } = await createComic();
  const read = async () => (await api(`/api/stories/${id}`, { token: ownerToken })).payload;
  const stopped = await until(read, (story) => story.generation?.state === 'stopped', 'parada por contenido rechazado');
  assert.equal(calls.length, 1);
  assert.equal(stopped.generation.blocked, true);
  assert.match(stopped.generation.reason, /rechazado el contenido/);

  const log = (await readFile(join(dir, 'gemini.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(log.length, 1);
  assert.equal(log[0].blockReason, 'PROHIBITED_CONTENT');
  assert.equal(log[0].ok, false);
  assert.equal(log[0].scopeId, id);
  assert.match(log[0].prompt.text, /Una idea/);
  assert.ok(!JSON.stringify(log[0]).includes('TEST_KEY'));

  const login = await fetch(`${base}/api/admin/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-request': '1' }, body: JSON.stringify({ password: 'secret' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const shown = await (await fetch(`${base}/api/admin/gemini-log?failed=1`, { headers: { cookie } })).json();
  assert.equal(shown.items[0].blockReason, 'PROHIBITED_CONTENT');
  assert.equal((await fetch(`${base}/api/admin/gemini-log?limit=0`, { headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}/api/admin/gemini-log`)).status, 401);

  const edit = (token, instructions) => api(`/api/stories/${id}/instructions`, { method: 'POST', token, body: { instructions } });
  assert.equal((await edit(undefined, 'Algo nuevo')).status, 401);
  assert.equal((await edit(ownerToken, '')).status, 400);
  blocked = false;
  assert.equal((await edit(ownerToken, 'Una aventura en el mar')).status, 202);
  const finished = await until(read, (story) => story.generation?.state === 'waiting', 'reanudación tras cambiar instrucciones');
  assert.equal(finished.settings.premise, 'Una aventura en el mar');
  assert.equal((await edit(ownerToken, 'Otra vez')).status, 409);
});
