import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ownerAlias } from './alias.ts';
import { groupSeries, seriesEntry, seriesTitle } from './series.mjs';

const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const COOKIE = 'admin_session';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const emptyTotals = () => ({
  calls: 0, errors: 0, costUsd: 0, uncostedCalls: 0,
  tokens: { inputText: 0, inputImage: 0, outputText: 0, outputImage: 0, cached: 0, total: 0 },
});
const addTotals = (sum, totals) => {
  for (const key of ['calls', 'errors', 'costUsd', 'uncostedCalls']) sum[key] += totals?.[key] ?? 0;
  for (const key of Object.keys(sum.tokens)) sum.tokens[key] += totals?.tokens?.[key] ?? 0;
  return sum;
};
const alone = (id) => ({ id, issue: 1, originId: id, parentOriginId: null });
const oldestFirst = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id));
const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const hash = (text) => createHash('sha256').update(text).digest();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/**
 * Isolated admin routes. Returns false for routes owned by the application.
 * Storage callbacks may be synchronous or asynchronous; deletion owns usage retention.
 */
export function createAdminHandler({
  adminPassword, trustProxy = false, auditFile, usage, geminiLog, listActiveStories, getStory,
  deleteStoryById, transferCopy = async () => null, dailyBudgetUsd = 0, dailyTokenLimit = 0, dev = false, serveAdminPage, resumeStory = () => {},
  // The series data of every active comic: series.mjs entries, each with its `series`. The application passes its
  // index, which also places comics made before series existed; without it only the stored data counts.
  listSeries = async () => (await listActiveStories()).map((record) => {
    const entry = seriesEntry(record);
    return { ...entry, series: entry.stored ?? alone(record.id) };
  }),
}) {
  const secret = randomBytes(32);
  const passwordHash = hash(adminPassword || '');
  const sessions = new Map();
  const failures = new Map();
  let auditQueue = Promise.resolve();
  const sign = (value) => createHmac('sha256', secret).update(value).digest('hex');
  const secure = (req) => req.socket?.encrypted || (trustProxy
    && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https');
  const cookie = (req, value, age) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure(req) ? '; Secure' : ''}`;
  const ipOf = (req) => trustProxy
    ? String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim()
    : req.socket?.remoteAddress ?? '';
  function sessionOf(req) {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
    const entries = String(req.headers.cookie ?? '').split(';').map((entry) => entry.trim());
    const value = entries.find((entry) => entry.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value || !/^[a-f0-9]{64}\.\d+\.[a-f0-9]{64}$/.test(value)) return null;
    const [id, expiry, signature] = value.split('.');
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(`${id}.${expiry}`), 'hex'))) return null;
    const session = sessions.get(id);
    return session && session.expires === Number(expiry) ? { id, ...session } : null;
  }
  function audit(action, req, storyId) {
    if (!auditFile) return Promise.resolve();
    const entry = JSON.stringify({ ts: new Date().toISOString(), action, ip: ipOf(req), ...(storyId ? { storyId } : {}) }) + '\n';
    const result = auditQueue.then(async () => {
      await mkdir(dirname(auditFile), { recursive: true, mode: 0o700 });
      await chmod(dirname(auditFile), 0o700);
      await appendFile(auditFile, entry, { mode: 0o600 });
      await chmod(auditFile, 0o600);
    });
    auditQueue = result.catch(() => {});
    return result;
  }
  function item(record, totals, deleted = false, series = null) {
    const completedPages = deleted ? (record.completedPages ?? 0)
      : (record.faces ?? []).filter((face) => face.imageUrl && !face.isLoading).length;
    return {
      ...pick(record, ['id', 'title', 'hostName', 'guestName', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy']),
      completedPages, totalPages: 12,
      ...(record.ownerToken ? { ownerAlias: ownerAlias(record.ownerToken) } : {}),
      status: deleted ? 'deleted' : completedPages >= 12 ? 'complete' : 'in_progress',
      hasFriend: record.hasFriend ?? !!record.friend, usage: totals ?? emptyTotals(),
      shares: record.sharing?.shares ?? 0, opens: record.sharing?.opens ?? 0,
      ...pick(record.sharing, ['lastSharedAt', 'lastOpenedAt']),
      ...(deleted ? {} : { hasCover: (record.faces ?? []).some((face) => face.id === 'cover' && !!face.imageUrl) }),
      ...(typeof record.continuation?.direction === 'string' && record.continuation.direction ? { direction: record.continuation.direction } : {}),
      ...(series ? { series: { ...series } } : {}),
    };
  }
  // Every comic: the active ones with their place in a series, then the deleted ones kept for the accounts.
  async function allStories() {
    const [active, stored, entries] = await Promise.all([listActiveStories(), usage.listStories(), listSeries()]);
    const accounting = new Map(stored.map((entry) => [entry.id, entry]));
    const planned = new Map(entries.map((entry) => [entry.id, entry.series]));
    const ids = new Set(active.map((record) => record.id));
    const items = active.map((record) => item(record, accounting.get(record.id)?.totals, false, planned.get(record.id) ?? alone(record.id)));
    const sizes = new Map();
    for (const entry of items) sizes.set(entry.series.id, (sizes.get(entry.series.id) ?? 0) + 1);
    for (const entry of items) entry.series.comics = sizes.get(entry.series.id);
    return [
      ...items,
      ...stored.filter((entry) => !ids.has(entry.id) && entry.snapshot)
        .map((entry) => item({ ...entry.snapshot, id: entry.id }, entry.totals, true)),
    ];
  }
  // The active comics grouped into series, with the issues of each in reading order (see groupSeries).
  function seriesOf(items) {
    const active = items.filter((entry) => entry.series);
    return groupSeries(active, new Map(active.map((entry) => [entry.id, entry.series]))).map((group) => {
      const comics = group.nodes.flatMap((node) => node.comics);
      return {
        id: group.id, title: seriesTitle(group.title) || group.title,
        // Issues are the different numbers; two issues with the same number are alternative versions,
        // and two comics holding the same issue are copies.
        // A copy has the pages of its original, so they are counted once.
        issues: group.issues, versions: group.nodes.length - group.issues, comics: group.comics,
        pages: group.nodes.reduce((sum, node) => sum + Math.max(...node.comics.map((entry) => entry.completedPages)), 0),
        complete: comics.filter((entry) => entry.status === 'complete').length,
        owners: [...new Set(comics.map((entry) => entry.ownerAlias).filter(Boolean))],
        cast: [...new Set(comics.flatMap((entry) => [entry.hostName, entry.guestName]).filter(Boolean))],
        createdAt: group.createdAt,
        updatedAt: Math.max(...comics.map((entry) => entry.updatedAt ?? entry.createdAt ?? 0)),
        ...pick({ coverId: comics.find((entry) => entry.hasCover)?.id }, ['coverId']),
        usage: comics.reduce((sum, entry) => addTotals(sum, entry.usage), emptyTotals()),
        nodes: group.nodes,
      };
    });
  }
  // Where an active comic sits in its series: the issue before it, the ones after it and its copies.
  // The comics of its own owner are preferred when an issue is held by several.
  async function placeOf(id) {
    const entries = await listSeries();
    const self = entries.find((entry) => entry.id === id);
    if (!self) return null;
    const same = entries.filter((entry) => entry.series.id === self.series.id).sort(oldestFirst);
    const brief = (entry) => ({
      id: entry.id, title: entry.title, issue: entry.series.issue, completedPages: entry.completedPages,
      ...(entry.ownerToken ? { ownerAlias: ownerAlias(entry.ownerToken) } : {}),
    });
    const holding = (originId) => same.filter((entry) => entry.series.originId === originId);
    const lead = (list) => list.find((entry) => entry.ownerToken === self.ownerToken) ?? list[0];
    const before = self.series.parentOriginId ? lead(holding(self.series.parentOriginId)) : null;
    const after = [...new Set(same.filter((entry) => entry.series.parentOriginId === self.series.originId
      && entry.series.originId !== self.series.originId).map((entry) => entry.series.originId))].map((originId) => lead(holding(originId)));
    const first = [...same].sort((a, b) => a.series.issue - b.series.issue || oldestFirst(a, b))[0];
    return {
      id: self.series.id, title: seriesTitle(first.title) || first.title, issue: self.series.issue,
      issues: new Set(same.map((entry) => entry.series.issue)).size, comics: same.length,
      previous: before ? brief(before) : null,
      next: after.map(brief),
      copies: holding(self.series.originId).filter((entry) => entry.id !== id).map(brief),
    };
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) fail(413, 'El cuerpo de la solicitud es demasiado grande.');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      fail(403, 'Se requiere contenido JSON.');
    }
    try { return JSON.parse(text); } catch { fail(400, 'El cuerpo JSON no es válido.'); }
  }
  function listOptions(params, allowed = ['query', 'status', 'sort', 'order', 'page', 'pageSize']) {
    for (const key of params.keys()) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(400, 'Los filtros no son válidos.');
    }
    const options = Object.fromEntries(params);
    const query = options.query ?? '';
    const status = options.status ?? 'all';
    const sort = options.sort ?? 'createdAt';
    const order = options.order ?? 'desc';
    const page = options.page ?? '1';
    const pageSize = options.pageSize ?? '20';
    if (query.length > 200 || !['all', 'in_progress', 'complete', 'deleted'].includes(status)
      || !['createdAt', 'updatedAt', 'cost', 'title'].includes(sort) || !['asc', 'desc'].includes(order)
      || !/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))
      || !/^[1-9]\d*$/.test(pageSize) || Number(pageSize) > 100) fail(400, 'Los filtros no son válidos.');
    return { query, status, sort, order, page: Number(page), pageSize: Number(pageSize) };
  }
  return async function handle(req, res, url = new URL(req.url, 'http://localhost')) {
    const path = url.pathname;
    const api = path.startsWith('/api/admin');
    // Any /admin/... address is a page too: known names jump to their view, the rest to the panel itself.
    const page = ['/admin', '/admin/', '/admin.html'].includes(path) || path.startsWith('/admin/');
    if (!api && !page) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, value) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
      return true;
    };
    try {
      if (!adminPassword) {
        if (!page) return json(404, { error: 'Panel de administración deshabilitado.' });
        // Browsers navigating here get a page, not a JSON file some of them would offer to download.
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline' });
        res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin</title>'
          + '<p style="font-family:sans-serif;padding:2rem">Panel de administración deshabilitado.</p>');
        return true;
      }
      if (page) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Método no permitido.');
        if (path.startsWith('/admin/')) {
          const target = { '/admin/comics': '/admin#/stories', '/admin/stories': '/admin#/stories', '/admin/series': '/admin#/series', '/admin/log': '/admin#/log' }[path.replace(/\/$/, '')] ?? '/admin';
          res.writeHead(302, { Location: target }); res.end(); return true;
        }
        res.setHeader('Content-Disposition', 'inline');
        if (!dev) {
          res.setHeader('Content-Security-Policy', CSP);
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('Referrer-Policy', 'no-referrer');
        }
        await serveAdminPage(req, res);
        return true;
      }
      if (path === '/api/admin/login' && req.method === 'POST') {
        const ip = ipOf(req);
        const now = Date.now();
        for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key);
        const attempts = failures.get(ip);
        if (attempts?.count >= 5) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((attempts.until - now) / 1000))));
          fail(429, 'Demasiados intentos. Inténtalo más tarde.');
        }
        const data = await body(req);
        if (!data || Array.isArray(data) || typeof data !== 'object'
          || Object.keys(data).length !== 1 || typeof data.password !== 'string') fail(400, 'La contraseña no es válida.');
        if (!timingSafeEqual(hash(data.password), passwordHash)) {
          failures.set(ip, { count: (attempts?.count ?? 0) + 1, until: attempts?.until ?? now + WINDOW_MS });
          await audit('login_fail', req);
          fail(401, 'Contraseña incorrecta.');
        }
        failures.delete(ip);
        const id = randomBytes(32).toString('hex');
        const expires = now + SESSION_MS;
        sessions.set(id, { expires, viewedImages: new Set() });
        const value = `${id}.${expires}`;
        res.setHeader('Set-Cookie', cookie(req, `${value}.${sign(value)}`, 28800));
        await audit('login_ok', req);
        return json(200, { authenticated: true });
      }
      const session = sessionOf(req);
      if (path === '/api/admin/session' && req.method === 'GET') return json(200, { authenticated: !!session });
      if (!session) fail(401, 'Sesión no iniciada o caducada.');
      if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method)) {
        if (req.headers['x-admin-request'] !== '1') fail(403, 'Solicitud de administración no válida.');
        await body(req);
      }
      if (path === '/api/admin/logout' && req.method === 'POST') {
        sessions.delete(session.id);
        res.setHeader('Set-Cookie', cookie(req, '', 0));
        await audit('logout', req);
        res.writeHead(204); res.end(); return true;
      }
      if (path === '/api/admin/overview' && req.method === 'GET') {
        const [overview, pricing, stories] = await Promise.all([usage.overview(), usage.pricingStatus(), allStories()]);
        return json(200, { ...overview, ...pricing,
          stories: { total: stories.length, active: stories.filter((entry) => entry.status !== 'deleted').length,
            deleted: stories.filter((entry) => entry.status === 'deleted').length,
            complete: stories.filter((entry) => entry.status === 'complete').length,
            inProgress: stories.filter((entry) => entry.status === 'in_progress').length },
          budget: { dailyBudgetUsd, dailyTokenLimit, todayCostUsd: overview.today.costUsd, todayTokens: overview.today.tokens.total },
        });
      }
      if (path === '/api/admin/stories' && req.method === 'GET') {
        const options = listOptions(url.searchParams);
        const items = (await allStories()).filter((entry) =>
          (options.status === 'all' || entry.status === options.status)
          && fold([entry.title, entry.hostName, entry.guestName, entry.ownerAlias].join(' ')).includes(fold(options.query)));
        const value = (entry) => options.sort === 'cost' ? entry.usage.costUsd
          : options.sort === 'title' ? fold(entry.title) : typeof entry[options.sort] === 'number'
            ? entry[options.sort] : Date.parse(entry[options.sort]) || 0;
        items.sort((a, b) => {
          const x = value(a), y = value(b);
          return (x < y ? -1 : x > y ? 1 : String(a.id).localeCompare(String(b.id))) * (options.order === 'asc' ? 1 : -1);
        });
        return json(200, { items: items.slice((options.page - 1) * options.pageSize, options.page * options.pageSize),
          total: items.length, page: options.page, pageSize: options.pageSize });
      }
      if (path === '/api/admin/series' && req.method === 'GET') {
        const options = listOptions(url.searchParams, ['query', 'sort', 'order', 'page', 'pageSize']);
        const groups = seriesOf(await allStories()).filter((group) => fold([group.title, ...group.cast, ...group.owners,
          ...group.nodes.flatMap((node) => node.comics.map((entry) => entry.title))].join(' ')).includes(fold(options.query)));
        const value = (group) => options.sort === 'cost' ? group.usage.costUsd
          : options.sort === 'title' ? fold(group.title) : group[options.sort];
        groups.sort((a, b) => {
          const x = value(a), y = value(b);
          return (x < y ? -1 : x > y ? 1 : String(a.id).localeCompare(String(b.id))) * (options.order === 'asc' ? 1 : -1);
        });
        return json(200, { items: groups.slice((options.page - 1) * options.pageSize, options.page * options.pageSize)
          .map(({ nodes, ...group }) => group), total: groups.length, page: options.page, pageSize: options.pageSize });
      }
      const seriesPage = /^\/api\/admin\/series\/([^/]+)$/.exec(path);
      if (seriesPage && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(seriesPage[1]); } catch { fail(400, 'Identificador no válido.'); }
        const group = seriesOf(await allStories()).find((entry) => entry.id === id);
        if (!group) fail(404, 'Serie no encontrada.');
        await audit('series_view', req);
        return json(200, { ...group, nodes: group.nodes.map((node) => ({
          ...pick(node, ['originId', 'parentOriginId', 'issue', 'depth']), missingParent: !!node.missingParent,
          title: node.comics[0].title, direction: node.comics.find((entry) => entry.direction)?.direction ?? '',
          ...pick({ coverId: node.comics.find((entry) => entry.hasCover)?.id }, ['coverId']),
          // The comic the issue was made in comes first; the others are copies of it.
          comics: [...node.comics].sort((a, b) => Number(b.id === node.originId) - Number(a.id === node.originId)).map((entry) => ({
            ...pick(entry, ['id', 'title', 'hostName', 'guestName', 'ownerAlias', 'status', 'completedPages', 'totalPages',
              'createdAt', 'updatedAt', 'usage', 'shares', 'opens']),
            original: entry.id === node.originId,
          })),
        })) });
      }
      if (path === '/api/admin/usage.csv' && req.method === 'GET') {
        const fields = ['id', 'title', 'host', 'guest', 'status', 'createdAt', 'deletedAt', 'calls', 'errors',
          'inputText', 'inputImage', 'outputText', 'outputImage', 'cached', 'totalTokens', 'costUsd', 'shares', 'opens',
          'seriesId', 'issue'];
        const cell = (value) => {
          let text = String(value ?? '');
          if (/^[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) || /^\s+[=+\-@]/.test(text)) text = "'" + text;
          return `"${text.replaceAll('"', '""')}"`;
        };
        const rows = (await allStories()).map((entry) => {
          const values = { ...entry, host: entry.hostName, guest: entry.guestName, ...entry.usage,
            ...entry.usage.tokens, totalTokens: entry.usage.tokens.total, seriesId: entry.series?.id, issue: entry.series?.issue };
          return fields.map((field) => cell(values[field])).join(',');
        });
        await audit('csv_export', req);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"` });
        res.end('\ufeff' + fields.join(',') + '\r\n' + rows.join('\r\n') + '\r\n'); return true;
      }
      if (path === '/api/admin/gemini-log' && req.method === 'GET') {
        const limit = url.searchParams.get('limit') ?? '100';
        const failed = url.searchParams.get('failed');
        const story = url.searchParams.get('story') ?? undefined;
        if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 500 || !['0', '1', null].includes(failed)
          || (story !== undefined && !/^[A-Za-z0-9._-]{1,100}$/.test(story))) fail(400, 'Los filtros no son válidos.');
        await audit('gemini_log_view', req);
        return json(200, { enabled: Boolean(geminiLog?.enabled),
          items: geminiLog ? await geminiLog.recent({ limit: Number(limit), onlyFailed: failed === '1', storyId: story }) : [] });
      }
      // Hands the owner key to the admin so an unfinished comic can be continued from the main page.
      const resume = /^\/api\/admin\/stories\/([^/]+)\/continue$/.exec(path);
      if (resume && req.method === 'POST') {
        let id;
        try { id = decodeURIComponent(resume[1]); } catch { fail(400, 'Identificador no válido.'); }
        const record = await getStory(id);
        if (!record) fail(404, 'Historia no encontrada.');
        await audit('story_continue', req, id);
        resumeStory(id);
        return json(200, { id: record.id, ownerToken: record.ownerToken });
      }
      // Makes a copy of a finished comic for someone else: returns a one-time link that hands the copy over.
      const transfer = /^\/api\/admin\/stories\/([^/]+)\/transfer$/.exec(path);
      if (transfer && req.method === 'POST') {
        let id;
        try { id = decodeURIComponent(transfer[1]); } catch { fail(400, 'Identificador no válido.'); }
        const copy = await transferCopy(id);
        if (!copy) fail(404, 'Historia no encontrada.');
        await audit('story_transfer', req, id);
        return json(201, copy);
      }
      const match = /^\/api\/admin\/stories\/([^/]+)(?:\/image\/(hero|friend|cover|page-(?:[1-9]|1[01])))?$/.exec(path);
      if (match) {
        let id;
        try { id = decodeURIComponent(match[1]); } catch { fail(400, 'Identificador no válido.'); }
        const record = await getStory(id);
        if (req.method === 'DELETE' && !match[2]) {
          if (!record) fail(404, 'Historia no encontrada.');
          await deleteStoryById(id, 'admin');
          await audit('story_delete', req, id);
          res.writeHead(204); res.end(); return true;
        }
        if (req.method === 'GET' && match[2]) {
          const which = match[2];
          const image = which === 'hero' || which === 'friend' ? record?.[which]?.base64
            : record?.faces?.find((face) => face.id === (which === 'cover' ? 'cover' : `page-${which.slice(4).replace(/^-/, '')}`))?.imageUrl?.replace(/^data:image\/jpeg;base64,/, '');
          if (!image) fail(404, 'Imagen no encontrada.');
          const binary = Buffer.from(image, 'base64');
          if (!binary.length) fail(404, 'Imagen no encontrada.');
          if (!session.viewedImages.has(id)) {
            await audit('image_view', req, id);
            session.viewedImages.add(id);
          }
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300',
            'Content-Disposition': `inline; filename="${which}.jpg"` });
          res.end(binary); return true;
        }
        if (req.method === 'GET' && !match[2]) {
          const accounting = await usage.getStory(id);
          const source = record ?? accounting?.snapshot ?? (accounting ? { id } : null);
          if (!source) fail(404, 'Historia no encontrada.');
          await audit('story_view', req, id);
          session.viewedImages.delete(id);
          const summary = item({ ...source, id }, accounting?.totals, !record);
          const series = record ? await placeOf(id) : null;
          return json(200, {
            ...pick(summary, ['id', 'title', 'hostName', 'guestName', 'createdAt', 'updatedAt', 'deletedAt',
              'deletedBy', 'status', 'completedPages', 'totalPages', 'shares', 'opens', 'lastSharedAt', 'lastOpenedAt']),
            ...pick(summary, ['ownerAlias']),
            ...pick(source, ['tone', 'styleGuide', 'invitationId']),
            ...(series ? { series } : {}),
            ...(source.settings ? { settings: pick(source.settings, ['genre', 'language', 'premise', 'richMode']) } : {}),
            faces: !record ? [] : (record.faces ?? []).map((face) => ({
              ...pick(face, ['id', 'type', 'pageIndex', 'isLoading', 'isDecisionPage', 'choices', 'resolvedChoice']),
              ...(face.narrative ? { narrative: pick(face.narrative, ['caption', 'dialogue', 'scene', 'choices', 'focus_char']) } : {}),
              hasImage: !!face.imageUrl,
            })),
            usage: { totals: accounting?.totals ?? emptyTotals(), byOperation: accounting?.byOperation ?? {},
              byModel: accounting?.byModel ?? {}, events: accounting?.events ?? [] },
          });
        }
      }
      fail(404, 'Ruta de administración no encontrada.');
    } catch (error) {
      return json(error.status ?? 500, { error: error.status ? error.message : 'Error interno del servidor.' });
    }
  };
}
