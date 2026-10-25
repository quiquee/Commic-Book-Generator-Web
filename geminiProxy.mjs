import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-nano-banana-2.1'];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 12 * 1024 * 1024;
const statuses = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED', 413: 'RESOURCE_EXHAUSTED', 429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL', 502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !actual || !expected) return false;
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        chunks.length = 0;
        reject(Object.assign(new Error('El cuerpo supera 12 MB.'), { status: 413 }));
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(Object.assign(new Error('JSON no válido.'), { status: 400 })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('Solicitud interrumpida.'), { status: 400 })));
  });
}

/**
 * Standalone Node HTTP handler; loadStory(id) must return a record with ownerToken.
 * x-usage-op labels accounting. Client disconnects never cancel accepted upstream work.
 */
export function createGeminiProxy({
  usage, loadStory, geminiApiKey,
  geminiUpstream = 'https://generativelanguage.googleapis.com',
  allowedModels = DEFAULT_MODELS, dailyBudgetUsd, dailyTokenLimit, trustProxy = false,
  upstreamTimeoutMs = 120_000,
}) {
  if ((geminiApiKey !== undefined && typeof geminiApiKey !== 'string')
    || !Array.isArray(allowedModels) || allowedModels.length === 0
    || allowedModels.some((model) => typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model))
    || (dailyBudgetUsd !== undefined && (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0))
    || (dailyTokenLimit !== undefined && (!Number.isSafeInteger(dailyTokenLimit) || dailyTokenLimit < 0))
    || !Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new Error('La configuración del proxy Gemini no es válida.');
  }
  let upstreamBase;
  try {
    upstreamBase = new URL(geminiUpstream);
    if (!['http:', 'https:'].includes(upstreamBase.protocol) || upstreamBase.username || upstreamBase.password) throw new Error();
  } catch {
    throw new Error('La URL del servidor Gemini no es válida.');
  }
  const models = new Set(allowedModels);
  const windows = new Map();
  const sanitize = (value) => geminiApiKey ? String(value).split(geminiApiKey).join('[REDACTED]') : String(value);
  function send(res, code, payload) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(sanitize(JSON.stringify(payload)));
  }
  function error(res, code, message, status = statuses[code] ?? 'UNKNOWN') {
    send(res, code, { error: { code, message: sanitize(message), status } });
  }
  function rateAllowed(req, type) {
    const forwarded = trustProxy && typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim() : null;
    const key = `${type}:${forwarded || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    for (const [id, times] of windows) if (times.at(-1) <= now - 60_000) windows.delete(id);
    const times = (windows.get(key) ?? []).filter((time) => time > now - 60_000);
    if (times.length >= (type === 'story' ? 60 : 12)) return false;
    times.push(now);
    windows.set(key, times);
    return true;
  }
  return async function handle(req, res, url) {
    try {
      const pathname = typeof url === 'string' ? new URL(url, 'http://localhost').pathname
        : url?.pathname ?? new URL(req.url, 'http://localhost').pathname;
      const match = /^\/api\/gemini\/v1beta\/models\/([a-zA-Z0-9._-]+):generateContent$/.exec(pathname);
      if (!match) return error(res, 404, 'Ruta no encontrada.');
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return error(res, 405, 'Método no permitido.');
      }
      if (!geminiApiKey) return error(res, 503, 'El servicio de generación no está configurado.');
      const model = match[1];
      if (!models.has(model)) return error(res, 400, 'Modelo no permitido.');
      let scope;
      const storyId = req.headers['x-story-id'];
      const storyToken = req.headers['x-story-token'];
      if (storyId !== undefined || storyToken !== undefined) {
        if (typeof storyId !== 'string' || !UUID4.test(storyId) || typeof storyToken !== 'string') return error(res, 401, 'Credenciales no válidas.');
        const story = await loadStory(storyId);
        if (!story || !tokenMatches(storyToken, story.ownerToken)) return error(res, 401, 'Acceso reservado al propietario.');
        scope = { type: 'story', id: storyId };
      } else {
        const draftId = req.headers['x-draft-id'];
        if (typeof draftId !== 'string' || !UUID4.test(draftId)) return error(res, 401, 'Se requiere un borrador válido.');
        scope = { type: 'draft', id: draftId };
      }
      if (!rateAllowed(req, scope.type)) return error(res, 429, 'RATE_LIMIT: demasiadas solicitudes.');
      const today = (await usage.overview()).today;
      if (Number.isFinite(dailyBudgetUsd) && dailyBudgetUsd > 0 && today.costUsd >= dailyBudgetUsd) {
        return error(res, 429, 'LIMITE_DE_CONSUMO: presupuesto diario agotado.');
      }
      if (Number.isFinite(dailyTokenLimit) && dailyTokenLimit > 0 && today.tokens.total >= dailyTokenLimit) {
        return error(res, 429, 'LIMITE_DE_CONSUMO: límite diario de tokens alcanzado.');
      }
      const body = await readBody(req);
      const operation = req.headers['x-usage-op'];
      const op = typeof operation === 'string' && /^[a-z_]{2,20}(:\d{1,2})?$/.test(operation) ? operation : 'other';
      const upstream = new URL(upstreamBase);
      upstream.pathname = `${upstream.pathname.replace(/\/(?:v1beta\/?)?$/, '')}/v1beta/models/${model}:generateContent`;
      upstream.search = '';
      upstream.hash = '';
      upstream.username = '';
      upstream.password = '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
      const start = performance.now();
      let httpStatus = 502;
      let payload;
      let ok = false;
      try {
        const response = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiApiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
        httpStatus = response.status;
        const text = await response.text();
        try {
          payload = JSON.parse(text);
        } catch {
          if (response.ok) throw new Error('Respuesta no válida del servicio de generación.');
          payload = { error: { message: text || 'Error del servicio de generación.' } };
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Respuesta no válida del servicio de generación.');
        ok = response.ok && !payload.error;
        if (!ok) {
          if (httpStatus < 400) httpStatus = 502;
          payload = { error: { code: httpStatus, message: typeof payload.error?.message === 'string'
            ? payload.error.message : 'Error del servicio de generación.',
          status: typeof payload.error?.status === 'string' ? payload.error.status : statuses[httpStatus] ?? 'UNKNOWN' } };
        }
      } catch {
        httpStatus = controller.signal.aborted ? 504 : 502;
        payload = { error: { code: httpStatus, message: httpStatus === 504
          ? 'El generador ha tardado demasiado en responder.' : 'No se pudo obtener respuesta del generador.', status: statuses[httpStatus] } };
      } finally {
        clearTimeout(timer);
      }
      await usage.record(scope, { model, op, ok, httpStatus, latencyMs: performance.now() - start, response: payload });
      send(res, httpStatus, payload);
    } catch (cause) {
      error(res, cause.status === 413 ? 413 : cause.status === 400 ? 400 : 500,
        cause.status === 413 || cause.status === 400 ? cause.message : 'Error interno del servidor.');
    }
  };
}
