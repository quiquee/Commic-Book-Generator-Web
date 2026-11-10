import { BACK_COVER_PAGE, DECISION_PAGES, MAX_SCENE_PAGES, TOTAL_PAGES, type ComicFace } from './types.ts';

export function faceId(pageIndex: number): string {
    return pageIndex === 0 ? 'cover' : `page-${pageIndex}`;
}

export function faceType(pageIndex: number): ComicFace['type'] {
    if (pageIndex === 0) return 'cover';
    return pageIndex === BACK_COVER_PAGE ? 'back_cover' : 'story';
}

export function isComplete(face: ComicFace | undefined): boolean {
    return !!face && !face.isLoading && !!face.imageUrl;
}

export function findFace(faces: ComicFace[], pageIndex: number): ComicFace | undefined {
    return faces.find(face => (face.pageIndex ?? -1) === pageIndex);
}

// Pages after a decision wait for that decision so its consequences appear immediately on the next page.
export function isUnlocked(pageIndex: number, faces: ComicFace[]): boolean {
    return DECISION_PAGES.every(decision => pageIndex <= decision || !!findFace(faces, decision)?.resolvedChoice);
}

export function nextPageToGenerate(faces: ComicFace[]): number | null {
    for (let pageIndex = 0; pageIndex <= TOTAL_PAGES; pageIndex++) {
        if (isComplete(findFace(faces, pageIndex))) continue;
        return isUnlocked(pageIndex, faces) ? pageIndex : null;
    }
    return null;
}

export function isStoryFinished(faces: ComicFace[]): boolean {
    for (let pageIndex = 0; pageIndex <= TOTAL_PAGES; pageIndex++) {
        if (!isComplete(findFace(faces, pageIndex))) return false;
    }
    return true;
}

export function pendingDecision(faces: ComicFace[]): ComicFace | null {
    return faces.find(face => face.isDecisionPage && isComplete(face) && !face.resolvedChoice) ?? null;
}

export function sortFaces(faces: ComicFace[]): ComicFace[] {
    return [...faces].sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));
}

// Guests take the server state verbatim; the owner keeps local page content and only adopts remote decisions.
export function mergeFaces(local: ComicFace[], remote: ComicFace[], role: 'owner' | 'guest'): ComicFace[] {
    const byId = new Map(local.map(face => [face.id, face]));
    for (const incoming of remote) {
        const current = byId.get(incoming.id);
        if (!current || role === 'guest') {
            byId.set(incoming.id, incoming);
            continue;
        }
        if (incoming.resolvedChoice && !current.resolvedChoice) {
            byId.set(incoming.id, { ...current, resolvedChoice: incoming.resolvedChoice, version: incoming.version });
        }
    }
    return sortFaces([...byId.values()]);
}

export function upsertFace(faces: ComicFace[], face: ComicFace): ComicFace[] {
    const others = faces.filter(candidate => candidate.id !== face.id);
    return sortFaces([...others, face]);
}

export function previousImage(faces: ComicFace[], pageIndex: number): string | null {
    for (let candidate = pageIndex - 1; candidate >= 0; candidate--) {
        const face = findFace(faces, candidate);
        if (isComplete(face)) return face!.imageUrl!;
    }
    return null;
}

// How many consecutive pages (ending just before `pageNum`) have taken place in the same location.
// Pages from before scenes were tracked count as a scene of their own.
export function sceneRun(faces: ComicFace[], pageNum: number): number {
    const pages = faces
        .filter(face => face.type === 'story' && face.narrative && (face.pageIndex ?? 0) < pageNum)
        .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));
    let run = 0;
    for (let index = pages.length - 1; index >= 0; index--) {
        run++;
        if (pages[index].narrative!.new_scene !== false) break;
    }
    return run;
}

// The image of the page that opened the current location, when it is not the previous page itself.
export function sceneStartImage(faces: ComicFace[], pageNum: number): string | null {
    const run = sceneRun(faces, pageNum);
    if (run < 2) return null;
    const pages = faces
        .filter(face => face.type === 'story' && face.narrative && (face.pageIndex ?? 0) < pageNum)
        .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0));
    const start = pages[pages.length - run];
    return start && isComplete(start) ? start.imageUrl! : null;
}

// The first page of an issue and any page after a full-length scene must change location.
export function mustChangeScene(faces: ComicFace[], pageNum: number): boolean {
    const run = sceneRun(faces, pageNum);
    return run === 0 || run >= MAX_SCENE_PAGES;
}

// Sound effects shown while a page is drawn: the stock ones Gemini keeps repeating are dropped.
const STOCK_SOUNDS = new Set(['GLUP', 'GLUPS', 'CHOF', 'CATAPLUM', 'CATAPLÚM', 'POW', 'BAM', 'BOOM', 'ZAS', 'PUM']);

export function cleanSoundEffects(raw: unknown): string[] {
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('|') : [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        if (typeof item !== 'string') continue;
        const word = item.replace(/\s+/g, ' ').trim().slice(0, 24);
        const key = word.replace(/[¡!¿?\s]/g, '').toUpperCase();
        if (!key || STOCK_SOUNDS.has(key) || seen.has(key)) continue;
        seen.add(key);
        result.push(word);
    }
    return result.slice(0, 12);
}

// The character bible holds two parts: the look (for the artist) and, after this line, the story engine (for the writer):
// the quest that keeps the plot moving and the inner life of the cast.
export const INNER_LIFE_HEADING = '=== INNER LIFE ===';

export function splitStyleGuide(guide: string | undefined): { look: string; innerLife: string } {
    const text = guide ?? '';
    const at = text.indexOf(INNER_LIFE_HEADING);
    if (at < 0) return { look: text.trim(), innerLife: '' };
    return { look: text.slice(0, at).trim(), innerLife: text.slice(at + INNER_LIFE_HEADING.length).trim() };
}

// Feelings offered as inspiration when the inner life of the cast is written, so comics do not all hinge on the same one.
export const EMOTIONAL_SPARKS = [
    'envy of someone they love', 'guilt over a small lie that grew', 'fear of being left behind', 'pride that refuses to ask for help',
    'longing to be taken seriously', 'shame about where they come from', 'a debt of gratitude they resent', 'homesickness for a place that changed',
    'jealousy they will not admit', 'feeling like an impostor', 'protectiveness that smothers', 'loyalty pulled in two directions',
    'grief nobody talks about', 'the need to be admired', 'resentment over an old slight', 'fear of disappointing a parent',
    'boredom with the life they chose', 'tenderness they hide behind jokes', 'doubt about a promise they made', 'wanting to be forgiven',
    'fear of growing apart', 'restlessness for something new', 'being tired of always being the strong one', 'a secret wish to quit',
    'nostalgia for who they used to be', 'dread of being ordinary', 'unspoken admiration', 'anger at themselves for staying silent',
    'curiosity about what the other is hiding', 'wanting to cheer someone up without knowing how', 'admiring a courage they lack', 'worry for someone who says they are fine',
    'wanting to understand a choice they would never make', 'gratitude they have never managed to say', 'noticing that a friend has changed', 'the urge to protect someone who did not ask',
];

export function pickSparks(count: number, random: () => number = Math.random): string[] {
    const pool = [...EMOTIONAL_SPARKS];
    const picked: string[] = [];
    while (picked.length < count && pool.length) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    return picked;
}
