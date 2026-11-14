// Downloads a photo from a public address on behalf of the browser, which cannot read images from other sites.
// A server that fetches whatever address it is given could be used to reach machines only it can see, so the
// address must be https and resolve to public addresses only, and the connection is made to exactly the
// addresses that were checked. Redirects go through the same checks.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class PhotoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const refuse = (status, message) => { throw new PhotoError(status, message); };
const BAD_ADDRESS = 'La dirección de la foto no es válida. Debe empezar por https://.';
const NOT_PUBLIC = 'La dirección de la foto no es pública.';
const UNREACHABLE = 'No se pudo descargar la foto.';

// Everything that is not a public unicast IPv4 address: private, loopback, link-local, shared, reserved, multicast.
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blockedV4.addSubnet(network, prefix, 'ipv4');

// IPv6 is the other way round: only global unicast is accepted, minus the ranges that tunnel or document.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  // IPv4 addresses written as IPv6 (::ffff:10.0.0.1) are outside 2000::/3, so they are refused too.
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

export function imageType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function parseAddress(value) {
  if (typeof value !== 'string' || !value || value.length > 2000) refuse(400, BAD_ADDRESS);
  let url;
  try { url = new URL(value); } catch { refuse(400, BAD_ADDRESS); }
  // Only plain https on its usual port; nothing that carries a user name or password.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) refuse(400, BAD_ADDRESS);
  return url;
}

// Allows `max` calls per key (a visitor's address) in each window.
export function createRateLimit(max, windowMs = 60_000) {
  const windows = new Map();
  return (key, now = Date.now()) => {
    for (const [id, times] of windows) if (times.at(-1) <= now - windowMs) windows.delete(id);
    const times = (windows.get(key) ?? []).filter((time) => time > now - windowMs);
    if (times.length >= max) return false;
    times.push(now);
    windows.set(key, times);
    return true;
  };
}

export function createPhotoFetcher({
  lookup = dnsLookup, request = httpsRequest, maxBytes = 8 * 1024 * 1024, timeoutMs = 10_000, maxRedirects = 3,
} = {}) {
  // The addresses a host name resolves to, all of them public; null for a host that already is an address.
  async function publicAddresses(hostname, aborted) {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      if (!isPublicAddress(host)) refuse(400, NOT_PUBLIC);
      return null;
    }
    let found;
    try {
      found = await Promise.race([lookup(host, { all: true }), aborted]);
    } catch (error) {
      if (error instanceof PhotoError) throw error;
      refuse(502, UNREACHABLE);
    }
    if (!Array.isArray(found) || !found.length) refuse(502, UNREACHABLE);
    if (found.some((entry) => !isPublicAddress(entry.address))) refuse(400, NOT_PUBLIC);
    return found;
  }

  function open(url, addresses, signal) {
    return new Promise((resolveResponse, rejectResponse) => {
      const options = {
        method: 'GET', signal, agent: false,
        headers: { accept: 'image/jpeg, image/png, image/webp', 'accept-encoding': 'identity', 'user-agent': 'MundosCruzados/1.0' },
      };
      // Connect to the addresses that were checked, not to whatever the name resolves to a moment later.
      if (addresses) {
        options.lookup = (_host, lookupOptions, callback) => {
          if (lookupOptions?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        };
      }
      request(url, options, resolveResponse).on('error', rejectResponse).end();
    });
  }

  return async function fetchPhoto(address) {
    let url = parseAddress(address);
    const controller = new AbortController();
    let onAbort;
    const aborted = new Promise((_, rejectAborted) => {
      onAbort = () => rejectAborted(new PhotoError(504, 'La foto tardó demasiado en descargarse.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const addresses = await publicAddresses(url.hostname, aborted);
        const response = await open(url, addresses, controller.signal);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          let next;
          try { next = new URL(String(response.headers.location ?? ''), url).href; } catch { refuse(502, UNREACHABLE); }
          url = parseAddress(next);
          continue;
        }
        if (response.statusCode !== 200) {
          response.destroy();
          refuse(502, UNREACHABLE);
        }
        const tooLarge = () => {
          response.destroy();
          refuse(413, `La foto supera ${Math.round(maxBytes / 1024 / 1024)} MB.`);
        };
        if (Number(response.headers['content-length']) > maxBytes) tooLarge();
        const chunks = [];
        let total = 0;
        for await (const chunk of response) {
          total += chunk.length;
          if (total > maxBytes) tooLarge();
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        // The file's own first bytes decide what it is; the other site's content type is not trusted.
        const type = imageType(data);
        if (!type) refuse(415, 'La foto debe ser JPEG, PNG o WebP.');
        return { data, type };
      }
      return refuse(502, UNREACHABLE);
    } catch (error) {
      if (controller.signal.aborted) refuse(504, 'La foto tardó demasiado en descargarse.');
      if (error instanceof PhotoError) throw error;
      return refuse(502, UNREACHABLE);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
}
