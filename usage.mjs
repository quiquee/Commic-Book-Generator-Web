import { mkdir, readFile, readdir, writeFile, rename, chmod, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const tokenKeys = ['inputText', 'inputImage', 'outputText', 'outputImage', 'cached', 'total'];
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const emptyTokens = () => Object.fromEntries(tokenKeys.map((key) => [key, 0]));
const emptyTotals = () => ({ calls: 0, errors: 0, tokens: emptyTokens(), costUsd: 0, uncostedCalls: 0 });
const dayKey = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);

/** Normalize Gemini counters without counting modality details twice. */
export function normalizeUsage(response, ok = true) {
  const tokens = emptyTokens();
  if (!ok) return { tokens, images: 0 };
  const metadata = response?.usageMetadata ?? {};
  const inputDetails = metadata.promptTokensDetails;
  if (Array.isArray(inputDetails) && inputDetails.length) {
    for (const detail of inputDetails) {
      tokens[detail.modality === 'IMAGE' ? 'inputImage' : 'inputText'] += number(detail.tokenCount);
    }
  } else {
    tokens.inputText = number(metadata.promptTokenCount);
  }
  for (const detail of Array.isArray(metadata.candidatesTokensDetails) ? metadata.candidatesTokensDetails : []) {
    if (detail.modality === 'IMAGE') tokens.outputImage += number(detail.tokenCount);
  }
  tokens.outputText = Math.max(0, number(metadata.candidatesTokenCount) - tokens.outputImage)
    + number(metadata.thoughtsTokenCount);
  tokens.cached = number(metadata.cachedContentTokenCount);
  tokens.total = typeof metadata.totalTokenCount === 'number' && Number.isFinite(metadata.totalTokenCount)
    && metadata.totalTokenCount >= 0 ? metadata.totalTokenCount
    : tokens.inputText + tokens.inputImage + tokens.outputText + tokens.outputImage;
  const images = (Array.isArray(response?.candidates) ? response.candidates : []).reduce(
    (sum, candidate) => sum + (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
      .filter((part) => part?.inlineData).length, 0);
  return { tokens, images };
}

function addTotals(target, source) {
  target.calls += source.calls;
  target.errors += source.errors;
  target.costUsd += source.costUsd;
  target.uncostedCalls += source.uncostedCalls;
  for (const key of tokenKeys) target.tokens[key] += source.tokens[key];
  return target;
}

function newScope(id, type = 'story') {
  const now = new Date().toISOString();
  return { id, scope: { type, id }, createdAt: now, updatedAt: now, totals: emptyTotals(), byOperation: {}, byModel: {}, events: [], snapshot: null };
}

function mergeScopes(target, source) {
  addTotals(target.totals, source.totals);
  for (const grouping of ['byOperation', 'byModel']) {
    for (const [key, totals] of Object.entries(source[grouping])) {
      if (!Object.hasOwn(target[grouping], key)) target[grouping][key] = emptyTotals();
      addTotals(target[grouping][key], totals);
    }
  }
  target.events = [...target.events, ...source.events].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-500);
  target.updatedAt = new Date().toISOString();
}

/**
 * Single-process, serialized store. Mutations commit one private atomic state file,
 * so adoption, its idempotency marker, and accounting cannot be partially written.
 * All public methods are asynchronous and return detached data.
 */
export function createUsageStore({ usageDir, pricingFile }) {
  const file = join(usageDir, 'usage.json');
  let state;
  let pricing = null;
  let pricingStamp;
  let materialized = new Map();
  async function atomicFile(name, data) {
    const pending = join(usageDir, `usage-${randomUUID()}.pending`);
    try {
      await writeFile(pending, data, { mode: 0o600, flag: 'wx' });
      await rename(pending, join(usageDir, name));
    } finally {
      await unlink(pending).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function persist(next) {
    // The private journal makes multi-file adoption recoverable after a crash.
    await atomicFile('usage.json', JSON.stringify(next));
    const files = new Map([['_daily.json', JSON.stringify({ days: next.daily })]]);
    for (const [id, record] of Object.entries(next.stories)) {
      files.set(`${id}.json`, JSON.stringify(record));
    }
    for (const [id, record] of Object.entries(next.drafts)) {
      if (!record.adoptedTo) files.set(`draft-${id}.json`, JSON.stringify(record));
      else await unlink(join(usageDir, `draft-${id}.json`)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    for (const [name, data] of files) {
      if (materialized.get(name) !== data) await atomicFile(name, data);
    }
    for (const name of materialized.keys()) {
      if (!files.has(name)) await unlink(join(usageDir, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    materialized = files;
  }
  let queue = (async () => {
    await mkdir(usageDir, { recursive: true, mode: 0o700 });
    await chmod(usageDir, 0o700);
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
      if (state.version !== 1 || !state.stories || !state.drafts || !state.daily || !state.totals) {
        throw new Error('Invalid usage store');
      }
      await chmod(file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, stories: {}, drafts: {}, daily: {}, totals: emptyTotals() };
    }
    for (const [id, draft] of Object.entries(state.drafts)) {
      // Adoption markers are retained to keep retries safe even after thirty days.
      if (!draft.adoptedTo && Date.parse(draft.updatedAt) < Date.now() - 30 * DAY) {
        await unlink(join(usageDir, `draft-${id}.json`)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        delete state.drafts[id];
      }
    }
    for (const entry of await readdir(usageDir, { withFileTypes: true })) {
      const match = /^draft-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i.exec(entry.name);
      if (entry.isFile() && match && !Object.hasOwn(state.drafts, match[1])) {
        const path = join(usageDir, entry.name);
        if ((await stat(path)).mtimeMs < Date.now() - 30 * DAY) await unlink(path);
      }
    }
    pruneDays(state);
    await persist(state);
  })();
  function run(action, mutate = false) {
    const result = queue.then(async () => {
      const next = mutate ? structuredClone(state) : state;
      const value = await action(next);
      if (mutate) {
        pruneDays(next);
        await persist(next);
        state = next;
      }
      return structuredClone(value);
    });
    queue = result.catch(() => {});
    return result;
  }
  function pruneDays(next) {
    const cutoff = dayKey(Date.now() - 399 * DAY);
    for (const day of Object.keys(next.daily)) if (day < cutoff) delete next.daily[day];
  }
  async function readPricing() {
    if (!pricingFile) return null;
    try {
      const info = await stat(pricingFile, { bigint: true });
      const stamp = `${info.mtimeNs}:${info.size}:${info.ino}`;
      if (stamp !== pricingStamp) {
        const candidate = JSON.parse(await readFile(pricingFile, 'utf8'));
        pricing = candidate?.currency === 'USD' && typeof candidate.version === 'string'
          && candidate.models && typeof candidate.models === 'object' && !Array.isArray(candidate.models) ? candidate : null;
        pricingStamp = stamp;
      }
    } catch {
      pricing = null;
      pricingStamp = undefined;
    }
    return pricing;
  }
  function costFor(tokens, model, prices) {
    const rates = prices?.models?.[model];
    if (!rates || typeof rates !== 'object') return null;
    let cost = 0;
    for (const key of tokenKeys.slice(0, 4)) {
      if (!tokens[key]) continue;
      if (typeof rates[key] !== 'number' || !Number.isFinite(rates[key]) || rates[key] < 0) return null;
      cost += tokens[key] * rates[key] / 1_000_000;
    }
    return cost;
  }
  function validateId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || Object.hasOwn(Object.prototype, id) || id === 'prototype') {
      throw new TypeError('Invalid usage id');
    }
  }
  return {
    flush() { return run(() => undefined); },
    record(scope, event) {
      return run(async (next) => {
        if (!scope || !['story', 'draft'].includes(scope.type)) throw new TypeError('Invalid usage scope');
        validateId(scope.id);
        const model = typeof event.model === 'string' ? event.model : 'unknown';
        const op = typeof event.op === 'string' && /^[a-z_]{2,20}(:\d{1,2})?$/.test(event.op) ? event.op : 'other';
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(model) || Object.hasOwn(Object.prototype, model)) {
          throw new TypeError('Invalid model');
        }
        const ok = event.ok === true;
        const normalized = normalizeUsage(event.response, ok);
        const prices = await readPricing();
        const costUsd = ok ? costFor(normalized.tokens, model, prices) : 0;
        const timestamp = new Date().toISOString();
        const entry = { model, op, ok, httpStatus: number(event.httpStatus), latencyMs: number(event.latencyMs),
          ts: timestamp, page: op.includes(':') ? Number(op.split(':')[1]) : null,
          ...normalized, costUsd, priceVersion: costUsd === null ? null : prices?.version ?? null };
        let collection = scope.type === 'story' ? next.stories : next.drafts;
        let id = scope.id;
        if (scope.type === 'draft' && next.drafts[id]?.adoptedTo) {
          id = next.drafts[id].adoptedTo;
          collection = next.stories;
        }
        const record = collection[id] ??= newScope(id, collection === next.drafts ? 'draft' : 'story');
        const totals = { calls: 1, errors: ok ? 0 : 1, tokens: normalized.tokens,
          costUsd: costUsd ?? 0, uncostedCalls: ok && costUsd === null ? 1 : 0 };
        addTotals(record.totals, totals);
        // Operation names can coincide with inherited properties.
        for (const [group, key] of [['byOperation', op], ['byModel', model]]) {
          if (!Object.hasOwn(record[group], key)) record[group][key] = emptyTotals();
          addTotals(record[group][key], totals);
        }
        record.events.push(entry);
        record.events = record.events.slice(-500);
        record.updatedAt = timestamp;
        addTotals(next.totals, totals);
        addTotals(next.daily[dayKey()] ??= emptyTotals(), totals);
        return entry;
      }, true);
    },
    getStory(id) { return run((next) => Object.hasOwn(next.stories, id) ? next.stories[id] : null); },
    getDraft(id) { return run((next) => Object.hasOwn(next.drafts, id) ? next.drafts[id] : null); },
    adoptDraft(draftId, storyId) {
      return run((next) => {
        validateId(draftId);
        validateId(storyId);
        const draft = next.drafts[draftId];
        if (!draft) {
          next.drafts[draftId] = { id: draftId, adoptedTo: storyId, updatedAt: new Date().toISOString() };
          return next.stories[storyId] ?? null;
        }
        if (draft.adoptedTo) {
          if (draft.adoptedTo !== storyId) throw new Error('Draft already adopted by another story');
          return next.stories[storyId];
        }
        const story = next.stories[storyId] ??= newScope(storyId);
        mergeScopes(story, draft);
        next.drafts[draftId] = { id: draftId, adoptedTo: storyId, updatedAt: new Date().toISOString() };
        return story;
      }, true);
    },
    markDeleted(storyId, snapshot) {
      return run((next) => {
        validateId(storyId);
        const story = next.stories[storyId] ??= newScope(storyId);
        story.snapshot = structuredClone(snapshot);
        story.deletedAt = new Date().toISOString();
        return story;
      }, true);
    },
    listStories() { return run((next) => Object.values(next.stories)); },
    overview() {
      return run((next) => {
        const today = dayKey();
        const daily = Array.from({ length: 30 }, (_, index) => {
          const date = dayKey(Date.now() - (29 - index) * DAY);
          return { date, ...(next.daily[date] ?? emptyTotals()) };
        });
        const sum = (days) => Object.entries(next.daily).reduce((total, [date, value]) =>
          date >= dayKey(Date.now() - (days - 1) * DAY) && date <= today ? addTotals(total, value) : total, emptyTotals());
        const drafts = Object.values(next.drafts).filter((draft) => !draft.adoptedTo);
        return { totals: next.totals, today: next.daily[today] ?? emptyTotals(), last7Days: sum(7),
          last30Days: sum(30), daily, draftsUnassigned: { count: drafts.length,
            ...drafts.reduce((total, draft) => addTotals(total, draft.totals), emptyTotals()) } };
      });
    },
    pricingStatus() {
      return run(async () => {
        const prices = await readPricing();
        return { pricingConfigured: !!prices, pricingVersion: prices?.version ?? null };
      });
    },
  };
}
