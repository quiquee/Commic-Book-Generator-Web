import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import { PhotoError, createPhotoFetcher, createRateLimit, imageType, isPublicAddress } from './photoFetch.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16, 3)]);

// Stands in for the sites the photos come from: the fetcher's connections are sent here whatever host they name.
let site;
let seen;
const HOSTS = {
  'photos.example': [{ address: '93.184.216.34', family: 4 }],
  'cdn.example': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }, { address: '93.184.216.34', family: 4 }],
  'intranet.example': [{ address: '10.0.0.5', family: 4 }],
  'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
};

before(async () => {
  site = createServer((request, response) => {
    const send = (status, headers, body) => { response.writeHead(status, headers); response.end(body); };
    if (request.url === '/hero.jpg') send(200, { 'content-type': 'application/octet-stream' }, JPEG);
    else if (request.url === '/hero.png') send(200, { 'content-type': 'image/png' }, PNG);
    else if (request.url === '/hero.webp') send(200, { 'content-type': 'image/webp' }, WEBP);
    else if (request.url === '/page.html') send(200, { 'content-type': 'image/jpeg' }, '<html>not a photo</html>');
    else if (request.url === '/moved') send(302, { location: 'https://cdn.example/hero.png' });
    else if (request.url === '/relative') send(301, { location: '/hero.jpg' });
    else if (request.url === '/inside') send(302, { location: 'https://intranet.example/hero.jpg' });
    else if (request.url === '/metadata') send(302, { location: 'https://169.254.169.254/latest/meta-data' });
    else if (request.url === '/plain') send(302, { location: 'http://photos.example/hero.jpg' });
    else if (request.url === '/loop') send(302, { location: '/loop' });
    else if (request.url === '/declared-big') send(200, { 'content-length': 5000 }, Buffer.alloc(5000));
    else if (request.url === '/big') { response.writeHead(200); response.write(JPEG); response.end(Buffer.alloc(5000)); }
    else if (request.url === '/slow') { /* never answers */ }
    else send(404, {}, 'no');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
});

after(() => { site.closeAllConnections(); site.close(); });

function fetcher(options = {}) {
  seen = [];
  return createPhotoFetcher({
    lookup: async (host) => {
      if (!HOSTS[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return HOSTS[host];
    },
    request: (url, requestOptions, callback) => {
      seen.push({ url: url.href, lookup: requestOptions.lookup });
      return httpRequest({
        host: '127.0.0.1', port: site.address().port, path: url.pathname + url.search,
        method: requestOptions.method, headers: requestOptions.headers, signal: requestOptions.signal,
      }, callback);
    },
    maxBytes: 1000, timeoutMs: 300, ...options,
  });
}

const refused = (status, pattern) => (error) => {
  assert.ok(error instanceof PhotoError, String(error));
  assert.equal(error.status, status);
  assert.match(error.message, pattern);
  return true;
};

test('public addresses are told apart from private, loopback, link-local and reserved ones', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::1', '64:ff9b::7f00:1', 'photos.example', '',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('the kind of image is read from its first bytes', () => {
  assert.equal(imageType(JPEG), 'image/jpeg');
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(WEBP), 'image/webp');
  assert.equal(imageType(Buffer.from('GIF89a........')), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
});

test('a photo is downloaded whatever content type its site declares, and the connection uses the checked addresses', async () => {
  const fetchPhoto = fetcher();
  const photo = await fetchPhoto('https://photos.example/hero.jpg');
  assert.equal(photo.type, 'image/jpeg');
  assert.deepEqual(photo.data, JPEG);
  assert.equal((await fetchPhoto('https://photos.example/hero.webp')).type, 'image/webp');

  // The connection resolves the name to what was checked, in both forms Node asks for.
  const pinned = seen[0].lookup;
  pinned('photos.example', { all: true }, (error, addresses) => assert.deepEqual(addresses, HOSTS['photos.example']));
  pinned('photos.example', {}, (error, address, family) => assert.deepEqual([address, family], ['93.184.216.34', 4]));
});

test('redirects are followed to other public sites, a few at most', async () => {
  const fetchPhoto = fetcher();
  assert.equal((await fetchPhoto('https://photos.example/moved')).type, 'image/png');
  assert.deepEqual(seen.map((entry) => entry.url), ['https://photos.example/moved', 'https://cdn.example/hero.png']);
  assert.equal((await fetchPhoto('https://photos.example/relative')).type, 'image/jpeg');
  await assert.rejects(fetchPhoto('https://photos.example/loop'), refused(502, /No se pudo descargar/));
  assert.equal(seen.filter((entry) => entry.url.endsWith('/loop')).length, 4);
});

test('addresses that are not plain public https are refused before any connection', async () => {
  const fetchPhoto = fetcher();
  for (const address of [
    '', 'hero.jpg', 'http://photos.example/hero.jpg', 'ftp://photos.example/hero.jpg', 'file:///etc/passwd',
    'https://user:secret@photos.example/hero.jpg', 'https://photos.example:8443/hero.jpg', `https://photos.example/${'a'.repeat(2000)}`,
  ]) {
    await assert.rejects(fetchPhoto(address), refused(400, /no es válida/), address);
  }
  await assert.rejects(fetchPhoto(null), refused(400, /no es válida/));
  for (const address of [
    'https://127.0.0.1/hero.jpg', 'https://intranet.example/hero.jpg',
    'https://mixed.example/hero.jpg', 'https://[::1]/hero.jpg', 'https://169.254.169.254/latest/meta-data',
    'https://2130706433/hero.jpg', 'https://0x7f.1/hero.jpg', 'https://[::ffff:10.0.0.1]/hero.jpg',
  ]) {
    await assert.rejects(fetchPhoto(address), refused(400, /no es pública/), address);
  }
  assert.deepEqual(seen, []);
  await assert.rejects(fetchPhoto('https://unknown.example/hero.jpg'), refused(502, /No se pudo descargar/));
});

test('a redirect cannot lead to a private address or away from https', async () => {
  const fetchPhoto = fetcher();
  await assert.rejects(fetchPhoto('https://photos.example/inside'), refused(400, /no es pública/));
  await assert.rejects(fetchPhoto('https://photos.example/metadata'), refused(400, /no es pública/));
  await assert.rejects(fetchPhoto('https://photos.example/plain'), refused(400, /no es válida/));
  assert.ok(seen.every((entry) => entry.url.startsWith('https://photos.example/')));
});

test('files that are not photos, too large or too slow are refused', async () => {
  const fetchPhoto = fetcher();
  await assert.rejects(fetchPhoto('https://photos.example/page.html'), refused(415, /JPEG, PNG o WebP/));
  await assert.rejects(fetchPhoto('https://photos.example/declared-big'), refused(413, /supera/));
  await assert.rejects(fetchPhoto('https://photos.example/big'), refused(413, /supera/));
  await assert.rejects(fetchPhoto('https://photos.example/missing'), refused(502, /No se pudo descargar/));
  await assert.rejects(fetchPhoto('https://photos.example/slow'), refused(504, /tardó demasiado/));
});

test('the rate limit counts calls per key inside a moving window', () => {
  const allowed = createRateLimit(2, 1000);
  assert.equal(allowed('a', 0), true);
  assert.equal(allowed('a', 10), true);
  assert.equal(allowed('a', 20), false);
  assert.equal(allowed('b', 20), true);
  assert.equal(allowed('a', 1005), true);
});
