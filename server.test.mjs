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
    auditFile: join(dataDir, 'audit.log'), ...options,
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

test('supports linked stories, participant choices, incremental reads, persistence and deletion', async () => {
  const invitation = await createInvitation();
  const invitationPath = `/api/invitations/${invitation.payload.id}`;
  const created = await api('/api/stories', {
    method: 'POST',
    body: storyBody({ id: invitation.payload.id, ownerToken: invitation.payload.ownerToken }),
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
  assert.equal(initial.payload.hero.base64, JPEG);
  assert.equal(initial.payload.friend, null);

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
  const invitation = (await createInvitation()).payload;
  const story = (await api('/api/stories', {
    method: 'POST',
    body: { ...storyBody({ id: invitation.id, ownerToken: invitation.ownerToken }), draftId },
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
