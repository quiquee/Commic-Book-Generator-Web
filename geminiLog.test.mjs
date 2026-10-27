import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blockedReason, createGeminiLog, summarizePrompt } from './geminiLog.mjs';

test('only answers without content count as refusals', () => {
  assert.equal(blockedReason({ promptFeedback: { blockReason: 'SAFETY' } }), 'SAFETY');
  assert.equal(blockedReason({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }), 'IMAGE_SAFETY');
  assert.equal(blockedReason({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'hola' }] } }] }), null);
  assert.equal(blockedReason({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: 'x' } }] } }] }), null);
  assert.equal(blockedReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), null);
});

test('prompt summaries keep the text and drop image bytes', () => {
  const summary = summarizePrompt({ contents: [{ text: 'A' }, { inlineData: { data: 'AAAA' } }, { text: 'B' }] });
  assert.deepEqual(summary, { text: 'A\nB', images: 1 });
  assert.ok(summarizePrompt({ contents: 'x'.repeat(9000) }).text.length < 4100);
});

test('the log honours its level, filters, redacts and rotates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'gemini.log');
  const log = createGeminiLog({ file, level: 'errors', maxBytes: 600, sanitize: (text) => text.split('SECRET').join('[REDACTED]') });
  await log.record({ ok: true, scopeId: 'a' });
  await log.record({ ok: false, scopeId: 'a', note: 'SECRET' });
  await log.record({ ok: true, blockReason: 'SAFETY', scopeId: 'b' });
  assert.equal((await log.recent({ storyId: 'b' })).length, 1);
  assert.equal((await log.recent()).length, 2);
  assert.ok(!(await readFile(file, 'utf8')).includes('SECRET'));
  for (let index = 0; index < 10; index++) await log.record({ ok: false, scopeId: 'c', pad: 'x'.repeat(100) });
  assert.ok((await readFile(`${file}.1`, 'utf8')).length > 0);
  assert.ok((await log.recent({ limit: 500 })).length > 3);
  assert.equal(createGeminiLog({ file, level: 'off' }).enabled, false);
});
