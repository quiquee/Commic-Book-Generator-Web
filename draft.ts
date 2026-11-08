import { GENRES, LANGUAGES } from './types.ts';

// What the person has typed in the setup screen, kept in the browser so a reload (or a phone discarding
// the tab) does not lose it.
export interface Draft {
    genre: string;
    language: string;
    premise: string;
    richMode: boolean;
    title: string;
}

export const draftKey = 'infinite-heroes.setup-draft';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function parseDraft(raw: string | null, now = Date.now()): Draft | null {
    if (!raw) return null;
    try {
        const saved: unknown = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return null;
        const item = saved as Record<string, unknown>;
        if (typeof item.savedAt !== 'number' || now - item.savedAt > MAX_AGE_MS) return null;
        return {
            genre: typeof item.genre === 'string' && GENRES.includes(item.genre) ? item.genre : 'Custom',
            language: typeof item.language === 'string' && LANGUAGES.some(language => language.code === item.language) ? item.language : '',
            premise: typeof item.premise === 'string' ? item.premise.slice(0, 2000) : '',
            richMode: typeof item.richMode === 'boolean' ? item.richMode : true,
            title: typeof item.title === 'string' ? item.title.slice(0, 60) : ''
        };
    } catch {
        return null;
    }
}

export function loadDraft(): Draft | null {
    try { return parseDraft(localStorage.getItem(draftKey)); } catch { return null; }
}

// Nothing to keep when the form is still as it starts out.
export function isEmptyDraft(draft: Draft, defaultLanguage: string): boolean {
    return !draft.premise.trim() && !draft.title.trim() && draft.genre === 'Custom' && draft.richMode && draft.language === defaultLanguage;
}

export function saveDraft(draft: Draft, defaultLanguage: string): void {
    try {
        if (isEmptyDraft(draft, defaultLanguage)) localStorage.removeItem(draftKey);
        else localStorage.setItem(draftKey, JSON.stringify({ ...draft, savedAt: Date.now() }));
    } catch { /* storage unavailable: nothing is kept */ }
}

export function clearDraft(): void {
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
}
