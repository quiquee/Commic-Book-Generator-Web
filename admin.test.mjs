import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createAdminHandler } from './admin.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const base64 = jpeg.toString('base64');
const totals = (costUsd = 0) => ({
  calls: 3, errors: 1, tokens: { inputText: 10, inputImage: 20, outputText: 30, outputImage: 40, cached: 5, total: 100 },
  costUsd, uncostedCalls: 0,
});
const face = (index) => ({
  id: index ? `page-${index}` : 'cover', type: index === 0 ? 'cover' : index === 11 ? 'back_cover' : 'story',
  pageIndex: index, isLoading: false, isDecisionPage: false, choices: [],
  narrative: { caption: 'Texto', scene: 'Escena', privateToken: 'secret' },
  imageUrl: `data:image/jpeg;base64,${base64}`, privateToken: 'secret',
});

async function fixture(t, options = {}) {
  const directory = join(process.cwd(), `.admin-test-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = new Map([
    ['active', { id: 'active', title: 'Árbol de héroes', hostName: 'José', guestName: 'Ana', createdAt: 100,
      updatedAt: 300, ownerToken: 'OWNER_SECRET', readToken: 'READER_SECRET',
      hero: { base64 }, friend: { base64 }, settings: { genre: 'Fantasy', language: 'es-ES', premise: 'Idea', richMode: true, token: 'secret' },
      tone: 'Épico', styleGuide: 'Tinta', invitationId: 'invite', faces: [face(0), face(1)] }],
    ['complete', { id: 'complete', title: '=SUM(1,2)', hostName: '+Host', guestName: '@Guest', createdAt: 200,
      updatedAt: 200, hero: { base64 }, friend: null, faces: Array.from({ length: 12 }, (_, index) => face(index)) }],
  ]);
  const accounting = new Map([
    ['active', { totals: totals(1), byOperation: { page: totals(1) }, byModel: { test: totals(1) },
      events: [{ op: 'page', model: 'test', tokens: totals().tokens }], snapshot: null }],
    ['complete', { totals: totals(2), byOperation: {}, byModel: {}, events: [], snapshot: null }],
    ['deleted', { totals: totals(4), byOperation: {}, byModel: {}, events: [],
      snapshot: { id: 'deleted', title: 'Borrado', hostName: 'Antes', guestName: '', createdAt: 50, updatedAt: 70,
        completedPages: 4, hasFriend: false, deletedAt: 80, deletedBy: 'owner' } }],
  ]);
  const deleted = [];
  const usage = {
    getStory: (id) => accounting.get(id) ?? null,
    listStories: () => [...accounting].map(([id, value]) => ({ id, ...value })),
    overview: () => ({ totals: totals(7), today: totals(3), last7Days: totals(7), last30Days: totals(7),
      daily: [], draftsUnassigned: { calls: 0, costUsd: 0, tokens: totals().tokens } }),
    pricingStatus: () => ({ pricingConfigured: true, pricingVersion: 'test-v1',
      pricingModels: { test: { inputText: 1 } }, pricingChanges: [] }),
    priceUncosted: () => ({ priced: 2, costUsd: 0.5, remaining: 1 }),
  };
  const handler = createAdminHandler({
    adminPassword: 'correct', auditFile: join(directory, 'private', 'audit.jsonl'), usage,
    listActiveStories: () => [...active.values()], getStory: (id) => active.get(id) ?? null,
    deleteStoryById: (id, actor) => {
      const record = active.get(id);
      assert.ok(record);
      assert.equal(actor, 'admin');
      deleted.push(id);
      accounting.get(id).snapshot = { ...record, deletedAt: 400, deletedBy: actor, completedPages: record.faces.length };
      active.delete(id);
    },
    dailyBudgetUsd: 20, dailyTokenLimit: 1000,
    serveAdminPage: (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Admin</h1>'); },
    ...options,
  });
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(418); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init) => fetch(origin + path, { redirect: 'manual', ...init });
  const login = async (headers = {}) => {
    const response = await request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password: 'correct' }),
    });
    assert.equal(response.status, 200);
    return { response, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { request, login, active, accounting, deleted, directory };
}

test('disabled routes all return the Spanish 404 without serving the page', async (t) => {
  const { request } = await fixture(t, { adminPassword: undefined });
  for (const path of ['/admin', '/admin/', '/admin.html']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), /Panel de administración deshabilitado\./);
  }
  for (const path of ['/api/admin', '/api/admin/session', '/api/admin-anything']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Panel de administración deshabilitado.' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await request('/elsewhere')).status, 418);
});

test('production and dev static pages manage CSP independently', async (t) => {
  const { request } = await fixture(t);
  const redirect = await request('/admin/');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/admin');
  for (const path of ['/admin', '/admin.html']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  const dev = await fixture(t, { dev: true });
  assert.equal((await dev.request('/admin')).headers.get('content-security-policy'), null);
});

test('login strictly validates the password object and enforces per-IP lockout', async (t) => {
  const { request, login } = await fixture(t, { trustProxy: true });
  for (const value of [{}, { password: 4 }, { password: 'correct', role: 'admin' }, [], null]) {
    const response = await request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    assert.equal(response.status, 400);
  }
  for (let index = 0; index < 5; index++) {
    assert.equal((await request('/api/admin/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.1' },
      body: '{"password":"wrong"}' })).status, 401);
  }
  const locked = await request('/api/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.1' }, body: '{"password":"correct"}' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  const { response } = await login({ 'X-Forwarded-For': '192.0.2.2', 'X-Forwarded-Proto': 'https' });
  assert.match(response.headers.get('set-cookie'), /; Secure/);
});

test('cookies authenticate exclusively, reject tampering, and logout revokes copies', async (t) => {
  const { request, login } = await fixture(t);
  assert.deepEqual(await (await request('/api/admin/session')).json(), { authenticated: false });
  for (const path of ['/api/admin/overview', '/api/admin/stories', '/api/admin/stories/active',
    '/api/admin/stories/active/image/hero', '/api/admin/usage.csv']) {
    assert.equal((await request(path, { headers: { Authorization: 'Bearer OWNER_SECRET', 'X-Owner-Token': 'OWNER_SECRET' } })).status, 401);
  }
  const { response, cookie } = await login({ 'X-Forwarded-Proto': 'https' });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/);
  assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/);
  assert.deepEqual(await (await request('/api/admin/session', { headers: { Cookie: cookie } })).json(), { authenticated: true });
  assert.equal((await request('/api/admin/overview', { headers: { Cookie: cookie + '0' } })).status, 401);
  assert.equal((await request('/api/admin/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const logout = await request('/api/admin/logout', { method: 'POST', headers: { Cookie: cookie, 'X-Admin-Request': '1' } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/admin/overview', { headers: { Cookie: cookie } })).status, 401);
});

test('sessions expire after eight hours and signatures are unique per handler', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const { cookie } = await first.login();
  assert.equal((await second.request('/api/admin/overview', { headers: { Cookie: cookie } })).status, 401);
  const originalNow = Date.now;
  const later = originalNow() + 8 * 60 * 60 * 1000 + 1;
  Date.now = () => later;
  try {
    assert.deepEqual(await (await first.request('/api/admin/session', { headers: { Cookie: cookie } })).json(), { authenticated: false });
    assert.equal((await first.request('/api/admin/overview', { headers: { Cookie: cookie } })).status, 401);
  } finally {
    Date.now = originalNow;
  }
});

test('lockouts expire and untrusted forwarded IPs cannot bypass them', async (t) => {
  const { request, login, directory } = await fixture(t);
  for (let index = 0; index < 5; index++) {
    assert.equal((await request('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${index}` },
      body: '{"password":"wrong"}',
    })).status, 401);
  }
  const blocked = await request('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.99' },
    body: '{"password":"correct"}',
  });
  assert.equal(blocked.status, 429);
  const originalNow = Date.now;
  const later = originalNow() + 15 * 60 * 1000 + 1;
  Date.now = () => later;
  try {
    await login();
  } finally {
    Date.now = originalNow;
  }
  const entries = (await readFile(join(directory, 'private', 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter((entry) => entry.action === 'login_fail').length, 5);
  assert.ok(entries.every((entry) => entry.ip === '127.0.0.1'));
});

test('overview includes retained accounting, story counts, budgets and pricing', async (t) => {
  const { request, login } = await fixture(t);
  const { cookie } = await login();
  const result = await (await request('/api/admin/overview', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(result.stories, { total: 3, active: 2, deleted: 1, complete: 1, inProgress: 1 });
  assert.deepEqual(result.budget, { dailyBudgetUsd: 20, dailyTokenLimit: 1000, todayCostUsd: 3, todayTokens: 100 });
  assert.equal(result.pricingConfigured, true);
  assert.equal(result.pricingVersion, 'test-v1');
  assert.deepEqual(result.pricingModels, { test: { inputText: 1 } });
  assert.deepEqual(result.pricingChanges, []);
  assert.equal(result.totals.costUsd, 7);
});

test('listing filters, sorting, pagination and strict query validation', async (t) => {
  const { request, login } = await fixture(t);
  const { cookie } = await login();
  const list = async (query = '') => {
    const response = await request('/api/admin/stories' + query, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const all = await list();
  assert.equal(all.total, 3);
  assert.equal(all.page, 1);
  assert.equal(all.pageSize, 20);
  assert.equal(all.items[0].id, 'complete');
  assert.equal(all.items.find((item) => item.id === 'active').completedPages, 2);
  assert.equal(all.items.find((item) => item.id === 'active').totalPages, 12);
  for (const query of ['?query=ARBOL', '?query=jose', '?status=in_progress']) {
    assert.deepEqual((await list(query)).items.map((item) => item.id), ['active']);
  }
  assert.deepEqual((await list('?status=deleted')).items.map((item) => item.id), ['deleted']);
  assert.deepEqual((await list('?status=complete')).items.map((item) => item.id), ['complete']);
  assert.equal((await list('?sort=cost&order=desc&page=2&pageSize=1')).items[0].id, 'complete');
  assert.equal((await list('?sort=updatedAt&order=asc')).items[0].id, 'deleted');
  assert.equal((await list('?sort=title&order=asc')).items[0].id, 'complete');
  for (const query of ['?foo=bar', '?page=0', '?page=-1', '?page=1.5', '?page=1e2', '?pageSize=101',
    '?pageSize=0', '?pageSize=2.5', '?status=other', '?order=up', '?sort=token', '?query=a&query=b']) {
    assert.equal((await request('/api/admin/stories' + query, { headers: { Cookie: cookie } })).status, 400, query);
  }
  const text = JSON.stringify(all);
  assert.doesNotMatch(text, /OWNER_SECRET|READER_SECRET|base64|imageUrl/);
});

test('detail whitelists safe fields and images are private binary JPEGs', async (t) => {
  const { request, login } = await fixture(t);
  const { cookie } = await login();
  const headers = { Cookie: cookie };
  const detail = await (await request('/api/admin/stories/active', { headers })).json();
  assert.equal(detail.id, 'active');
  assert.equal(detail.faces.length, 2);
  assert.equal(detail.faces[0].hasImage, true);
  assert.deepEqual(detail.faces[0].narrative, { caption: 'Texto', scene: 'Escena' });
  assert.equal(detail.usage.totals.costUsd, 1);
  assert.deepEqual(detail.usage.byModel.test, totals(1));
  assert.doesNotMatch(JSON.stringify(detail), /OWNER_SECRET|READER_SECRET|base64|imageUrl|privateToken|"token"/);
  for (const which of ['hero', 'friend', 'cover', 'page-1']) {
    const response = await request('/api/admin/stories/active/image/' + which, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
    assert.match(response.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  }
  for (const path of ['/active/image/page11', '/active/image/page12', '/complete/image/friend', '/missing', '/deleted/image/hero']) {
    assert.equal((await request('/api/admin/stories' + path, { headers })).status, 404);
  }
  const deleted = await (await request('/api/admin/stories/deleted', { headers })).json();
  assert.deepEqual(deleted.faces, []);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.usage.totals.costUsd, 4);
});

test('CSV has BOM, exact columns, quoting, and neutralizes formula cells', async (t) => {
  const { request, login } = await fixture(t);
  const { cookie } = await login();
  const response = await request('/api/admin/usage.csv', { headers: { Cookie: cookie } });
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="usage-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  assert.equal(text.split('\r\n')[0], '\ufeffid,title,host,guest,status,createdAt,deletedAt,calls,errors,inputText,inputImage,outputText,outputImage,cached,totalTokens,costUsd,shares,opens,seriesId,issue');
  assert.ok(text.includes(`"'=SUM(1,2)"`));
  assert.ok(text.includes(`"'+Host"`));
  assert.ok(text.includes(`"'@Guest"`));
  assert.ok(text.includes('"deleted"'));
  assert.doesNotMatch(text, /OWNER_SECRET|base64/);
});

test('pricing the calls without a cost needs a session and the admin header, and is audited', async (t) => {
  const { request, login, directory } = await fixture(t);
  assert.equal((await request('/api/admin/usage/price', { method: 'POST', headers: { 'X-Admin-Request': '1' } })).status, 401);
  const { cookie } = await login();
  assert.equal((await request('/api/admin/usage/price', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request('/api/admin/usage/price', { headers: { Cookie: cookie } })).status, 404);
  const response = await request('/api/admin/usage/price', { method: 'POST', headers: { Cookie: cookie, 'X-Admin-Request': '1' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { priced: 2, costUsd: 0.5, remaining: 1 });
  const lines = (await readFile(join(directory, 'private', 'audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.filter((entry) => entry.action === 'usage_price').length, 1);
});

test('deletion requires mutation protections, retains usage and audits privately', async (t) => {
  const { request, login, deleted, directory } = await fixture(t);
  const { cookie } = await login();
  const headers = { Cookie: cookie, 'X-Admin-Request': '1' };
  assert.equal((await request('/api/admin/stories/active', { method: 'DELETE', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request('/api/admin/stories/active', { method: 'DELETE', headers, body: '{}' })).status, 403);
  assert.equal((await request('/api/admin/stories/active', { method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  await request('/api/admin/stories/active', { headers });
  await request('/api/admin/stories/active/image/hero', { headers });
  await request('/api/admin/stories/active/image/cover', { headers });
  await request('/api/admin/usage.csv', { headers });
  const response = await request('/api/admin/stories/active', { method: 'DELETE', headers });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.deepEqual(deleted, ['active']);
  assert.equal((await request('/api/admin/stories/active', { method: 'DELETE', headers })).status, 404);
  const detail = await (await request('/api/admin/stories/active', { headers })).json();
  assert.equal(detail.status, 'deleted');
  assert.equal(detail.deletedBy, 'admin');
  assert.equal(detail.usage.totals.costUsd, 1);
  assert.deepEqual(detail.faces, []);
  assert.equal((await request('/api/admin/stories/active/image/hero', { headers })).status, 404);
  await request('/api/admin/logout', { method: 'POST', headers });
  const auditPath = join(directory, 'private', 'audit.jsonl');
  const lines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.filter((entry) => entry.action === 'image_view').length, 1);
  for (const action of ['login_ok', 'logout', 'story_view', 'image_view', 'story_delete', 'csv_export']) {
    assert.ok(lines.some((entry) => entry.action === action), action);
  }
  for (const entry of lines) {
    assert.ok(Number.isFinite(Date.parse(entry.ts)));
    assert.ok(entry.ip);
    assert.deepEqual(Object.keys(entry).sort(), (entry.storyId ? ['ts', 'action', 'ip', 'storyId'] : ['ts', 'action', 'ip']).sort());
  }
  assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
});

test('continuing a comic hands its owner key only to a logged-in admin request and audits it', async (t) => {
  const { request, login, directory } = await fixture(t);
  const path = '/api/admin/stories/active/continue';
  assert.equal((await request(path, { method: 'POST', headers: { 'X-Admin-Request': '1' } })).status, 401);
  const { cookie } = await login();
  assert.equal((await request(path, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 404);
  const missing = await request('/api/admin/stories/nope/continue', { method: 'POST', headers: { Cookie: cookie, 'X-Admin-Request': '1' } });
  assert.equal(missing.status, 404);
  const granted = await request(path, { method: 'POST', headers: { Cookie: cookie, 'X-Admin-Request': '1' } });
  assert.equal(granted.status, 200);
  assert.deepEqual(await granted.json(), { id: 'active', ownerToken: 'OWNER_SECRET' });
  const entries = (await readFile(join(directory, 'private', 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.filter((entry) => entry.action === 'story_continue').map((entry) => entry.storyId), ['active']);
});

test('any /admin/... address lands on the panel, and a disabled panel answers with a page, not a download', async (t) => {
  const { request } = await fixture(t);
  for (const [path, target] of [['/admin/', '/admin'], ['/admin/comics', '/admin#/stories'], ['/admin/series', '/admin#/series'], ['/admin/log/', '/admin#/log'], ['/admin/anything/else', '/admin']]) {
    const response = await request(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), target, path);
  }
  const page = await request('/admin');
  assert.equal(page.headers.get('content-disposition'), 'inline');

  const disabled = await fixture(t, { adminPassword: '' });
  const html = await disabled.request('/admin/comics', { headers: { accept: 'text/html' } });
  assert.equal(html.status, 404);
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.equal(html.headers.get('content-disposition'), 'inline');
  assert.match(await html.text(), /deshabilitado/);
  const api = await disabled.request('/api/admin/session');
  assert.match(api.headers.get('content-type'), /^application\/json/);
});

test('series group the comics: issues, alternative versions, copies, owners, pages and cost', async (t) => {
  const { request, login, active, accounting, directory } = await fixture(t);
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const add = (n, title, ownerToken, series, { pages = 12, direction } = {}) => {
    active.set(uuid(n), { id: uuid(n), title, hostName: 'Lucía', guestName: '', createdAt: 1000 + n, updatedAt: 2000 + n,
      ownerToken, hero: { base64 }, friend: null, faces: Array.from({ length: pages }, (_, index) => face(index)),
      series: { id: uuid(1), ...series }, ...(direction ? { continuation: { fromId: uuid(2), issue: 3, recap: 'Antes', direction } } : {}) });
    accounting.set(uuid(n), { totals: totals(n), byOperation: {}, byModel: {}, events: [], snapshot: null });
  };
  add(1, 'El faro', 'OWNER_A', { issue: 1, originId: uuid(1), parentOriginId: null });
  add(2, 'El faro #2', 'OWNER_A', { issue: 2, originId: uuid(2), parentOriginId: uuid(1) });
  add(3, 'El faro #3', 'OWNER_A', { issue: 3, originId: uuid(3), parentOriginId: uuid(2) }, { pages: 5, direction: 'Vuelven al faro' });
  add(4, 'El faro', 'OWNER_B', { issue: 1, originId: uuid(1), parentOriginId: null });
  add(5, 'El faro #2', 'OWNER_B', { issue: 2, originId: uuid(2), parentOriginId: uuid(1) });
  add(6, 'El faro #3: la tormenta', 'OWNER_B', { issue: 3, originId: uuid(6), parentOriginId: uuid(2) }, { direction: 'Se van en barco' });
  const { cookie } = await login();
  const headers = { Cookie: cookie };
  const get = async (path, status = 200) => {
    const response = await request('/api/admin' + path, { headers });
    assert.equal(response.status, status, path);
    return response.json();
  };

  const list = await get('/series?sort=cost&order=desc');
  assert.equal(list.total, 3);
  const [faro] = list.items;
  assert.deepEqual([faro.id, faro.title, faro.issues, faro.versions, faro.comics, faro.pages, faro.complete, faro.coverId],
    [uuid(1), 'El faro', 3, 1, 6, 41, 5, uuid(1)]);
  assert.equal(faro.owners.length, 2);
  assert.deepEqual(faro.cast, ['Lucía']);
  assert.equal(faro.usage.costUsd, 21);
  assert.equal(faro.usage.tokens.total, 600);
  assert.deepEqual([faro.createdAt, faro.updatedAt], [1001, 2006]);
  assert.equal(faro.nodes, undefined);
  // A comic without series data is a series of one.
  assert.deepEqual(list.items.slice(1).map((item) => [item.id, item.issues, item.comics]), [['complete', 1, 1], ['active', 1, 1]]);
  assert.deepEqual((await get('/series?query=tormenta')).items.map((item) => item.id), [uuid(1)]);
  assert.deepEqual((await get(`/series?query=${encodeURIComponent(faro.owners[1])}`)).items.map((item) => item.id), [uuid(1)]);
  assert.deepEqual((await get('/series?sort=title&order=asc&pageSize=1&page=2')).items.map((item) => item.id), ['active']);
  for (const query of ['?status=all', '?sort=pages', '?page=0', '?foo=1']) await get('/series' + query, 400);

  const page = await get('/series/' + uuid(1));
  assert.deepEqual(page.nodes.map((node) => [node.issue, node.depth, node.originId, node.comics.map((comic) => comic.id)]), [
    [1, 0, uuid(1), [uuid(1), uuid(4)]],
    [2, 1, uuid(2), [uuid(2), uuid(5)]],
    [3, 2, uuid(3), [uuid(3)]],
    [3, 2, uuid(6), [uuid(6)]],
  ]);
  assert.deepEqual(page.nodes.map((node) => node.direction), ['', '', 'Vuelven al faro', 'Se van en barco']);
  assert.deepEqual(page.nodes[0].comics.map((comic) => [comic.original, comic.ownerAlias === faro.owners[0], comic.usage.costUsd]), [[true, true, 1], [false, false, 4]]);
  assert.equal(page.nodes[2].comics[0].status, 'in_progress');
  assert.doesNotMatch(JSON.stringify([list, page]), /OWNER_A|OWNER_B|base64|imageUrl/);
  await get('/series/nope', 404);
  assert.equal((await request('/api/admin/series')).status, 401);

  // A comic knows the issue before it, the ones after it and its copies; its owner's comics are preferred.
  const second = (await get('/stories/' + uuid(5))).series;
  assert.deepEqual([second.id, second.title, second.issue, second.issues, second.comics], [uuid(1), 'El faro', 2, 3, 6]);
  assert.equal(second.previous.id, uuid(4));
  assert.deepEqual(second.next.map((comic) => [comic.id, comic.issue, comic.completedPages]), [[uuid(3), 3, 5], [uuid(6), 3, 12]]);
  assert.deepEqual(second.copies.map((comic) => comic.id), [uuid(2)]);
  assert.equal(second.copies[0].ownerAlias, faro.owners[0]);
  const lone = (await get('/stories/active')).series;
  assert.deepEqual([lone.id, lone.issue, lone.comics, lone.previous, lone.next, lone.copies], ['active', 1, 1, null, [], []]);
  assert.equal((await get('/stories/deleted')).series, undefined);

  const flat = await get('/stories?query=tormenta');
  assert.deepEqual(flat.items[0].series, { id: uuid(1), issue: 3, originId: uuid(6), parentOriginId: uuid(2), comics: 6 });
  assert.equal((await get('/stories?status=deleted')).items[0].series, undefined);
  const csv = await (await request('/api/admin/usage.csv', { headers })).text();
  assert.ok(csv.includes(`"0","0","${uuid(1)}","3"`));
  const audit = (await readFile(join(directory, 'private', 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter((entry) => entry.action === 'series_view').length, 1);
});

test('the application can pass its own series index, which also places comics without stored data', async (t) => {
  const { request, login, active } = await fixture(t, {
    listSeries: () => [
      { id: 'active', title: 'Árbol de héroes', ownerToken: 'OWNER_SECRET', createdAt: 100, completedPages: 2,
        series: { id: 'active', issue: 1, originId: 'active', parentOriginId: null } },
      { id: 'complete', title: '=SUM(1,2)', ownerToken: '', createdAt: 200, completedPages: 12,
        series: { id: 'active', issue: 2, originId: 'complete', parentOriginId: 'active' } },
    ],
  });
  assert.equal(active.size, 2);
  const { cookie } = await login();
  const headers = { Cookie: cookie };
  const list = await (await request('/api/admin/series', { headers })).json();
  assert.deepEqual(list.items.map((item) => [item.id, item.issues, item.comics, item.pages]), [['active', 2, 2, 14]]);
  const detail = await (await request('/api/admin/stories/complete', { headers })).json();
  assert.equal(detail.series.previous.id, 'active');
  assert.equal(detail.series.copies.length, 0);
});
