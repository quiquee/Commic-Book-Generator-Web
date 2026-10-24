import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FACE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_FACE_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_INVITATIONS = 1000;
const MAX_STORIES = 500;
const MAX_RESPONSES = 20;
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const GENRES = new Set([
  'Classic Horror',
  'Superhero Action',
  'Dark Sci-Fi',
  'High Fantasy',
  'Neon Noir Detective',
  'Wasteland Apocalypse',
  'Lighthearted Comedy',
  'Teen Drama / Slice of Life',
  'Custom',
]);
const LANGUAGES = new Set(['es-ES', 'en-US', 'fr-FR', 'gl-ES', 'de-DE']);
const CONTENT_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.otf', 'font/otf'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.webm', 'video/webm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validateString(value, label, maxLength, { optional = false } = {}) {
  if (optional && value === '') return value;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail(400, `El campo ${label} no es válido.`);
  }
  return value.trim();
}

function validateJpegData(value, label, maxBytes) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(maxBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    fail(400, `La imagen de ${label} no es un JPEG válido.`);
  }
  const image = Buffer.from(value, 'base64');
  if (
    image.length === 0
    || image.length > maxBytes
    || image.toString('base64') !== value
    || image[0] !== 0xff
    || image[1] !== 0xd8
    || image[2] !== 0xff
    || image[image.length - 2] !== 0xff
    || image[image.length - 1] !== 0xd9
  ) {
    fail(400, `La imagen de ${label} no es un JPEG válido.`);
  }
}

function validatePersona(value, label) {
  if (!exactKeys(value, ['base64', 'desc'])) fail(400, `El campo ${label} no es válido.`);
  validateJpegData(value.base64, label, MAX_IMAGE_BYTES);
  return {
    base64: value.base64,
    desc: validateString(value.desc, `${label}.desc`, 1000),
  };
}

function validateSettings(value) {
  if (!exactKeys(value, ['genre', 'language', 'premise', 'richMode'])) {
    fail(400, 'La configuración no es válida.');
  }
  if (!GENRES.has(value.genre)) fail(400, 'El género no es válido.');
  if (!LANGUAGES.has(value.language)) fail(400, 'El idioma no es válido.');
  if (typeof value.richMode !== 'boolean') fail(400, 'El modo de narración no es válido.');
  const premise = validateString(value.premise, 'premise', 2000, { optional: true });
  if (value.genre === 'Custom' && premise.trim().length === 0) {
    fail(400, 'El campo premise es obligatorio para el género Custom.');
  }
  return { genre: value.genre, language: value.language, premise, richMode: value.richMode };
}

function validateStoryCreate(body) {
  if (!exactKeys(body, [
    'title', 'hostName', 'guestName', 'hero', 'friend', 'settings', 'tone', 'invitation',
  ])) {
    fail(400, 'El cuerpo de la historia no es válido.');
  }
  let invitation = null;
  if (body.invitation !== null) {
    if (!exactKeys(body.invitation, ['id', 'ownerToken']) || typeof body.invitation.id !== 'string'
      || typeof body.invitation.ownerToken !== 'string') {
      fail(400, 'La invitación vinculada no es válida.');
    }
    invitation = { id: body.invitation.id, ownerToken: body.invitation.ownerToken };
  }
  return {
    title: validateString(body.title, 'title', 120),
    hostName: validateString(body.hostName, 'hostName', 80),
    guestName: validateString(body.guestName, 'guestName', 80, { optional: true }),
    hero: validatePersona(body.hero, 'hero'),
    friend: body.friend === null ? null : validatePersona(body.friend, 'friend'),
    settings: validateSettings(body.settings),
    tone: validateString(body.tone, 'tone', 200),
    styleGuide: '',
    invitation,
  };
}

function validateFace(body, faceId) {
  const allowed = [
    'id', 'type', 'pageIndex', 'isLoading', 'isDecisionPage', 'choices',
    'narrative', 'imageUrl', 'resolvedChoice',
  ];
  if (!isObject(body) || Object.keys(body).some((key) => !allowed.includes(key))
    || !['id', 'type', 'pageIndex', 'isLoading', 'isDecisionPage', 'choices'].every((key) => Object.hasOwn(body, key))) {
    fail(400, 'La página de la historia no es válida.');
  }
  const idMatch = /^(cover|page-(?:[1-9]|1[01]))$/.exec(faceId);
  if (!idMatch || body.id !== faceId) fail(400, 'El identificador de la página no coincide.');
  const isCover = faceId === 'cover';
  const pageIndex = isCover ? 0 : Number(faceId.slice(5));
  const expectedType = isCover ? 'cover' : pageIndex === 11 ? 'back_cover' : 'story';
  if (body.pageIndex !== pageIndex || body.type !== expectedType) {
    fail(400, 'El tipo o índice de la página no coincide con su identificador.');
  }
  if (typeof body.isLoading !== 'boolean' || typeof body.isDecisionPage !== 'boolean') {
    fail(400, 'El estado de la página no es válido.');
  }
  if (!Array.isArray(body.choices) || body.choices.length > 4
    || body.choices.some((choice) => typeof choice !== 'string' || choice.length > 200)) {
    fail(400, 'Las opciones de la página no son válidas.');
  }
  const face = {
    id: faceId,
    type: expectedType,
    pageIndex,
    isLoading: body.isLoading,
    isDecisionPage: body.isDecisionPage,
    choices: body.choices,
  };
  if (Object.hasOwn(body, 'narrative')) {
    const narrative = body.narrative;
    if (!isObject(narrative)
      || Object.keys(narrative).some((key) => !['caption', 'dialogue', 'scene', 'choices', 'focus_char'].includes(key))
      || !['scene', 'choices', 'focus_char'].every((key) => Object.hasOwn(narrative, key))
      || typeof narrative.scene !== 'string' || narrative.scene.length > 2000
      || !Array.isArray(narrative.choices) || narrative.choices.length > 4
      || narrative.choices.some((choice) => typeof choice !== 'string' || choice.length > 200)
      || !['hero', 'friend', 'other'].includes(narrative.focus_char)
      || (Object.hasOwn(narrative, 'caption')
        && (typeof narrative.caption !== 'string' || narrative.caption.length > 500))
      || (Object.hasOwn(narrative, 'dialogue')
        && (typeof narrative.dialogue !== 'string' || narrative.dialogue.length > 500))) {
      fail(400, 'La narración de la página no es válida.');
    }
    face.narrative = {
      ...(Object.hasOwn(narrative, 'caption') ? { caption: narrative.caption } : {}),
      ...(Object.hasOwn(narrative, 'dialogue') ? { dialogue: narrative.dialogue } : {}),
      scene: narrative.scene,
      choices: narrative.choices,
      focus_char: narrative.focus_char,
    };
  }
  if (Object.hasOwn(body, 'imageUrl')) {
    const prefix = 'data:image/jpeg;base64,';
    if (typeof body.imageUrl !== 'string' || !body.imageUrl.startsWith(prefix)) {
      fail(400, 'La imagen de la página debe ser un JPEG válido.');
    }
    validateJpegData(body.imageUrl.slice(prefix.length), 'la página', MAX_FACE_IMAGE_BYTES);
    face.imageUrl = body.imageUrl;
  }
  if (Object.hasOwn(body, 'resolvedChoice')) {
    if (typeof body.resolvedChoice !== 'string' || body.resolvedChoice.length > 200) {
      fail(400, 'La opción resuelta no es válida.');
    }
    face.resolvedChoice = body.resolvedChoice;
  }
  return face;
}

function validateInvitation(body) {
  if (!exactKeys(body, ['hostName', 'guestName', 'hero', 'settings'])) {
    fail(400, 'El cuerpo de la invitación no es válido.');
  }
  if (!exactKeys(body.settings, ['genre', 'language', 'premise', 'richMode'])) {
    fail(400, 'La configuración no es válida.');
  }
  const settings = body.settings;
  if (!GENRES.has(settings.genre)) fail(400, 'El género no es válido.');
  if (!LANGUAGES.has(settings.language)) fail(400, 'El idioma no es válido.');
  if (typeof settings.richMode !== 'boolean') fail(400, 'El modo de narración no es válido.');
  const premise = validateString(settings.premise, 'premise', 2000, { optional: true });
  if (settings.genre === 'Custom' && premise.trim().length === 0) {
    fail(400, 'El campo premise es obligatorio para el género Custom.');
  }
  return {
    hostName: validateString(body.hostName, 'hostName', 80),
    guestName: validateString(body.guestName, 'guestName', 80),
    hero: validatePersona(body.hero, 'hero'),
    settings: {
      genre: settings.genre,
      language: settings.language,
      premise,
      richMode: settings.richMode,
    },
  };
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') fail(415, 'El contenido debe ser JSON.');

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) fail(413, 'El cuerpo de la solicitud supera el límite permitido.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, 'El JSON de la solicitud no es válido.');
  }
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(data);
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireToken(request, expected) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '');
  if (!match || !tokenMatches(match[1], expected)) fail(401, 'No tienes autorización para esta invitación.');
}

function safeInvitationId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function publicInvitation(record) {
  return {
    id: record.id,
    hostName: record.hostName,
    guestName: record.guestName,
    hero: record.hero,
    settings: record.settings,
  };
}

async function getStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidate = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try {
    const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    const resolvedRel = relative(resolvedRoot, resolvedCandidate);
    if (resolvedRel === '..' || resolvedRel.startsWith(`..${sep}`) || isAbsolute(resolvedRel)) return null;
    const details = await stat(resolvedCandidate);
    if (!details.isFile()) return null;
    return { path: resolvedCandidate, size: details.size };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return null;
    throw error;
  }
}

async function serveStatic(request, response, root) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const rootPath = resolve(root);
  let file = await getStaticPath(rootPath, pathname);
  if (!file) file = await getStaticPath(rootPath, '/index.html');
  if (!file) {
    sendJson(response, 404, { error: 'No se encontró la aplicación.' });
    return;
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES.get(extname(file.path).toLowerCase()) ?? 'application/octet-stream',
    'content-length': file.size,
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file.path).on('error', (error) => {
    if (!response.headersSent) sendJson(response, 500, { error: 'No se pudo servir el archivo.' });
    else response.destroy(error);
  }).pipe(response);
}

export function createAppServer({
  dataDir = join(process.cwd(), '.data', 'invitations'),
  storiesDir = join(process.cwd(), '.data', 'stories'),
  dev = false,
} = {}) {
  const storageDir = resolve(dataDir);
  const storyStorageDir = resolve(storiesDir);
  let operationQueue = Promise.resolve();
  let vitePromise;

  const serialize = (operation) => {
    const result = operationQueue.then(operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  async function prepareStorage() {
    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    await chmod(storageDir, 0o700);
  }

  async function prepareStoryStorage() {
    await mkdir(storyStorageDir, { recursive: true, mode: 0o700 });
    await chmod(storyStorageDir, 0o700);
  }

  function invitationFilePath(id) {
    if (!safeInvitationId(id)) fail(404, 'No se encontró la invitación.');
    return join(storageDir, `${id}.json`);
  }

  function storyFilePath(id) {
    if (!safeInvitationId(id)) fail(404, 'No se encontró la historia.');
    return join(storyStorageDir, `${id}.json`);
  }

  async function loadRecord(id) {
    let record;
    try {
      record = JSON.parse(await readFile(invitationFilePath(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') fail(404, 'No se encontró la invitación.');
      throw error;
    }
    if (!isObject(record) || record.id !== id) fail(500, 'No se pudieron leer los datos de la invitación.');
    const expired = !Number.isFinite(record.createdAt) || Date.now() - record.createdAt >= LIFETIME_MS;
    const hasStories = Array.isArray(record.storyIds) && record.storyIds.length > 0;
    if (expired && !hasStories) {
      await rm(invitationFilePath(id), { force: true });
      fail(404, 'La invitación ha caducado o no existe.');
    }
    return record;
  }

  async function removeExpiredAndCount() {
    const entries = await readdir(storageDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      const match = /^([0-9a-f-]{36})\.json$/i.exec(entry.name);
      if (!entry.isFile() || !match || !safeInvitationId(match[1])) continue;
      let record;
      try {
        record = JSON.parse(await readFile(join(storageDir, entry.name), 'utf8'));
      } catch (error) {
        throw new Error(`No se pudo leer el archivo de invitación ${entry.name}.`, { cause: error });
      }
      const hasStories = Array.isArray(record?.storyIds) && record.storyIds.length > 0;
      if ((!Number.isFinite(record?.createdAt) || Date.now() - record.createdAt >= LIFETIME_MS)
        && !hasStories) {
        await rm(join(storageDir, entry.name), { force: true });
      } else {
        count += 1;
      }
    }
    return count;
  }

  async function saveRecord(record) {
    const target = invitationFilePath(record.id);
    const temporary = join(storageDir, `.${record.id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function loadStory(id) {
    let record;
    try {
      record = JSON.parse(await readFile(storyFilePath(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') fail(404, 'No se encontró la historia.');
      throw error;
    }
    if (!isObject(record) || record.id !== id) fail(500, 'No se pudieron leer los datos de la historia.');
    return record;
  }

  async function saveStory(record) {
    const target = storyFilePath(record.id);
    const temporary = join(storyStorageDir, `.${record.id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function participantRole(request, story) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '');
    if (!match) fail(401, 'No tienes autorización para esta historia.');
    if (tokenMatches(match[1], story.ownerToken)) return 'owner';
    if (story.invitationId) {
      let invitation;
      try {
        invitation = await loadRecord(story.invitationId);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          fail(401, 'No tienes autorización para esta historia.');
        }
        throw error;
      }
      if (tokenMatches(match[1], invitation.guestToken)) return 'guest';
    }
    fail(401, 'No tienes autorización para esta historia.');
  }

  async function linkedStories(invitation) {
    const summaries = [];
    for (const storyId of Array.isArray(invitation.storyIds) ? invitation.storyIds : []) {
      if (!safeInvitationId(storyId)) continue;
      let story;
      try {
        story = await loadStory(storyId);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) continue;
        throw error;
      }
      summaries.push({
        id: story.id,
        title: story.title,
        createdAt: story.createdAt,
        updatedAt: story.updatedAt,
        completedPages: story.faces.filter((face) => face.imageUrl && !face.isLoading).length,
        totalPages: 12,
      });
    }
    return summaries;
  }

  async function handleStories(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 2 && request.method === 'POST') {
      const body = validateStoryCreate(await readJsonBody(request));
      const created = await serialize(async () => {
        await prepareStoryStorage();
        const entries = await readdir(storyStorageDir, { withFileTypes: true });
        const count = entries.filter((entry) => entry.isFile()
          && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(entry.name)).length;
        if (count >= MAX_STORIES) fail(503, 'Se alcanzó el límite de historias almacenadas.');

        let invitation = null;
        if (body.invitation) {
          await prepareStorage();
          if (!safeInvitationId(body.invitation.id)) {
            fail(401, 'No tienes autorización para vincular esta invitación.');
          }
          try {
            invitation = await loadRecord(body.invitation.id);
          } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
              fail(401, 'No tienes autorización para vincular esta invitación.');
            }
            throw error;
          }
          if (!tokenMatches(body.invitation.ownerToken, invitation.ownerToken)) {
            fail(401, 'No tienes autorización para vincular esta invitación.');
          }
        }

        const now = Date.now();
        const story = {
          id: randomUUID(),
          ownerToken: randomBytes(32).toString('base64url'),
          invitationId: invitation?.id ?? null,
          title: body.title,
          hostName: body.hostName,
          guestName: body.guestName,
          hero: body.hero,
          friend: body.friend,
          settings: body.settings,
          tone: body.tone,
          styleGuide: '',
          faces: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
        await saveStory(story);
        if (invitation) {
          invitation.storyIds = Array.isArray(invitation.storyIds) ? invitation.storyIds : [];
          invitation.storyIds.push(story.id);
          try {
            await saveRecord(invitation);
          } catch (error) {
            await rm(storyFilePath(story.id), { force: true });
            throw error;
          }
        }
        return story;
      });
      sendJson(response, 201, { id: created.id, ownerToken: created.ownerToken });
      return;
    }

    if (segments.length < 3 || segments.length > 5) {
      sendJson(response, 404, { error: 'No se encontró la ruta de la API.' });
      return;
    }
    const id = segments[2];
    if (!safeInvitationId(id)) fail(404, 'No se encontró la historia.');

    if (segments.length === 3 && request.method === 'GET') {
      const hasAfter = url.searchParams.has('after');
      let after = 0;
      if (hasAfter) {
        const values = url.searchParams.getAll('after');
        if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(values[0])) {
          fail(400, 'El parámetro after no es válido.');
        }
        after = Number(values[0]);
        if (!Number.isSafeInteger(after)) fail(400, 'El parámetro after no es válido.');
      }
      const result = await serialize(async () => {
        await prepareStoryStorage();
        const story = await loadStory(id);
        const role = await participantRole(request, story);
        return {
          id: story.id,
          title: story.title,
          hostName: story.hostName,
          guestName: story.guestName,
          settings: story.settings,
          tone: story.tone,
          styleGuide: story.styleGuide,
          version: story.version,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          totalPages: 12,
          completedPages: story.faces.filter((face) => face.imageUrl && !face.isLoading).length,
          role,
          faces: hasAfter ? story.faces.filter((face) => face.version > after) : story.faces,
          ...(!hasAfter ? { hero: story.hero, friend: story.friend } : {}),
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 3 && request.method === 'PATCH') {
      const body = await readJsonBody(request);
      const editable = ['friend', 'styleGuide', 'tone', 'title'];
      if (!isObject(body) || Object.keys(body).length === 0
        || Object.keys(body).some((key) => !editable.includes(key))) {
        fail(400, 'Los cambios de la historia no son válidos.');
      }
      const changes = {};
      if (Object.hasOwn(body, 'friend')) {
        changes.friend = body.friend === null ? null : validatePersona(body.friend, 'friend');
      }
      if (Object.hasOwn(body, 'styleGuide')) {
        if (typeof body.styleGuide !== 'string' || body.styleGuide.length > 4000) {
          fail(400, 'El campo styleGuide no es válido.');
        }
        changes.styleGuide = body.styleGuide;
      }
      if (Object.hasOwn(body, 'tone')) changes.tone = validateString(body.tone, 'tone', 200);
      if (Object.hasOwn(body, 'title')) changes.title = validateString(body.title, 'title', 120);
      const result = await serialize(async () => {
        await prepareStoryStorage();
        const story = await loadStory(id);
        const role = await participantRole(request, story);
        if (role !== 'owner') fail(403, 'Solo quien creó la historia puede modificarla.');
        Object.assign(story, changes);
        story.version += 1;
        story.updatedAt = Date.now();
        await saveStory(story);
        return { version: story.version };
      });
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 5 && segments[3] === 'faces' && request.method === 'PUT') {
      const body = await readJsonBody(request, MAX_FACE_BODY_BYTES);
      const face = validateFace(body, segments[4]);
      const result = await serialize(async () => {
        await prepareStoryStorage();
        const story = await loadStory(id);
        const role = await participantRole(request, story);
        if (role !== 'owner') fail(403, 'Solo quien creó la historia puede modificarla.');
        const index = story.faces.findIndex((item) => item.id === face.id);
        if (index < 0 && story.faces.length >= 12) fail(409, 'La historia ya tiene el máximo de páginas.');
        if (index >= 0 && Object.hasOwn(story.faces[index], 'resolvedChoice')) {
          face.resolvedChoice = story.faces[index].resolvedChoice;
        }
        story.version += 1;
        face.version = story.version;
        if (index < 0) story.faces.push(face);
        else story.faces[index] = face;
        story.updatedAt = Date.now();
        await saveStory(story);
        return { version: story.version };
      });
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 4 && segments[3] === 'choices' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!exactKeys(body, ['faceId', 'choice'])
        || typeof body.faceId !== 'string' || typeof body.choice !== 'string') {
        fail(400, 'La opción seleccionada no es válida.');
      }
      const result = await serialize(async () => {
        await prepareStoryStorage();
        const story = await loadStory(id);
        await participantRole(request, story);
        const face = story.faces.find((item) => item.id === body.faceId);
        if (!face) fail(404, 'No se encontró la página de la historia.');
        if (!face.isDecisionPage || !face.choices.includes(body.choice)) {
          fail(400, 'La opción no está disponible para esta página.');
        }
        if (Object.hasOwn(face, 'resolvedChoice')) {
          return { conflict: true, resolvedChoice: face.resolvedChoice };
        }
        face.resolvedChoice = body.choice;
        story.version += 1;
        face.version = story.version;
        story.updatedAt = Date.now();
        await saveStory(story);
        return { version: story.version, faceId: face.id, resolvedChoice: face.resolvedChoice };
      });
      if (result.conflict) {
        sendJson(response, 409, { error: 'Esta página ya tiene una opción resuelta.', resolvedChoice: result.resolvedChoice });
      } else {
        sendJson(response, 200, result);
      }
      return;
    }

    if (segments.length === 3 && request.method === 'DELETE') {
      const result = await serialize(async () => {
        await prepareStoryStorage();
        const story = await loadStory(id);
        const role = await participantRole(request, story);
        if (role !== 'owner') fail(403, 'Solo quien creó la historia puede eliminarla.');
        await rm(storyFilePath(id), { force: true });
        if (story.invitationId) {
          await prepareStorage();
          const invitation = await loadRecord(story.invitationId);
          invitation.storyIds = (Array.isArray(invitation.storyIds) ? invitation.storyIds : [])
            .filter((storyId) => storyId !== id);
          await saveRecord(invitation);
        }
        return true;
      });
      if (result) {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
      }
      return;
    }

    sendJson(response, 404, { error: 'No se encontró la ruta de la API.' });
  }

  async function handleApi(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'api' && segments[1] === 'stories') {
      await handleStories(request, response, url);
      return;
    }
    if (segments[0] !== 'api' || segments[1] !== 'invitations') {
      sendJson(response, 404, { error: 'No se encontró la ruta de la API.' });
      return;
    }
    if (segments.length === 2 && request.method === 'POST') {
      const body = validateInvitation(await readJsonBody(request));
      const created = await serialize(async () => {
        await prepareStorage();
        if (await removeExpiredAndCount() >= MAX_INVITATIONS) {
          fail(503, 'Se alcanzó el límite de invitaciones almacenadas.');
        }
        const record = {
          id: randomUUID(),
          ownerToken: randomBytes(32).toString('base64url'),
          guestToken: randomBytes(32).toString('base64url'),
          ...body,
          responses: [],
          createdAt: Date.now(),
        };
        await saveRecord(record);
        return record;
      });
      sendJson(response, 201, {
        id: created.id,
        ownerToken: created.ownerToken,
        guestToken: created.guestToken,
      });
      return;
    }
    if (segments.length < 3 || segments.length > 5) {
      sendJson(response, 404, { error: 'No se encontró la ruta de la API.' });
      return;
    }
    const id = segments[2];
    if (!safeInvitationId(id)) fail(404, 'No se encontró la invitación.');

    if (segments.length === 3 && request.method === 'GET') {
      const result = await serialize(async () => {
        await prepareStorage();
        const record = await loadRecord(id);
        requireToken(request, record.ownerToken);
        return {
          id: record.id,
          hostName: record.hostName,
          guestName: record.guestName,
          hero: record.hero,
          settings: record.settings,
          responses: record.responses.map(({ id: responseId, name, persona, status }) => ({
            id: responseId, name, persona, status,
          })),
        };
      });
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 4 && segments[3] === 'join' && request.method === 'GET') {
      const result = await serialize(async () => {
        await prepareStorage();
        await prepareStoryStorage();
        const record = await loadRecord(id);
        requireToken(request, record.guestToken);
        return { ...publicInvitation(record), stories: await linkedStories(record) };
      });
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 4 && segments[3] === 'responses' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!exactKeys(body, ['persona'])) fail(400, 'El cuerpo de la respuesta no es válido.');
      const persona = validatePersona(body.persona, 'persona');
      const result = await serialize(async () => {
        await prepareStorage();
        const record = await loadRecord(id);
        requireToken(request, record.guestToken);
        if (record.responses.length >= MAX_RESPONSES) fail(409, 'La invitación ya tiene el máximo de respuestas.');
        const newResponse = { id: randomUUID(), name: record.guestName, persona, status: 'pending' };
        record.responses.push(newResponse);
        await saveRecord(record);
        return { id: newResponse.id, status: newResponse.status };
      });
      sendJson(response, 201, result);
      return;
    }

    if (segments.length === 5 && segments[3] === 'responses' && request.method === 'GET') {
      const responseId = segments[4];
      const result = await serialize(async () => {
        await prepareStorage();
        const record = await loadRecord(id);
        requireToken(request, record.guestToken);
        const found = record.responses.find((item) => item.id === responseId);
        if (!found) fail(404, 'No se encontró la respuesta.');
        return { id: found.id, status: found.status };
      });
      sendJson(response, 200, result);
      return;
    }

    if (segments.length === 4 && segments[3] === 'accept' && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (!exactKeys(body, ['responseId']) || typeof body.responseId !== 'string') {
        fail(400, 'La respuesta seleccionada no es válida.');
      }
      const result = await serialize(async () => {
        await prepareStorage();
        const record = await loadRecord(id);
        requireToken(request, record.ownerToken);
        const found = record.responses.find((item) => item.id === body.responseId);
        if (!found) fail(404, 'No se encontró la respuesta.');
        if (found.status !== 'pending' || record.responses.some((item) => item.status === 'accepted')) {
          fail(409, 'Ya se ha aceptado una respuesta para esta invitación.');
        }
        found.status = 'accepted';
        await saveRecord(record);
        return { id: found.id, status: found.status };
      });
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: 'No se encontró la ruta de la API.' });
  }

  function initializeVite() {
    if (!vitePromise) {
      vitePromise = import('vite').then(({ createServer: createViteServer }) => createViteServer({
        configFile: join(process.cwd(), 'vite.config.ts'),
        server: { middlewareMode: true },
        appType: 'spa',
      }));
    }
    return vitePromise;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'Método no permitido.' });
        return;
      }
      if (dev) {
        const vite = await initializeVite();
        await new Promise((resolveMiddleware, rejectMiddleware) => {
          vite.middlewares(request, response, (error) => {
            if (error) rejectMiddleware(error);
            else resolveMiddleware();
          });
        });
        return;
      }
      await serveStatic(request, response, join(process.cwd(), 'dist'));
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Error del servidor:', error);
      sendJson(response, status, {
        error: error instanceof HttpError ? error.message : 'Ocurrió un error interno del servidor.',
      });
    }
  });

  server.on('close', () => {
    if (vitePromise) vitePromise.then((vite) => vite.close()).catch((error) => {
      console.error('No se pudo cerrar Vite:', error);
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dev = process.argv.includes('--dev');
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT debe ser un puerto válido entre 0 y 65535.');
    process.exitCode = 1;
  } else {
    const server = createAppServer({ dev });
    server.listen(port, host, () => {
      const address = server.address();
      console.log(`Servidor escuchando en http://${host}:${address.port}${dev ? ' (desarrollo)' : ''}`);
    });
  }
}
