import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';

/**
 * Web Push with VAPID keys created on first use and kept in `dir` (they must survive restarts,
 * or every saved subscription stops working). send() resolves to 'sent', 'gone' or 'failed'.
 */
export function createPushService({ dir, subject, log = console }) {
  let keysPromise;
  const keys = () => {
    keysPromise ??= (async () => {
      const file = join(dir, 'vapid.json');
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (typeof saved.publicKey === 'string' && typeof saved.privateKey === 'string') return saved;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const created = webpush.generateVAPIDKeys();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(created), { mode: 0o600, flag: 'wx' });
      await chmod(file, 0o600);
      return created;
    })();
    keysPromise.catch(() => { keysPromise = undefined; });
    return keysPromise;
  };

  return {
    publicKey: async () => (await keys()).publicKey,
    async send(subscription, payload) {
      const { publicKey, privateKey } = await keys();
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails: { subject, publicKey, privateKey }, TTL: 24 * 60 * 60,
        });
        return 'sent';
      } catch (error) {
        // 404/410: the browser unsubscribed or the subscription expired.
        if (error.statusCode === 404 || error.statusCode === 410) return 'gone';
        log.warn?.(`No se pudo enviar una notificación: ${error.statusCode ?? ''} ${error.body ?? error.message}`.trim());
        return 'failed';
      }
    },
  };
}

// Accepts only what PushSubscription.toJSON() produces, with bounded sizes.
export function validateSubscription(value) {
  const ok = value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.endpoint === 'string' && value.endpoint.length <= 1000
    && value.keys && typeof value.keys.p256dh === 'string' && value.keys.p256dh.length <= 200
    && typeof value.keys.auth === 'string' && value.keys.auth.length <= 100;
  if (!ok) return null;
  try {
    if (new URL(value.endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
