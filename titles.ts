export const titleHistoryKey = 'infinite-heroes.title-history';
export const MAX_TITLE_LENGTH = 60;

// Lowercases, strips accents, punctuation and extra spaces so near-duplicates compare equal.
export function normalizeTitle(title: string): string {
    return title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

export function isTitleTaken(title: string, existing: Iterable<string>): boolean {
    const wanted = normalizeTitle(title);
    if (!wanted) return true;
    for (const candidate of existing) {
        if (normalizeTitle(candidate) === wanted) return true;
    }
    return false;
}

// Removes wrapping quotes, trailing punctuation and collapses whitespace; returns '' when unusable.
export function cleanTitle(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const title = raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/^[\s"'«»“”‘’*#_-]+|[\s"'«»“”‘’*#_.-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (title.length < 2) return '';
    return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).replace(/\s+\S*$/, '').trim() : title;
}

export function titleSlug(title: string): string {
    const slug = title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug || 'comic';
}

const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Chooses the first unused candidate; if every candidate is taken, numbers the first one until it is unique.
export function pickUniqueTitle(candidates: unknown[], existing: Iterable<string>): string | null {
    const taken = [...existing];
    const cleaned = candidates.map(cleanTitle).filter(Boolean);
    const fresh = cleaned.find(candidate => !isTitleTaken(candidate, taken));
    if (fresh) return fresh;
    const base = cleaned[0];
    if (!base) return null;
    for (const suffix of ROMAN) {
        const numbered = `${base} ${suffix}`;
        if (numbered.length <= MAX_TITLE_LENGTH && !isTitleTaken(numbered, taken)) return numbered;
    }
    return null;
}

export function loadTitleHistory(): string[] {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(titleHistoryKey) || '[]');
        return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

export function rememberTitle(title: string): void {
    const history = loadTitleHistory().filter(item => normalizeTitle(item) !== normalizeTitle(title));
    history.push(title);
    localStorage.setItem(titleHistoryKey, JSON.stringify(history.slice(-200)));
}
