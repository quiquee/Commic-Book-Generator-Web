import sharp from 'sharp';
import {
  apiErrorMessage, fatalGenerationMessage, generateBeat, generateImage, generatePersona, generateStyleGuide, isApiKeyError,
  isContentBlockedError,
} from './generation.ts';
import { faceId, faceType, findFace, isStoryFinished, nextPageToGenerate, pendingDecision, previousImage } from './storyLogic.ts';
import { DECISION_PAGES } from './types.ts';

// Re-encodes a generated image (data URL or bare base64) as a bounded JPEG, as the browser used to do.
export async function toJpegBase64(image, maxDimension = 1024, quality = 85) {
  const data = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
  const output = await sharp(Buffer.from(data, 'base64'))
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer();
  return output.toString('base64');
}

function context(story) {
  return {
    hero: story.hero, friend: story.friend, hostName: story.hostName, guestName: story.guestName,
    settings: story.settings, tone: story.tone, styleGuide: story.styleGuide, title: story.title,
  };
}

/**
 * Generates comics on the server, so they keep progressing when nobody has the page open.
 * getStory(id) reads a record; updateStory(id, mutate) applies mutate(record) atomically, bumping its version
 * before mutate runs, and returns the saved record (or null when it no longer exists).
 * aiFor(record) returns a GoogleGenAI client; notify(record, event) is told about 'decision' and 'finished'.
 */
export function createStoryWorker({
  getStory, updateStory, aiFor, notify = async () => {}, concurrency = 2, log = console,
}) {
  const queue = [];
  const running = new Set();
  const rerun = new Set();
  let stopped = false;

  const setStatus = (id, generation) => updateStory(id, (story) => {
    story.generation = { ...generation, at: Date.now() };
  });

  // Saves a page like the faces endpoint does: a decision already taken on it is never lost.
  const putFace = (id, face) => updateStory(id, (story) => {
    const index = story.faces.findIndex((item) => item.id === face.id);
    const saved = { ...face };
    if (index >= 0 && Object.hasOwn(story.faces[index], 'resolvedChoice')) saved.resolvedChoice = story.faces[index].resolvedChoice;
    else delete saved.resolvedChoice;
    saved.version = story.version;
    if (index < 0) story.faces.push(saved);
    else story.faces[index] = saved;
  });

  async function generatePage(ai, story, pageIndex) {
    const id = faceId(pageIndex);
    const type = faceType(pageIndex);
    const isDecision = DECISION_PAGES.includes(pageIndex);
    let face = { id, type, pageIndex, isLoading: true, isDecisionPage: isDecision, choices: [] };
    story = await putFace(story.id, face) ?? story;

    let beat = { scene: 'Thematic teaser image', choices: [], focus_char: 'other' };
    if (type === 'story') {
      beat = await generateBeat(ai, context(story), story.faces, pageIndex, isDecision);
      if (stopped) return;
      if (beat.focus_char === 'friend' && !story.friend) {
        try {
          const name = story.guestName || (story.settings.genre === 'Custom'
            ? 'A fitting sidekick for this story' : `Sidekick for ${story.settings.genre} story.`);
          const persona = await generatePersona(ai, context(story), name);
          const friend = { base64: await toJpegBase64(persona.base64, 768), desc: persona.desc };
          story = await updateStory(story.id, (record) => { record.friend = friend; }) ?? story;
        } catch (error) {
          log.warn?.(`No se pudo crear el personaje secundario de ${story.id}: ${apiErrorMessage(error)}`);
          beat.focus_char = 'other';
        }
      }
      face = { ...face, narrative: beat, choices: beat.choices };
      story = await putFace(story.id, face) ?? story;
    }

    const raw = await generateImage(ai, context(story), beat, type, previousImage(story.faces, pageIndex), pageIndex);
    if (stopped) return;
    face = { ...face, imageUrl: `data:image/jpeg;base64,${await toJpegBase64(raw)}`, isLoading: false };
    await putFace(story.id, face);
  }

  async function process(id) {
    while (!stopped) {
      let story = await getStory(id);
      if (!story) return;
      try {
        const ai = aiFor(story);
        if (!story.styleGuide) {
          await setStatus(id, { state: 'styling' });
          const styleGuide = await generateStyleGuide(ai, context(story));
          if (stopped) return;
          await updateStory(id, (record) => { record.styleGuide = styleGuide; });
          continue;
        }
        const next = nextPageToGenerate(story.faces);
        if (next === null) {
          const finished = isStoryFinished(story.faces);
          const decision = finished ? null : pendingDecision(story.faces);
          // Each event (the end, or a given decision page) is notified once, even across restarts.
          const event = finished ? 'finished' : decision ? `decision:${decision.id}` : null;
          let firstTime = false;
          story = await updateStory(id, (record) => {
            record.generation = { state: finished ? 'finished' : 'waiting', at: Date.now() };
            record.notified = Array.isArray(record.notified) ? record.notified : [];
            if (event && !record.notified.includes(event)) {
              record.notified.push(event);
              firstTime = true;
            }
          }) ?? story;
          if (firstTime) {
            try {
              await notify(story, finished ? 'finished' : 'decision');
            } catch (error) {
              log.warn?.(`No se pudo enviar la notificación de ${id}: ${error?.message ?? error}`);
            }
          }
          return;
        }
        await setStatus(id, { state: 'generating', pageIndex: next });
        await generatePage(ai, story, next);
      } catch (error) {
        if (stopped) return;
        // The first error stops the comic and is shown to the reader: retrying a refusal wastes money and
        // anything else is for the owner to retry or fix on purpose.
        const reason = fatalGenerationMessage(error)
          ?? (isApiKeyError(error) ? 'La clave de la API no es válida.' : null) ?? apiErrorMessage(error);
        const blocked = isContentBlockedError(error);
        const detail = blocked ? /CONTENIDO_BLOQUEADO:\s*(\S+)/.exec(apiErrorMessage(error))?.[1] : undefined;
        await setStatus(id, { state: 'stopped', reason, ...(blocked ? { blocked: true } : {}), ...(detail ? { detail } : {}) });
        log.error?.(`Generación detenida para ${id}: ${reason}${detail ? ` (${detail})` : ''}`);
        return;
      }
    }
  }

  function pump() {
    while (!stopped && running.size < concurrency && queue.length) {
      const id = queue.shift();
      running.add(id);
      process(id)
        .catch((error) => log.error?.(`Error inesperado generando ${id}: ${error?.message ?? error}`))
        .finally(() => {
          running.delete(id);
          if (rerun.delete(id)) queue.push(id);
          pump();
        });
    }
  }

  return {
    // Idempotent: a comic already queued or generating is checked again once its current run ends.
    start(id) {
      if (stopped) return;
      if (running.has(id)) rerun.add(id);
      else if (!queue.includes(id)) queue.push(id);
      pump();
    },
    isActive: (id) => running.has(id) || queue.includes(id),
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}
