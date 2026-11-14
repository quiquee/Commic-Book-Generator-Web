import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createAppServer, parsePublicBaseUrl } from './server.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const invitationBody = {
  hostName: 'Ana',
  guestName: 'Luis',
  hero: { base64: JPEG, desc: 'Un héroe' },
  settings: {
    genre: 'Classic Horror',
    language: 'es-ES',
    premise: 'Una aventura',
    richMode: true,
  },
};

let dataDir;
let storiesDir;
let server;
let baseUrl;

async function startServer(options = {}) {
  server = createAppServer({
    dataDir, storiesDir, usageDir: join(dataDir, 'usage'),
    auditFile: join(dataDir, 'audit.log'), backgroundGeneration: false, ...options,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  server = undefined;
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const payload = response.status === 204 ? undefined : await response.json();
  return { response, payload };
}

async function createInvitation(body = invitationBody) {
  return api('/api/invitations', { method: 'POST', body });
}

// Creates an invitation the guest has already answered, as needed to start a shared comic.
async function createJoinedInvitation() {
  const invitation = await createInvitation();
  const joined = await api(`/api/invitations/${invitation.payload.id}/responses`, {
    method: 'POST',
    token: invitation.payload.guestToken,
    body: { persona: { base64: JPEG, desc: 'Compañero' } },
  });
  return { ...invitation, responseId: joined.payload.id };
}

const storyBody = (invitation = null) => ({
  title: 'Una historia compartida',
  hostName: 'Ana',
  guestName: 'Luis',
  hero: { base64: JPEG, desc: 'Héroe' },
  friend: null,
  settings: { ...invitationBody.settings },
  tone: 'Aventurero',
  invitation,
});

function faceBody(id, { type, pageIndex, choices = [], isDecisionPage = false, imageUrl } = {}) {
  return {
    id,
    type: type ?? (id === 'cover' ? 'cover' : id === 'page-11' ? 'back_cover' : 'story'),
    pageIndex: pageIndex ?? (id === 'cover' ? 0 : Number(id.slice(5))),
    isLoading: false,
    isDecisionPage,
    choices,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comic-server-test-'));
  storiesDir = join(dataDir, 'stories');
  await startServer();
});

afterEach(async () => {
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
});

test('supports a two-device invitation flow and keeps secrets out of reads', async () => {
  const created = await createInvitation();
  assert.equal(created.response.status, 201);
  assert.match(created.payload.id, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof created.payload.ownerToken, 'string');
  assert.equal(typeof created.payload.guestToken, 'string');

  const invitePath = `/api/invitations/${created.payload.id}`;
  const ownerBefore = await api(invitePath, { token: created.payload.ownerToken });
  assert.equal(ownerBefore.response.status, 200);
  assert.deepEqual(ownerBefore.payload.responses, []);
  assert.equal('ownerToken' in ownerBefore.payload, false);
  assert.equal('guestToken' in ownerBefore.payload, false);

  const join = await api(`${invitePath}/join`, { token: created.payload.guestToken });
  assert.equal(join.response.status, 200);
  assert.equal(join.payload.guestName, 'Luis');
  assert.equal('responses' in join.payload, false);
  assert.equal('ownerToken' in join.payload, false);

  const submitted = await api(`${invitePath}/responses`, {
    method: 'POST',
    token: created.payload.guestToken,
    body: { persona: { base64: JPEG, desc: 'Compañero' } },
  });
  assert.equal(submitted.response.status, 201);
  assert.equal(submitted.payload.status, 'pending');

  const status = await api(`${invitePath}/responses/${submitted.payload.id}`, {
    token: created.payload.guestToken,
  });
  assert.deepEqual(status.payload, { id: submitted.payload.id, status: 'pending' });

  const accepted = await api(`${invitePath}/accept`, {
    method: 'POST',
    token: created.payload.ownerToken,
    body: { responseId: submitted.payload.id },
  });
  assert.deepEqual(accepted.payload, { id: submitted.payload.id, status: 'accepted' });
  const guestStatus = await api(`${invitePath}/responses/${submitted.payload.id}`, {
    token: created.payload.guestToken,
  });
  assert.equal(guestStatus.payload.status, 'accepted');
});

test('enforces owner/guest authorization and does not mutate responses on failed acceptance', async () => {
  const created = await createInvitation();
  const invitePath = `/api/invitations/${created.payload.id}`;
  const unauthorized = await api(invitePath);
  assert.equal(unauthorized.response.status, 401);
  assert.equal(typeof unauthorized.payload.error, 'string');
  const wrongRole = await api(`${invitePath}/join`, { token: created.payload.ownerToken });
  assert.equal(wrongRole.response.status, 401);
  const submitted = await api(`${invitePath}/responses`, {
    method: 'POST',
    token: created.payload.guestToken,
    body: { persona: { base64: JPEG, desc: 'Compañero' } },
  });
  const failedAcceptance = await api(`${invitePath}/accept`, {
    method: 'POST',
    token: created.payload.guestToken,
    body: { responseId: submitted.payload.id },
  });
  assert.equal(failedAcceptance.response.status, 401);
  const ownerRead = await api(invitePath, { token: created.payload.ownerToken });
  assert.equal(ownerRead.payload.responses[0].status, 'pending');
});

test('validates request shape, fields, JPEG data and JSON/body limits', async () => {
  for (const body of [
    { ...invitationBody, hostName: '  ' },
    { ...invitationBody, extra: true },
    { ...invitationBody, settings: { ...invitationBody.settings, language: 'xx-XX' } },
    { ...invitationBody, settings: { ...invitationBody.settings, genre: 'Custom', premise: '  ' } },
    { ...invitationBody, hero: { base64: 'bm90IGpwZWc=', desc: 'No es JPEG' } },
    { ...invitationBody, hero: { base64: JPEG, desc: '' } },
    { ...invitationBody, hero: { base64: JPEG, desc: 'x'.repeat(1001) } },
  ]) {
    const invalid = await createInvitation(body);
    assert.equal(invalid.response.status, 400);
    assert.equal(typeof invalid.payload.error, 'string');
  }

  const malformed = await api('/api/invitations', {
    method: 'POST',
    body: '{"broken":',
  });
  assert.equal(malformed.response.status, 400);
  const wrongContentType = await api('/api/invitations', {
    method: 'POST',
    body: JSON.stringify(invitationBody),
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongContentType.response.status, 415);
  const tooLarge = await api('/api/invitations', {
    method: 'POST',
    body: `{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`,
  });
  assert.equal(tooLarge.response.status, 413);
});

test('persists invitations across server restarts and expires old records', async () => {
  const created = await createInvitation();
  const id = created.payload.id;
  const invitePath = `/api/invitations/${id}`;
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, `${id}.json`))).mode & 0o777, 0o600);
  await stopServer();
  await startServer();
  const persisted = await api(invitePath, { token: created.payload.ownerToken });
  assert.equal(persisted.response.status, 200);
  assert.equal(persisted.payload.hostName, 'Ana');

  const recordPath = join(dataDir, `${id}.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.createdAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await writeFile(recordPath, JSON.stringify(record));
  const expired = await api(invitePath, { token: created.payload.ownerToken });
  assert.equal(expired.response.status, 404);
  assert.equal((await readdir(dataDir)).includes(`${id}.json`), false);
});

test('serves the Vite SPA through middleware in development mode', async () => {
  await stopServer();
  server = createAppServer({ dataDir, usageDir: join(dataDir, 'usage'), dev: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /id="root"/);

  const appModule = await fetch(`${baseUrl}/index.tsx`);
  assert.equal(appModule.status, 200);
  const transformedModule = await appModule.text();
  assert.match(transformedModule, /createRoot/);
  const dependencies = [...new Set(
    [...transformedModule.matchAll(/["']([^"']*\/node_modules\/\.vite\/deps\/[^"']+)["']/g)]
      .map((match) => match[1]),
  )];
  assert.ok(dependencies.length > 0, 'the transformed app module should import optimized dependencies');
  for (const dependency of dependencies) {
    const dependencyResponse = await fetch(new URL(dependency, baseUrl));
    assert.equal(dependencyResponse.status, 200, `${dependency} should load successfully`);
    assert.ok((await dependencyResponse.text()).length > 0);
  }
});

test('rejects path traversal and unknown API routes with JSON errors', async () => {
  const traversal = await api('/api/invitations/%2e%2e%2fserver.mjs');
  assert.equal(traversal.response.status, 404);
  assert.equal(typeof traversal.payload.error, 'string');
  const missing = await api('/api/not-a-route');
  assert.equal(missing.response.status, 404);
  assert.equal(typeof missing.payload.error, 'string');
});

test('limits the number of responses and keeps unselected responses pending', async () => {
  const created = await createInvitation();
  const invitePath = `/api/invitations/${created.payload.id}`;
  const responseIds = [];
  for (let index = 0; index < 20; index += 1) {
    const submitted = await api(`${invitePath}/responses`, {
      method: 'POST',
      token: created.payload.guestToken,
      body: { persona: { base64: JPEG, desc: `Compañero ${index}` } },
    });
    assert.equal(submitted.response.status, 201);
    responseIds.push(submitted.payload.id);
  }
  const capped = await api(`${invitePath}/responses`, {
    method: 'POST',
    token: created.payload.guestToken,
    body: { persona: { base64: JPEG, desc: 'Uno más' } },
  });
  assert.equal(capped.response.status, 409);

  await api(`${invitePath}/accept`, {
    method: 'POST',
    token: created.payload.ownerToken,
    body: { responseId: responseIds[7] },
  });
  const ownerRead = await api(invitePath, { token: created.payload.ownerToken });
  assert.equal(ownerRead.payload.responses[7].status, 'accepted');
  assert.equal(ownerRead.payload.responses.filter((entry) => entry.status === 'accepted').length, 1);
  assert.equal(ownerRead.payload.responses.filter((entry) => entry.status === 'pending').length, 19);
  const secondAcceptance = await api(`${invitePath}/accept`, {
    method: 'POST',
    token: created.payload.ownerToken,
    body: { responseId: responseIds[8] },
  });
  assert.equal(secondAcceptance.response.status, 409);
});

test('a shared comic cannot start until the guest joins, and starting it accepts their response', async () => {
  const invitation = await createInvitation();
  const invitationPath = `/api/invitations/${invitation.payload.id}`;
  const linked = { id: invitation.payload.id, ownerToken: invitation.payload.ownerToken };
  const early = await api('/api/stories', { method: 'POST', body: storyBody(linked) });
  assert.equal(early.response.status, 409);
  assert.match(early.payload.error, /Luis todavía no se ha unido/);

  const joined = await api(`${invitationPath}/responses`, {
    method: 'POST',
    token: invitation.payload.guestToken,
    body: { persona: { base64: JPEG, desc: 'Compañero' } },
  });
  const unknown = await api('/api/stories', {
    method: 'POST', body: storyBody({ ...linked, responseId: randomUUID() }),
  });
  assert.equal(unknown.response.status, 404);

  const created = await api('/api/stories', {
    method: 'POST',
    body: {
      ...storyBody({ ...linked, responseId: joined.payload.id }),
      guestName: 'Otro nombre',
      settings: { ...invitationBody.settings, genre: 'Dark Sci-Fi' },
    },
  });
  assert.equal(created.response.status, 201);
  const story = await api(`/api/stories/${created.payload.id}`, { token: created.payload.ownerToken });
  assert.deepEqual(story.payload.friend, { base64: JPEG, desc: 'Luis' });
  assert.equal(story.payload.guestName, 'Luis');
  assert.equal(story.payload.settings.genre, 'Classic Horror');
  const status = await api(`${invitationPath}/responses/${joined.payload.id}`, {
    token: invitation.payload.guestToken,
  });
  assert.equal(status.payload.status, 'accepted');

  // Later comics with the same guest reuse the accepted response.
  const again = await api('/api/stories', { method: 'POST', body: storyBody(linked) });
  assert.equal(again.response.status, 201);
});

test('supports linked stories, participant choices, incremental reads, persistence and deletion', async () => {
  const invitation = await createJoinedInvitation();
  const invitationPath = `/api/invitations/${invitation.payload.id}`;
  const created = await api('/api/stories', {
    method: 'POST',
    body: storyBody({
      id: invitation.payload.id, ownerToken: invitation.payload.ownerToken, responseId: invitation.responseId,
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(typeof created.payload.ownerToken, 'string');
  assert.equal((await stat(storiesDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(storiesDir, `${created.payload.id}.json`))).mode & 0o777, 0o600);

  const guestJoin = await api(`${invitationPath}/join`, { token: invitation.payload.guestToken });
  assert.equal(guestJoin.response.status, 200);
  assert.deepEqual(guestJoin.payload.stories.map(({ id, title, totalPages }) => ({
    id, title, totalPages,
  })), [{
    id: created.payload.id,
    title: 'Una historia compartida',
    totalPages: 12,
  }]);

  const storyPath = `/api/stories/${created.payload.id}`;
  const initial = await api(storyPath, { token: invitation.payload.guestToken });
  assert.equal(initial.payload.role, 'guest');
  assert.equal(initial.payload.ownerToken, undefined);
  assert.equal('invitationId' in initial.payload, false);
  const ownerRead = await api(storyPath, { token: created.payload.ownerToken });
  assert.equal(ownerRead.payload.invitationId, invitation.payload.id);
  assert.equal(initial.payload.hero.base64, JPEG);
  assert.deepEqual(initial.payload.friend, { base64: JPEG, desc: 'Luis' });

  const updated = await api(storyPath, {
    method: 'PATCH',
    token: created.payload.ownerToken,
    body: { title: 'Título actualizado', styleGuide: 'Tinta y viñetas' },
  });
  assert.deepEqual(updated.payload, { version: 1 });
  const guestPatch = await api(storyPath, {
    method: 'PATCH',
    token: invitation.payload.guestToken,
    body: { tone: 'Otro tono' },
  });
  assert.equal(guestPatch.response.status, 403);

  const cover = await api(`${storyPath}/faces/cover`, {
    method: 'PUT',
    token: created.payload.ownerToken,
    body: faceBody('cover', { imageUrl: `data:image/jpeg;base64,${JPEG}` }),
  });
  assert.equal(cover.response.status, 200);
  const decision = await api(`${storyPath}/faces/page-3`, {
    method: 'PUT',
    token: created.payload.ownerToken,
    body: faceBody('page-3', { isDecisionPage: true, choices: ['Avanzar', 'Esperar'] }),
  });
  assert.equal(decision.response.status, 200);

  const choice = await api(`${storyPath}/choices`, {
    method: 'POST',
    token: invitation.payload.guestToken,
    body: { faceId: 'page-3', choice: 'Avanzar' },
  });
  assert.deepEqual(choice.payload, {
    version: 4,
    faceId: 'page-3',
    resolvedChoice: 'Avanzar',
  });
  const ownerUpdate = await api(`${storyPath}/faces/page-3`, {
    method: 'PUT',
    token: created.payload.ownerToken,
    body: faceBody('page-3', { isDecisionPage: true, choices: ['Avanzar', 'Esperar'] }),
  });
  assert.equal(ownerUpdate.payload.version, 5);
  const secondChoice = await api(`${storyPath}/choices`, {
    method: 'POST',
    token: invitation.payload.guestToken,
    body: { faceId: 'page-3', choice: 'Esperar' },
  });
  assert.equal(secondChoice.response.status, 409);
  assert.equal(secondChoice.payload.resolvedChoice, 'Avanzar');

  const incremental = await api(`${storyPath}?after=3`, { token: created.payload.ownerToken });
  assert.equal(incremental.payload.role, 'owner');
  assert.deepEqual(incremental.payload.faces.map((face) => face.id), ['page-3']);
  assert.equal(incremental.payload.faces[0].resolvedChoice, 'Avanzar');
  assert.equal('hero' in incremental.payload, false);
  assert.equal('friend' in incremental.payload, false);
  const completed = await api(storyPath, { token: created.payload.ownerToken });
  assert.equal(completed.payload.completedPages, 1);

  const guestDelete = await api(storyPath, {
    method: 'DELETE',
    token: invitation.payload.guestToken,
  });
  assert.equal(guestDelete.response.status, 403);

  const invitationRecordPath = join(dataDir, `${invitation.payload.id}.json`);
  const invitationRecord = JSON.parse(await readFile(invitationRecordPath, 'utf8'));
  invitationRecord.createdAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await writeFile(invitationRecordPath, JSON.stringify(invitationRecord));
  const capacityCleanup = await createInvitation();
  assert.equal(capacityCleanup.response.status, 201);
  const stillLinked = await api(`${invitationPath}/join`, { token: invitation.payload.guestToken });
  assert.equal(stillLinked.response.status, 200);
  assert.equal(stillLinked.payload.stories.length, 1);
  invitationRecord.createdAt = Date.now();
  await writeFile(invitationRecordPath, JSON.stringify(invitationRecord));

  await stopServer();
  await startServer();
  const persisted = await api(`${storyPath}?after=3`, { token: invitation.payload.guestToken });
  assert.equal(persisted.response.status, 200);
  assert.equal(persisted.payload.faces[0].resolvedChoice, 'Avanzar');

  const deleted = await api(storyPath, { method: 'DELETE', token: created.payload.ownerToken });
  assert.equal(deleted.response.status, 204);
  const noLongerListed = await api(`${invitationPath}/join`, { token: invitation.payload.guestToken });
  assert.equal(noLongerListed.payload.stories.length, 0);
  const missingStory = await api(storyPath, { token: created.payload.ownerToken });
  assert.equal(missingStory.response.status, 404);
});

test('validates story input, face identifiers and JPEG images; unlinked stories have no guest access', async () => {
  const invitation = await createInvitation();
  const linked = { id: invitation.payload.id, ownerToken: invitation.payload.ownerToken };
  for (const body of [
    { ...storyBody(linked), title: '  ' },
    { ...storyBody(linked), settings: { ...invitationBody.settings, genre: 'Custom', premise: '  ' } },
    { ...storyBody(linked), invitation: { ...linked, ownerToken: 'wrong' } },
  ]) {
    const invalid = await api('/api/stories', { method: 'POST', body });
    assert.equal(invalid.response.status, body.invitation?.ownerToken === 'wrong' ? 401 : 400);
    assert.equal(typeof invalid.payload.error, 'string');
  }

  const unlinked = await api('/api/stories', { method: 'POST', body: storyBody() });
  assert.equal(unlinked.response.status, 201);
  const unrelatedGuest = await api(`/api/stories/${unlinked.payload.id}`, {
    token: invitation.payload.guestToken,
  });
  assert.equal(unrelatedGuest.response.status, 401);
  const owner = unlinked.payload.ownerToken;
  const path = `/api/stories/${unlinked.payload.id}/faces`;
  const allowedLargeImage = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(1.5 * 1024 * 1024 - 5),
    Buffer.from([0xff, 0xd9]),
  ]);
  const largeImage = await api(`${path}/page-1`, {
    method: 'PUT',
    token: owner,
    body: faceBody('page-1', {
      imageUrl: `data:image/jpeg;base64,${allowedLargeImage.toString('base64')}`,
    }),
  });
  assert.equal(largeImage.response.status, 200);
  const invalidFaces = [
    ['page-3', faceBody('page-4')],
    ['page-3', faceBody('page-3', { type: 'back_cover' })],
    ['page-3', faceBody('page-3', { imageUrl: 'data:image/jpeg;base64,bm90LWpwZWc=' })],
    ['page-3', faceBody('page-3', {
      imageUrl: `data:image/jpeg;base64,${Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.alloc(1.5 * 1024 * 1024),
        Buffer.from([0xff, 0xd9]),
      ]).toString('base64')}`,
    })],
  ];
  for (const [faceId, body] of invalidFaces) {
    const invalid = await api(`${path}/${faceId}`, { method: 'PUT', token: owner, body });
    assert.equal(invalid.response.status, 400);
    assert.equal(typeof invalid.payload.error, 'string');
  }

  const invalidAfter = await api(`/api/stories/${unlinked.payload.id}?after=-1`, { token: owner });
  assert.equal(invalidAfter.response.status, 400);
  const invalidChoice = await api(`/api/stories/${unlinked.payload.id}/choices`, {
    method: 'POST',
    token: owner,
    body: { faceId: 'page-2', choice: 'No existe' },
  });
  assert.equal(invalidChoice.response.status, 404);
});

test('exposes the configured public base URL read-only and defaults to null', async () => {
  const unset = await api('/api/config');
  assert.equal(unset.response.status, 200);
  assert.deepEqual(unset.payload, { baseUrl: null, geminiProxy: false });
  assert.equal((await api('/api/config', { method: 'POST', body: {} })).response.status, 405);

  const configured = createAppServer({ dataDir, storiesDir, usageDir: join(dataDir, 'usage'), publicBaseUrl: ' https://comics.example.com/app/?x=1#y ' });
  await new Promise((resolve) => configured.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${configured.address().port}/api/config`);
    assert.deepEqual(await response.json(), { baseUrl: 'https://comics.example.com/app', geminiProxy: false });
  } finally {
    await new Promise((resolve) => configured.close(resolve));
  }
});

test('validates the public base URL configuration', () => {
  assert.equal(parsePublicBaseUrl(undefined), null);
  assert.equal(parsePublicBaseUrl('  '), null);
  assert.equal(parsePublicBaseUrl('http://192.168.1.10:3000/'), 'http://192.168.1.10:3000');
  for (const invalid of ['example.com', 'javascript:alert(1)', 'ftp://example.com', 'https://user:pass@example.com']) {
    assert.throws(() => parsePublicBaseUrl(invalid), /PUBLIC_BASE_URL/);
  }
  assert.throws(() => createAppServer({ dataDir, storiesDir, publicBaseUrl: 'no-es-una-url' }), /PUBLIC_BASE_URL/);
});

test('wires proxy drafts into stories and retains owner/admin deletion accounting', async (context) => {
  const upstreamRequests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks)), path: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 20, thoughtsTokenCount: 813, totalTokenCount: 847 },
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  await stopServer();
  await startServer({
    geminiApiKey: 'PRIVATE_UPSTREAM_KEY',
    geminiUpstream: `http://127.0.0.1:${upstream.address().port}`,
    adminPassword: 'PRIVATE_ADMIN_PASSWORD',
  });
  assert.equal((await api('/api/config')).payload.geminiProxy, true);
  const draftId = randomUUID();
  const route = '/api/gemini/v1beta/models/gemini-3.8-flash:generateContent';
  const draft = await api(route, {
    method: 'POST', body: { contents: [] },
    headers: { 'X-Draft-Id': draftId, 'X-Usage-Op': 'title', 'X-Goog-Api-Key': 'proxy' },
  });
  assert.equal(draft.response.status, 200);
  const joined = await createJoinedInvitation();
  const invitation = joined.payload;
  const story = (await api('/api/stories', {
    method: 'POST',
    body: {
      ...storyBody({ id: invitation.id, ownerToken: invitation.ownerToken, responseId: joined.responseId }),
      draftId,
    },
  })).payload;
  assert.ok(story.id);
  const accounted = JSON.parse(await readFile(join(dataDir, 'usage', `${story.id}.json`), 'utf8'));
  assert.equal(accounted.totals.calls, 1);
  assert.equal(accounted.events[0].op, 'title');
  await assert.rejects(readFile(join(dataDir, 'usage', `draft-${draftId}.json`)), { code: 'ENOENT' });
  const guestCall = await api(route, {
    method: 'POST', body: {},
    headers: { 'X-Story-Id': story.id, 'X-Story-Token': invitation.guestToken },
  });
  assert.equal(guestCall.response.status, 401);
  const ownerCall = await api(route, {
    method: 'POST', body: { contents: [] },
    headers: { 'X-Story-Id': story.id, 'X-Story-Token': story.ownerToken, 'X-Usage-Op': 'beat:3' },
  });
  assert.equal(ownerCall.response.status, 200);
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[0].headers['x-goog-api-key'], 'PRIVATE_UPSTREAM_KEY');
  assert.equal(upstreamRequests[1].headers['x-story-token'], undefined);
  const login = await api('/api/admin/login', {
    method: 'POST', body: { password: 'PRIVATE_ADMIN_PASSWORD' },
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const detail = await api(`/api/admin/stories/${story.id}`, { headers: { cookie } });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.usage.totals.calls, 2);
  for (const secret of [story.ownerToken, invitation.ownerToken, invitation.guestToken, 'PRIVATE_UPSTREAM_KEY']) {
    assert.equal(JSON.stringify(detail.payload).includes(secret), false);
  }
  assert.equal((await api(`/api/stories/${story.id}`, { method: 'DELETE', token: story.ownerToken })).response.status, 204);
  const deleted = await api(`/api/admin/stories/${story.id}`, { headers: { cookie } });
  assert.equal(deleted.payload.status, 'deleted');
  assert.equal(deleted.payload.deletedBy, 'owner');
  assert.equal(deleted.payload.usage.totals.tokens.total, 1694);

  const another = (await api('/api/stories', { method: 'POST', body: storyBody() })).payload;
  const adminDeletion = await api(`/api/admin/stories/${another.id}`, {
    method: 'DELETE', headers: { cookie, 'X-Admin-Request': '1' },
  });
  assert.equal(adminDeletion.response.status, 204);
  const adminDeleted = await api(`/api/admin/stories/${another.id}`, { headers: { cookie } });
  assert.equal(adminDeleted.payload.deletedBy, 'admin');
  const audit = (await readFile(join(dataDir, 'audit.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.action === 'story_delete' && entry.storyId === another.id));
  assert.equal((await stat(join(dataDir, 'usage', '_daily.json'))).mode & 0o777, 0o600);
});

test('the next issue copies the cast and look of a finished comic and refuses unfinished or foreign ones', async () => {
  const source = await api('/api/stories', { method: 'POST', body: { ...storyBody(), friend: { base64: JPEG, desc: 'Amiga' } } });
  const owner = source.payload.ownerToken;
  const continuation = { fromId: source.payload.id, token: owner, recap: 'Resumen.', direction: 'Perdonar' };
  const body = { ...storyBody(), title: 'Otro #2', hero: { base64: JPEG, desc: 'Otro' }, continuation };

  const early = await api('/api/stories', { method: 'POST', body });
  assert.equal(early.response.status, 409);

  const image = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
  for (let page = 0; page <= 11; page++) {
    const id = page === 0 ? 'cover' : `page-${page}`;
    const saved = await api(`/api/stories/${source.payload.id}/faces/${id}`, {
      method: 'PUT', token: owner, body: faceBody(id, { imageUrl: image })
    });
    assert.equal(saved.response.status, 200);
  }

  for (const bad of [
    { ...body, continuation: { ...continuation, token: 'wrong' } },
    { ...body, continuation: { ...continuation, extra: 1 } },
    { ...body, continuation: { ...continuation, direction: '' } },
  ]) {
    const rejected = await api('/api/stories', { method: 'POST', body: bad });
    assert.ok([400, 401].includes(rejected.response.status), String(rejected.response.status));
  }

  const created = await api('/api/stories', { method: 'POST', body });
  assert.equal(created.response.status, 201);
  const next = await api(`/api/stories/${created.payload.id}`, { token: created.payload.ownerToken });
  assert.equal(next.payload.title, 'Otro #2');
  assert.equal(next.payload.hero.desc, 'Héroe');
  assert.equal(next.payload.friend.desc, 'Amiga');
  assert.deepEqual(next.payload.continuation, { fromId: source.payload.id, issue: 2, recap: 'Resumen.', direction: 'Perdonar' });
  assert.equal(next.payload.faces.length, 0);
  // Both issues are one series, and the person who continues it keeps the same key (and made-up name).
  assert.deepEqual(next.payload.series, { id: source.payload.id, issue: 2 });
  assert.deepEqual((await api(`/api/stories/${source.payload.id}`, { token: owner })).payload.series, { id: source.payload.id, issue: 1 });
  assert.equal(created.payload.ownerToken, owner);
});

// Fills the twelve pages of a comic; `seed` makes its images differ from those of other comics.
async function finishStory(id, token, seed) {
  const image = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, seed), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
  for (let page = 0; page <= 11; page++) {
    const faceId = page === 0 ? 'cover' : `page-${page}`;
    const saved = await api(`/api/stories/${id}/faces/${faceId}`, { method: 'PUT', token, body: faceBody(faceId, { imageUrl: image }) });
    assert.equal(saved.response.status, 200);
  }
}

async function nextIssue(from, token, title) {
  const created = await api('/api/stories', {
    method: 'POST', body: { ...storyBody(), title, continuation: { fromId: from, token, recap: 'Resumen.', direction: `Rumbo de ${title}` } },
  });
  assert.equal(created.response.status, 201);
  return created.payload;
}

const storyRecord = async (id) => JSON.parse(await readFile(join(storiesDir, `${id}.json`), 'utf8'));

test('copying an issue also copies the issues before it, and the copies stay in the series', async () => {
  const first = (await api('/api/stories', { method: 'POST', body: storyBody() })).payload;
  await finishStory(first.id, first.ownerToken, 1);
  const second = await nextIssue(first.id, first.ownerToken, 'Serie #2');
  await finishStory(second.id, second.ownerToken, 2);
  const third = await nextIssue(second.id, second.ownerToken, 'Serie #3');
  await finishStory(third.id, third.ownerToken, 3);
  const read = (await api(`/api/stories/${second.id}/share`, { method: 'POST', token: first.ownerToken, body: {} })).payload.token;

  const copied = await api(`/api/stories/${second.id}/copy`, { method: 'POST', token: read, body: {} });
  assert.equal(copied.response.status, 201);
  assert.equal(copied.payload.keys.length, 2);
  assert.equal(copied.payload.id, copied.payload.keys[1].id);
  assert.ok(copied.payload.keys.every((key) => key.ownerToken === copied.payload.ownerToken && key.ownerToken !== first.ownerToken));
  const [copyOne, copyTwo] = await Promise.all(copied.payload.keys.map((key) => storyRecord(key.id)));
  assert.deepEqual(copyOne.series, { id: first.id, issue: 1, originId: first.id, parentOriginId: null });
  assert.deepEqual(copyTwo.series, { id: first.id, issue: 2, originId: second.id, parentOriginId: first.id });
  assert.equal(copyTwo.continuation.fromId, copyOne.id);
  assert.equal(copyOne.faces.length, 12);
  assert.equal((await readdir(storiesDir)).length, 5);

  // A different continuation of the copy is an alternative #3 of the same series.
  const other = await nextIssue(copyTwo.id, copied.payload.ownerToken, 'Serie #3 bis');
  assert.deepEqual((await storyRecord(other.id)).series, { id: first.id, issue: 3, originId: other.id, parentOriginId: second.id });
  assert.deepEqual((await storyRecord(third.id)).series, { id: first.id, issue: 3, originId: third.id, parentOriginId: second.id });
});

test('comics made before series existed are placed by their continuation link and their cover', async () => {
  const first = (await api('/api/stories', { method: 'POST', body: storyBody() })).payload;
  await finishStory(first.id, first.ownerToken, 1);
  const second = await nextIssue(first.id, first.ownerToken, 'Vieja #2');
  await finishStory(second.id, second.ownerToken, 2);
  // An old copy of #1: same pages, no link to its original. And none of the three has series data.
  const oldCopy = { ...(await storyRecord(first.id)), id: '11111111-1111-4111-8111-111111111111', ownerToken: 'old-copy-token', createdAt: Date.now() + 1000 };
  await writeFile(join(storiesDir, `${oldCopy.id}.json`), JSON.stringify(oldCopy));
  for (const id of [first.id, second.id, oldCopy.id]) {
    const record = await storyRecord(id);
    delete record.series;
    await writeFile(join(storiesDir, `${id}.json`), JSON.stringify(record));
  }

  assert.deepEqual((await api(`/api/stories/${second.id}`, { token: first.ownerToken })).payload.series, { id: first.id, issue: 2 });
  assert.deepEqual((await api(`/api/stories/${oldCopy.id}`, { token: 'old-copy-token' })).payload.series, { id: first.id, issue: 1 });
  // Continuing the old copy gives an alternative #2 of the original's series.
  const branch = await nextIssue(oldCopy.id, 'old-copy-token', 'Vieja #2 bis');
  assert.deepEqual((await storyRecord(branch.id)).series, { id: first.id, issue: 2, originId: branch.id, parentOriginId: first.id });
  // Reading placed them without writing anything to the old records.
  assert.equal((await storyRecord(second.id)).series, undefined);

  const read = (await api(`/api/stories/${second.id}/share`, { method: 'POST', token: first.ownerToken, body: {} })).payload.token;
  const copied = await api(`/api/stories/${second.id}/copy`, { method: 'POST', token: read, body: {} });
  assert.equal(copied.payload.keys.length, 2);
  assert.deepEqual((await storyRecord(copied.payload.keys[0].id)).series, { id: first.id, issue: 1, originId: first.id, parentOriginId: null });
  assert.deepEqual((await storyRecord(copied.payload.id)).series, { id: first.id, issue: 2, originId: second.id, parentOriginId: first.id });
});

test('whoever owns a comic of a series reads every branch of it; a link shows the branch of who shared it', async () => {
  const invitation = await createJoinedInvitation();
  const first = (await api('/api/stories', {
    method: 'POST',
    body: storyBody({ id: invitation.payload.id, ownerToken: invitation.payload.ownerToken, responseId: invitation.responseId }),
  })).payload;
  const owner = first.ownerToken;
  await finishStory(first.id, owner, 1);
  const second = await nextIssue(first.id, owner, 'Serie #2');
  await finishStory(second.id, owner, 2);
  const third = await nextIssue(second.id, owner, 'Serie #3');
  await finishStory(third.id, owner, 3);
  const link = (await api(`/api/stories/${first.id}/share`, { method: 'POST', token: owner, body: {} })).payload.token;

  // Someone keeps a copy of #1 and #2 and continues it another way.
  const copied = (await api(`/api/stories/${second.id}/copy`, { method: 'POST', token: link, body: {} })).payload;
  const other = copied.ownerToken;
  const bis = await nextIssue(copied.id, other, 'Serie #3 bis');
  await finishStory(bis.id, other, 4);

  // The owner sees the whole series: both #3, and no hint of who made the other one.
  const tree = await api(`/api/stories/${first.id}/series`, { token: owner });
  assert.equal(tree.response.status, 200);
  assert.equal(tree.payload.id, first.id);
  assert.equal(tree.payload.title, 'Una historia compartida');
  assert.deepEqual(tree.payload.nodes.map((node) => [node.issue, node.storyId, node.parentOriginId, node.mine, node.completedPages]), [
    [1, first.id, null, true, 12],
    [2, second.id, first.id, true, 12],
    [3, third.id, second.id, true, 12],
    [3, bis.id, second.id, false, 12],
  ]);
  assert.deepEqual(tree.payload.nodes[0].stories, [first.id, copied.keys[0].id]);
  assert.equal(tree.payload.nodes[3].direction, 'Rumbo de Serie #3 bis');
  const text = JSON.stringify(tree.payload);
  assert.ok(!text.includes(other) && !text.includes(owner) && !/alias|token/i.test(text));

  // The copy owner's tree reads from their own copies.
  const theirs = await api(`/api/stories/${bis.id}/series`, { token: other });
  assert.deepEqual(theirs.payload.nodes.map((node) => [node.storyId, node.mine]), [
    [copied.keys[0].id, true], [copied.id, true], [third.id, false], [bis.id, true],
  ]);

  // Each reads the other's #3, and nothing more than read (or keep a copy).
  for (const [id, token] of [[bis.id, owner], [third.id, other]]) {
    const read = await api(`/api/stories/${id}`, { token });
    assert.equal(read.response.status, 200);
    assert.equal(read.payload.role, 'family');
    assert.equal(read.payload.faces.length, 12);
    assert.equal(read.payload.ownerAlias, undefined);
    assert.equal((await api(`/api/stories/${id}?after=${read.payload.version}`, { token })).payload.faces.length, 0);
    assert.match((await api(`/api/stories/${id}/cover`, { token })).payload.imageUrl, /^data:image\/jpeg;base64,/);
    assert.equal((await api(`/api/stories/${id}/share`, { method: 'POST', token, body: {} })).response.status, 403);
    assert.equal((await api(`/api/stories/${id}`, { method: 'PATCH', token, body: { title: 'Mío' } })).response.status, 403);
    assert.equal((await api(`/api/stories/${id}/generate`, { method: 'POST', token, body: {} })).response.status, 503);
    assert.equal((await api(`/api/stories/${id}`, { method: 'DELETE', token })).response.status, 403);
    const next = await api('/api/stories', { method: 'POST', body: { ...storyBody(), title: 'Ajeno #4', continuation: { fromId: id, token, recap: 'r', direction: 'd' } } });
    assert.equal(next.response.status, 401);
  }

  // The reading link of #1 opens the sharer's issues, not the other branch nor the other person's copies.
  const shared = await api(`/api/stories/${second.id}/series`, { token: link });
  assert.deepEqual(shared.payload.nodes.map((node) => [node.storyId, node.stories, node.mine]), [
    [first.id, [first.id], false], [second.id, [second.id], false], [third.id, [third.id], false],
  ]);
  const opensBefore = (await storyRecord(first.id)).sharing.opens ?? 0;
  const viaLink = await api(`/api/stories/${third.id}`, { token: link });
  assert.equal(viaLink.payload.role, 'reader');
  assert.equal((await storyRecord(third.id)).sharing, undefined);
  assert.equal((await storyRecord(first.id)).sharing.opens ?? 0, opensBefore);
  assert.equal((await api(`/api/stories/${third.id}/share`, { method: 'POST', token: link, body: {} })).response.status, 403);
  for (const id of [bis.id, copied.id, copied.keys[0].id]) {
    assert.equal((await api(`/api/stories/${id}`, { token: link })).response.status, 401);
    assert.equal((await api(`/api/stories/${id}/cover`, { token: link })).response.status, 401);
  }

  // The invited co-star of #1 follows the same branch, read-only beyond their own issue.
  const guest = invitation.payload.guestToken;
  assert.equal((await api(`/api/stories/${first.id}`, { token: guest })).payload.role, 'guest');
  assert.equal((await api(`/api/stories/${third.id}`, { token: guest })).payload.role, 'reader');
  assert.equal((await api(`/api/stories/${bis.id}`, { token: guest })).response.status, 401);
  assert.equal((await api(`/api/stories/${first.id}/series`, { token: guest })).payload.nodes.length, 3);

  // A key of another series, or none, opens nothing.
  const stranger = (await api('/api/stories', { method: 'POST', body: { ...storyBody(), title: 'Otra cosa' } })).payload;
  for (const path of ['', '/series', '/cover']) {
    assert.equal((await api(`/api/stories/${bis.id}${path}`, { token: stranger.ownerToken })).response.status, 401);
    assert.equal((await api(`/api/stories/${bis.id}${path}`)).response.status, 401);
  }
  assert.deepEqual((await api(`/api/stories/${stranger.id}/series`, { token: stranger.ownerToken })).payload.nodes.map((node) => node.storyId), [stranger.id]);
});

test('a reader gets their own copy of a finished comic, with photos and characters, and cannot touch the original', async () => {
  const source = await api('/api/stories', { method: 'POST', body: { ...storyBody(), friend: { base64: JPEG, desc: 'Amiga' } } });
  const owner = source.payload.ownerToken;
  const path = `/api/stories/${source.payload.id}`;
  const shared = await api(`${path}/share`, { method: 'POST', token: owner, body: {} });
  const read = shared.payload.token;

  const early = await api(`${path}/copy`, { method: 'POST', token: read, body: {} });
  assert.equal(early.response.status, 409);

  const image = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
  for (let page = 0; page <= 11; page++) {
    const id = page === 0 ? 'cover' : `page-${page}`;
    await api(`${path}/faces/${id}`, { method: 'PUT', token: owner, body: faceBody(id, { imageUrl: image }) });
  }

  assert.equal((await api(`${path}/copy`, { method: 'POST', body: {} })).response.status, 401);
  assert.equal((await api(`${path}/copy`, { method: 'POST', token: owner, body: {} })).response.status, 403);

  const copied = await api(`${path}/copy`, { method: 'POST', token: read, body: {} });
  assert.equal(copied.response.status, 201);
  assert.notEqual(copied.payload.id, source.payload.id);
  assert.notEqual(copied.payload.ownerToken, owner);

  const mine = await api(`/api/stories/${copied.payload.id}`, { token: copied.payload.ownerToken });
  assert.equal(mine.payload.role, 'owner');
  assert.equal(mine.payload.hero.desc, 'Héroe');
  assert.equal(mine.payload.friend.desc, 'Amiga');
  assert.equal(mine.payload.faces.length, 12);
  assert.equal(mine.payload.generation.state, 'finished');
  // The original's link does not open the copy, and the copy's owner can continue and delete it.
  assert.equal((await api(`/api/stories/${copied.payload.id}`, { token: read })).response.status, 401);
  assert.equal((await api(`/api/stories/${copied.payload.id}`, { method: 'DELETE', token: copied.payload.ownerToken })).response.status, 204);
  assert.equal((await api(path, { token: owner })).response.status, 200);
});

test('the admin transfers a copy through a one-time link, and alias names stay with the owner and the admin', async () => {
  await stopServer();
  await startServer({ adminPassword: 'PRIVATE_ADMIN_PASSWORD' });
  const source = await api('/api/stories', { method: 'POST', body: { ...storyBody(), friend: { base64: JPEG, desc: 'Amiga' } } });
  const owner = source.payload.ownerToken;
  const path = `/api/stories/${source.payload.id}`;
  const login = await api('/api/admin/login', { method: 'POST', body: { password: 'PRIVATE_ADMIN_PASSWORD' } });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];

  assert.equal((await api(`/api/admin/stories/${source.payload.id}/transfer`, { method: 'POST', headers: { cookie, 'x-admin-request': '1' } })).response.status, 409);

  const image = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
  for (let page = 0; page <= 11; page++) {
    const id = page === 0 ? 'cover' : `page-${page}`;
    await api(`${path}/faces/${id}`, { method: 'PUT', token: owner, body: faceBody(id, { imageUrl: image }) });
  }

  assert.equal((await api(`/api/admin/stories/${source.payload.id}/transfer`, { method: 'POST', headers: { 'x-admin-request': '1' } })).response.status, 401);
  const made = await api(`/api/admin/stories/${source.payload.id}/transfer`, { method: 'POST', headers: { cookie, 'x-admin-request': '1' } });
  assert.equal(made.response.status, 201);
  assert.notEqual(made.payload.id, source.payload.id);
  assert.match(made.payload.ownerAlias, /\d/);
  assert.equal(made.payload.issues, 1);
  const copyPath = `/api/stories/${made.payload.id}`;

  assert.equal((await api(`${copyPath}/claim`, { method: 'POST', body: { claim: 'nope' } })).response.status, 404);
  const claimed = await api(`${copyPath}/claim`, { method: 'POST', body: { claim: made.payload.claim } });
  assert.equal(claimed.response.status, 200);
  assert.deepEqual(claimed.payload.keys, [{ id: made.payload.id, ownerToken: claimed.payload.ownerToken }]);
  assert.equal((await api(`${copyPath}/claim`, { method: 'POST', body: { claim: made.payload.claim } })).response.status, 404);

  const mine = await api(copyPath, { token: claimed.payload.ownerToken });
  assert.equal(mine.payload.role, 'owner');
  assert.equal(mine.payload.friend.desc, 'Amiga');
  assert.equal(mine.payload.faces.length, 12);
  assert.equal(mine.payload.ownerAlias, made.payload.ownerAlias);
  assert.equal(JSON.stringify(mine.payload).includes('claimToken'), false);
  const original = await api(path, { token: owner });
  assert.notEqual(original.payload.ownerAlias, mine.payload.ownerAlias);

  const detail = await api(`/api/admin/stories/${made.payload.id}`, { headers: { cookie } });
  assert.equal(detail.payload.ownerAlias, made.payload.ownerAlias);
  assert.equal(JSON.stringify(detail.payload).includes(claimed.payload.ownerToken), false);
  // A reader never sees the alias.
  const shared = await api(`${path}/share`, { method: 'POST', token: owner, body: {} });
  const asReader = await api(path, { token: shared.payload.token });
  assert.equal(asReader.payload.ownerAlias, undefined);

  // Transferring issue #2 hands over #1 and #2 through the one link.
  const second = await nextIssue(source.payload.id, owner, 'Traspaso #2');
  await finishStory(second.id, second.ownerToken, 2);
  const series = await api(`/api/admin/stories/${second.id}/transfer`, { method: 'POST', headers: { cookie, 'x-admin-request': '1' } });
  assert.equal(series.payload.issues, 2);
  const both = await api(`/api/stories/${series.payload.id}/claim`, { method: 'POST', body: { claim: series.payload.claim } });
  assert.equal(both.payload.keys.length, 2);
  assert.equal(both.payload.keys[1].id, series.payload.id);
  const firstCopy = await api(`/api/stories/${both.payload.keys[0].id}`, { token: both.payload.keys[0].ownerToken });
  assert.equal(firstCopy.payload.role, 'owner');
  assert.deepEqual(firstCopy.payload.series, { id: source.payload.id, issue: 1 });
  assert.equal(firstCopy.payload.ownerAlias, series.payload.ownerAlias);
});

test('a photo from another site is passed on to the app only: guarded address, own pages, a few per minute', async () => {
  // The default downloader refuses these before connecting anywhere.
  for (const address of ['http://example.com/a.jpg', 'no-es-una-url', 'https://user:clave@example.com/a.jpg']) {
    const refused = await api(`/api/photo?url=${encodeURIComponent(address)}`);
    assert.equal(refused.response.status, 400, address);
    assert.equal(refused.payload.error, 'La dirección de la foto no es válida. Debe empezar por https://.');
  }
  for (const address of ['https://127.0.0.1/a.jpg', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/a.jpg', 'https://192.168.1.10/a.jpg']) {
    const refused = await api(`/api/photo?url=${encodeURIComponent(address)}`);
    assert.equal(refused.response.status, 400, address);
    assert.equal(refused.payload.error, 'La dirección de la foto no es pública.');
  }
  assert.equal((await api('/api/photo')).response.status, 400);
  assert.equal((await api('/api/photo', { method: 'POST', body: {} })).response.status, 405);

  await stopServer();
  const asked = [];
  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);
  await startServer({
    fetchPhoto: async (address) => {
      asked.push(address);
      return { data: photo, type: 'image/jpeg' };
    },
  });
  const address = 'https://fotos.example/ana.jpg?talla=2&v=á';
  const served = await fetch(`${baseUrl}/api/photo?url=${encodeURIComponent(address)}`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.equal(served.headers.get('cache-control'), 'no-store');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), photo);
  assert.deepEqual(asked, [address]);

  // Another site cannot load images through this server.
  const foreign = await api(`/api/photo?url=${encodeURIComponent(address)}`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(foreign.response.status, 403);
  assert.equal(asked.length, 1);

  // Twelve downloads a minute for each visitor; the refused one above did not count.
  for (let index = asked.length; index < 12; index += 1) {
    assert.equal((await fetch(`${baseUrl}/api/photo?url=${encodeURIComponent(address)}`)).status, 200);
  }
  const limited = await api(`/api/photo?url=${encodeURIComponent(address)}`);
  assert.equal(limited.response.status, 429);
  assert.equal(asked.length, 12);
});
