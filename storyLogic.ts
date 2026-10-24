import { BACK_COVER_PAGE, DECISION_PAGES, TOTAL_PAGES, type ComicFace } from './types.ts';

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
