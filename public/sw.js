// Shows the server's push notices (decision pending, comic finished) and opens the comic when tapped.
// It deliberately has no fetch handler: nothing is cached or intercepted.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Mundos Cruzados', {
    body: data.body || '',
    tag: data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      try {
        await open.navigate(target);
        return;
      } catch {
        // Pages not controlled by this worker cannot be navigated; open a new one instead.
      }
    }
    await self.clients.openWindow(target);
  })());
});
