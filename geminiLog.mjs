import { appendFile, chmod, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_PROMPT = 4000;
const MAX_REPLY = 1500;
const MAX_FILE = 5 * 1024 * 1024;
const BLOCKING_FINISH = new Set([
  'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII',
  'RECITATION', 'IMAGE_RECITATION',
]);

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}… [+${text.length - max}]` : text);
const parts = (candidate) => (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []);

/**
 * Why Gemini refused to answer, or null. A refusal arrives as HTTP 200 with promptFeedback.blockReason or a
 * candidate whose finishReason is a safety-type one and that carries neither text nor an image.
 */
export function blockedReason(payload) {
  const blockReason = payload?.promptFeedback?.blockReason;
  if (typeof blockReason === 'string' && blockReason) return blockReason;
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  if (candidates.some((candidate) => parts(candidate).some((part) => part?.inlineData || (typeof part?.text === 'string' && part.text.trim())))) {
    return null;
  }
  const finish = candidates.map((candidate) => candidate?.finishReason).find((reason) => BLOCKING_FINISH.has(reason));
  return finish ?? null;
}

/** Text of the request without image bytes, so the log shows what was asked and not megabytes of base64. */
export function summarizePrompt(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : body?.contents ? [body.contents] : [];
  const texts = [];
  let images = 0;
  for (const item of contents) {
    const list = typeof item === 'string' ? [{ text: item }] : Array.isArray(item?.parts) ? item.parts : [item];
    for (const part of list) {
      if (typeof part === 'string') texts.push(part);
      else if (typeof part?.text === 'string') texts.push(part.text);
      else if (part?.inlineData) images++;
    }
  }
  return { text: clip(texts.join('\n').trim(), MAX_PROMPT), images };
}

function summarizeReply(payload) {
  const text = (Array.isArray(payload?.candidates) ? payload.candidates : [])
    .flatMap(parts).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
  return text ? clip(text, MAX_REPLY) : undefined;
}

/**
 * JSON-lines log of every Gemini call (.data/gemini.log). `level` is 'off', 'errors' (failed or blocked calls
 * only) or 'all'. The file is rotated once past maxBytes, keeping one previous generation.
 * `sanitize` strips secrets from every string before it is written.
 */
export function createGeminiLog({ file, level = 'all', maxBytes = MAX_FILE, sanitize = String } = {}) {
  let queue = Promise.resolve();
  const enabled = Boolean(file) && level !== 'off';

  async function write(line) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const size = await stat(file).then((info) => info.size, () => 0);
    if (size + line.length > maxBytes) await rename(file, `${file}.1`).catch(() => {});
    await appendFile(file, line, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  }

  return {
    enabled,
    /** Never throws: a log failure must not break generation. */
    record(entry) {
      if (!enabled) return Promise.resolve();
      const failed = !entry.ok || Boolean(entry.blockReason);
      if (level === 'errors' && !failed) return Promise.resolve();
      const line = `${sanitize(JSON.stringify({ ts: new Date().toISOString(), ...entry }))}\n`;
      queue = queue.then(() => write(line)).catch(() => {});
      return queue;
    },
    flush: () => queue,
    /** Newest first. */
    async recent({ limit = 100, onlyFailed = false, storyId } = {}) {
      await queue;
      const rows = [];
      for (const path of [file, `${file}.1`]) {
        const text = await readFile(path, 'utf8').catch(() => '');
        const lines = text.split('\n').filter(Boolean);
        for (let index = lines.length - 1; index >= 0 && rows.length < limit; index--) {
          let row;
          try { row = JSON.parse(lines[index]); } catch { continue; }
          if (onlyFailed && row.ok && !row.blockReason) continue;
          if (storyId && row.scopeId !== storyId) continue;
          rows.push(row);
        }
        if (rows.length >= limit) break;
      }
      return rows;
    },
  };
}

/** Builds one log entry from what the proxy knows about a finished call. */
export function describeCall({ scope, model, op, httpStatus, latencyMs, ok, body, payload, blockReason }) {
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : undefined;
  return {
    scope: scope.type,
    scopeId: scope.id,
    model,
    op,
    httpStatus,
    latencyMs: Math.round(latencyMs),
    ok,
    ...(blockReason ? { blockReason } : {}),
    ...(payload?.error ? { error: { code: payload.error.code, status: payload.error.status, message: clip(String(payload.error.message ?? ''), MAX_REPLY) } } : {}),
    ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
    ...(Array.isArray(candidate?.safetyRatings) ? { safetyRatings: candidate.safetyRatings } : {}),
    ...(Array.isArray(payload?.promptFeedback?.safetyRatings) ? { promptSafetyRatings: payload.promptFeedback.safetyRatings } : {}),
    ...(payload?.usageMetadata?.totalTokenCount !== undefined ? { totalTokens: payload.usageMetadata.totalTokenCount } : {}),
    prompt: summarizePrompt(body),
    ...(ok && !blockReason ? { reply: summarizeReply(payload) } : {}),
  };
}
