import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUsageStore, normalizeUsage } from './usage.mjs';
import { createGeminiProxy } from './geminiProxy.mjs';

const model = 'gemini-3.8-flash';
const storyId = 'd70aaa1b-33e1-4cd2-aef9-87a379a2d2cd';
const imageResponse = {
  usageMetadata: {
    promptTokenCount: 43, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 43 }],
    candidatesTokenCount: 1498, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }],
    thoughtsTokenCount: 1317, totalTokenCount: 2858,
  },
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] } }],
};
const textResponse = { usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 20,
  thoughtsTokenCount: 813, totalTokenCount: 847 } };
const event = (response = textResponse, extras = {}) => ({ model, op: 'story:1', ok: true, httpStatus: 200, latencyMs: 10, response, ...extras });
const priceData = { version: 'v1', currency: 'USD', models: { [model]: { inputText: 1, inputImage: 2, outputText: 3, outputImage: 4 } } };

async function fixture(t) {
  const directory = join(process.cwd(), `.usage-test-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const options = { usageDir: join(directory, 'usage'), pricingFile: join(directory, 'prices.json') };
  await writeFile(options.pricingFile, JSON.stringify(priceData));
  const usage = createUsageStore(options);
  t.after(async () => {
    await usage.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, options, usage };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function proxyFixture(t, overrides = {}) {
  const data = await fixture(t);
  const requests = [];
  let respond = (_req, res) => res.end(JSON.stringify(textResponse));
  const upstream = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    respond(req, res);
  });
  const handle = createGeminiProxy({ usage: data.usage,
    loadStory: async (id) => id === storyId ? { ownerToken: 'owner-secret', guestToken: 'guest-secret' } : null,
    geminiApiKey: 'upstream-secret', geminiUpstream: upstream.url, ...overrides });
  const downstream = await listen(t, (req, res) => handle(req, res, new URL(req.url, 'http://localhost')));
  const route = `/api/gemini/v1beta/models/${model}:generateContent`;
  const draftId = randomUUID();
  const api = (options = {}) => fetch(downstream.url + (options.path ?? route), {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-draft-id': draftId, ...options.headers },
    body: options.method === 'GET' ? undefined : options.body ?? JSON.stringify({ contents: [] }),
  });
  return { ...data, requests, api, draftId, downstream, route, respond: (handler) => { respond = handler; } };
}

test('normalizes real image/text, fallback, unknown modalities, missing and failure usage', () => {
  assert.deepEqual(normalizeUsage(imageResponse), { tokens: {
    inputText: 43, inputImage: 0, outputText: 1695, outputImage: 1120, cached: 0, total: 2858,
  }, images: 1 });
  assert.deepEqual(normalizeUsage({ usageMetadata: {
    promptTokenCount: 999, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 43 },
      { modality: 'IMAGE', tokenCount: 1498 }], totalTokenCount: 5,
  } }).tokens, { inputText: 43, inputImage: 1498, outputText: 0, outputImage: 0, cached: 0, total: 5 });
  assert.deepEqual(normalizeUsage(textResponse).tokens, {
    inputText: 14, inputImage: 0, outputText: 833, outputImage: 0, cached: 0, total: 847,
  });
  assert.equal(normalizeUsage({ usageMetadata: { promptTokensDetails: [
    { modality: 'AUDIO', tokenCount: 4 }, { modality: 'TEXT', tokenCount: 3 }],
  candidatesTokenCount: 2, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 5 }],
  thoughtsTokenCount: 1, cachedContentTokenCount: 8 } }).tokens.total, 13);
  assert.equal(normalizeUsage({}, true).tokens.total, 0);
  assert.equal(normalizeUsage(imageResponse, false).tokens.total, 0);
  assert.equal(normalizeUsage(imageResponse, false).images, 0);
});

test('queues writes, prices counters, preserves failures and blocked calls, private atomic persistence', async (t) => {
  const { usage, options } = await fixture(t);
  assert.equal(await usage.getStory('missing'), null);
  assert.equal(await usage.getDraft('missing'), null);
  await Promise.all(Array.from({ length: 12 }, () => usage.record({ type: 'story', id: 'one' }, event())));
  await usage.record({ type: 'story', id: 'one' }, event(imageResponse, { ok: false, httpStatus: 500 }));
  await usage.record({ type: 'story', id: 'one' }, event({ promptFeedback: { blockReason: 'SAFETY' } }));
  const story = await usage.getStory('one');
  assert.equal(story.totals.calls, 14);
  assert.equal(story.totals.errors, 1);
  assert.equal(story.totals.tokens.total, 12 * 847);
  assert.ok(Math.abs(story.totals.costUsd - 12 * (14 + 833 * 3) / 1e6) < 1e-12);
  assert.equal(story.byOperation['story:1'].calls, 14);
  assert.equal(story.byModel[model].calls, 14);
  assert.equal(story.events[12].tokens.total, 0);
  assert.equal(story.events[13].costUsd, 0);
  story.totals.calls = 99;
  assert.equal((await usage.getStory('one')).totals.calls, 14);
  assert.equal((await stat(options.usageDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(options.usageDir, 'usage.json'))).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(join(options.usageDir, 'one.json'), 'utf8'));
  assert.deepEqual(persisted.scope, { type: 'story', id: 'one' });
  assert.equal(persisted.events[0].page, 1);
  assert.equal(persisted.events[0].priceVersion, 'v1');
  assert.equal(typeof persisted.events[0].ts, 'string');
  const dailyFile = JSON.parse(await readFile(join(options.usageDir, '_daily.json'), 'utf8'));
  assert.equal(dailyFile.days[new Date().toISOString().slice(0, 10)].calls, 14);
  assert.deepEqual((await createUsageStore(options).getStory('one')).totals, (await usage.getStory('one')).totals);
  const overview = await usage.overview();
  assert.equal(overview.daily.length, 30);
  assert.equal(overview.today.calls, 14);
  assert.equal(overview.last7Days.calls, 14);
  assert.equal(overview.last30Days.calls, 14);
});

test('re-reads pricing, requires only used rates, ignores cached pricing and counts uncosted successes', async (t) => {
  const { usage, options } = await fixture(t);
  const scope = { type: 'draft', id: 'draft' };
  assert.deepEqual(await usage.pricingStatus(), { pricingConfigured: true, pricingVersion: 'v1' });
  await writeFile(options.pricingFile, JSON.stringify({ version: 'text-only', currency: 'USD',
    models: { [model]: { inputText: 2, outputText: 4 } } }));
  const first = await usage.record(scope, event({ usageMetadata: { ...textResponse.usageMetadata, cachedContentTokenCount: 100 } }));
  assert.ok(Math.abs(first.costUsd - (14 * 2 + 833 * 4) / 1e6) < 1e-12);
  assert.equal((await usage.record(scope, event(imageResponse))).costUsd, null);
  await writeFile(options.pricingFile, '{"invalid":true}');
  assert.deepEqual(await usage.pricingStatus(), { pricingConfigured: false, pricingVersion: null });
  assert.equal((await usage.record(scope, event())).costUsd, null);
  await usage.record(scope, event(textResponse, { ok: false }));
  assert.equal((await usage.getDraft('draft')).totals.uncostedCalls, 2);
  await rm(options.pricingFile);
  assert.equal((await usage.pricingStatus()).pricingConfigured, false);
});

test('adoption is persisted and idempotent, redirects late records, never recounts daily and preserves deletion snapshot', async (t) => {
  const { usage, options } = await fixture(t);
  await usage.record({ type: 'draft', id: 'draft' }, event(textResponse, { op: 'constructor' }));
  await usage.record({ type: 'story', id: 'story' }, event(imageResponse));
  await usage.adoptDraft('draft', 'story');
  const restored = createUsageStore(options);
  await restored.adoptDraft('draft', 'story');
  assert.equal((await restored.getStory('story')).totals.calls, 2);
  assert.equal((await restored.overview()).today.calls, 2);
  assert.equal((await restored.overview()).draftsUnassigned.count, 0);
  await assert.rejects(restored.adoptDraft('draft', 'other'), /already adopted/);
  await restored.record({ type: 'draft', id: 'draft' }, event());
  const snapshot = { title: 'Deleted title' };
  await restored.markDeleted('story', snapshot);
  const story = await restored.getStory('story');
  assert.deepEqual(story.snapshot, snapshot);
  assert.ok(story.deletedAt);
  assert.equal(story.totals.calls, 3);
  assert.equal((await restored.listStories()).length, 1);
  assert.equal((await restored.overview()).today.calls, 3);
  assert.equal((await restored.adoptDraft('absent', 'story')).id, 'story');
});

test('startup purges old drafts and daily buckets, keeps totals and only last 500 events', async (t) => {
  const { usage, options } = await fixture(t);
  await usage.record({ type: 'draft', id: 'old' }, event());
  await usage.record({ type: 'draft', id: 'recent' }, event());
  const file = join(options.usageDir, 'usage.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.drafts.old.updatedAt = '2020-01-01T00:00:00Z';
  state.daily['2020-01-01'] = state.totals;
  state.drafts.recent.events = Array.from({ length: 500 }, () => state.drafts.recent.events[0]);
  await writeFile(file, JSON.stringify(state));
  const restored = createUsageStore(options);
  assert.equal(await restored.getDraft('old'), null);
  assert.ok(await restored.getDraft('recent'));
  await restored.record({ type: 'draft', id: 'recent' }, event());
  assert.equal((await restored.getDraft('recent')).events.length, 500);
  assert.equal((await restored.overview()).totals.calls, 3);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).daily['2020-01-01'], undefined);
  await assert.rejects(restored.record({ type: 'story', id: '__proto__' }, event()), /Invalid/);
});

test('proxy validates route, method, auth, model and body without calling upstream', async (t) => {
  const fixture = await proxyFixture(t);
  assert.equal((await fixture.api({ path: '/unrelated' })).status, 404);
  assert.equal((await fixture.api({ method: 'GET' })).status, 405);
  assert.equal((await fixture.api({ path: fixture.route.replace(model, 'unknown') })).status, 400);
  assert.equal((await fixture.api({ headers: { 'x-draft-id': 'not-uuid' } })).status, 401);
  assert.equal((await fixture.api({ headers: { 'x-story-id': storyId, 'x-story-token': 'guest-secret' } })).status, 401);
  assert.equal((await fixture.api({ headers: { 'x-story-id': 'missing', 'x-story-token': 'owner-secret' } })).status, 401);
  const noCredentials = await fetch(fixture.downstream.url + fixture.route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(noCredentials.status, 401);
  assert.equal((await fixture.api({ body: '{' })).status, 400);
  assert.equal((await fixture.api({ body: '[]' })).status, 400);
  assert.equal((await fixture.api({ body: JSON.stringify({ data: 'a'.repeat(12 * 1024 * 1024) }) })).status, 413);
  assert.equal(fixture.requests.length, 0);
  assert.equal((await fixture.usage.overview()).totals.calls, 0);
});

test('proxy missing key is an exact Google-style 503', async (t) => {
  const fixture = await proxyFixture(t, { geminiApiKey: '' });
  const response = await fixture.api();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 503,
    message: 'GEMINI_API_KEY no configurada en el servidor.', status: 'UNAVAILABLE' } });
});

test('proxy sends only server credentials, records image, text, blocked and failed responses and sanitizes secrets', async (t) => {
  const fixture = await proxyFixture(t);
  fixture.respond((_req, res) => res.end(JSON.stringify(imageResponse)));
  assert.equal((await fixture.api({ headers: { 'x-story-id': storyId, 'x-story-token': 'owner-secret',
    'x-usage-op': 'render:12', authorization: 'Bearer client-secret', 'x-goog-api-key': 'client-secret' } })).status, 200);
  const upstream = fixture.requests[0];
  assert.equal(upstream.headers['x-goog-api-key'], 'upstream-secret');
  assert.equal(upstream.headers.authorization, undefined);
  assert.equal(upstream.headers['x-story-token'], undefined);
  assert.equal(upstream.headers['x-draft-id'], undefined);
  assert.equal(upstream.url, `/v1beta/models/${model}:generateContent`);
  assert.deepEqual(upstream.body, { contents: [] });
  assert.equal((await fixture.usage.getStory(storyId)).events[0].op, 'render:12');
  fixture.respond((_req, res) => res.end(JSON.stringify(textResponse)));
  await fixture.api({ headers: { 'x-usage-op': 'bad OP' } });
  fixture.respond((_req, res) => res.end(JSON.stringify({
    usageMetadata: { promptTokenCount: 43, totalTokenCount: 43 },
    candidates: [{ finishReason: 'IMAGE_RECITATION' }],
  })));
  await fixture.api();
  fixture.respond((_req, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: 'bad upstream-secret', status: 'INTERNAL' }, usageMetadata: textResponse.usageMetadata }));
  });
  const failed = await fixture.api();
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify([...failed.headers]).includes('upstream-secret'), false);
  assert.equal((await failed.json()).error.message, 'bad [REDACTED]');
  const draft = await fixture.usage.getDraft(fixture.draftId);
  assert.equal(draft.totals.calls, 3);
  assert.equal(draft.totals.errors, 1);
  assert.equal(draft.totals.tokens.total, 890);
  assert.equal(draft.events[0].op, 'other');
  assert.equal((await readFile(join(fixture.options.usageDir, 'usage.json'), 'utf8')).includes('upstream-secret'), false);
});

test('timeout and invalid upstream responses are sanitized failures with zero usage', async (t) => {
  const fixture = await proxyFixture(t, { upstreamTimeoutMs: 30 });
  fixture.respond((_req, _res) => {});
  assert.equal((await fixture.api()).status, 504);
  fixture.respond((_req, res) => res.end('not JSON upstream-secret'));
  const response = await fixture.api();
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('upstream-secret'), false);
  fixture.respond((_req, res) => {
    res.statusCode = 500;
    res.end('upstream-secret no está disponible');
  });
  const plainFailure = await fixture.api();
  assert.equal(plainFailure.status, 500);
  assert.equal((await plainFailure.text()).includes('upstream-secret'), false);
  const totals = (await fixture.usage.getDraft(fixture.draftId)).totals;
  assert.equal(totals.errors, 3);
  assert.equal(totals.tokens.total, 0);
});

test('accepted upstream work finishes and records after downstream disconnect', async (t) => {
  const fixture = await proxyFixture(t);
  let arrived;
  const ready = new Promise((resolve) => { arrived = resolve; });
  let finish;
  fixture.respond((_req, res) => {
    finish = () => res.end(JSON.stringify(imageResponse));
    arrived();
  });
  const req = request(fixture.downstream.url + fixture.route, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-draft-id': fixture.draftId } });
  req.on('error', () => {});
  req.end(JSON.stringify({ contents: [] }));
  await ready;
  req.destroy();
  finish();
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fixture.usage.getDraft(fixture.draftId))?.totals.calls === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await fixture.usage.getDraft(fixture.draftId)).totals.tokens.total, 2858);
});

test('daily budget and token limits reject before upstream calls', async (t) => {
  for (const limits of [{ dailyBudgetUsd: 0.001 }, { dailyTokenLimit: 1 }]) {
    const fixture = await proxyFixture(t, limits);
    await fixture.usage.record({ type: 'story', id: 'prior' }, event());
    const response = await fixture.api();
    assert.equal(response.status, 429);
    assert.match((await response.json()).error.message, /^LIMITE_DE_CONSUMO/);
    assert.equal(fixture.requests.length, 0);
  }
});

test('per-IP draft/story rates use separate windows and trust only configured forwarded IPs', async (t) => {
  const fixture = await proxyFixture(t, { trustProxy: true });
  for (let index = 0; index < 12; index++) assert.equal((await fixture.api()).status, 200);
  assert.equal((await fixture.api()).status, 429);
  assert.equal((await fixture.api({ headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.2' } })).status, 200);
  const ownerHeaders = { 'x-story-id': storyId, 'x-story-token': 'owner-secret' };
  for (let index = 0; index < 60; index++) assert.equal((await fixture.api({ headers: ownerHeaders })).status, 200);
  assert.equal((await fixture.api({ headers: ownerHeaders })).status, 429);
  const untrusted = await proxyFixture(t);
  for (let index = 0; index < 12; index++) {
    assert.equal((await untrusted.api({ headers: { 'x-forwarded-for': `192.0.2.${index}` } })).status, 200);
  }
  assert.equal((await untrusted.api({ headers: { 'x-forwarded-for': '192.0.2.99' } })).status, 429);
});
