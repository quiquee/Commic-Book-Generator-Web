// A link can bring the cast with it: `?hero=<photo address>&heroName=Ana&costar=<photo address>&costarName=Luis`.
// The photos are public https addresses. These parameters go in the query string; the hash is the app's own route.

export interface CastLink {
    hero: string;
    heroName: string;
    costar: string;
    costarName: string;
}

const KEYS = ['hero', 'heroName', 'costar', 'costarName'] as const;

// What the link asks for, or null when it names no one. A co-star's name needs their photo.
export function readCastLink(search: string): CastLink | null {
    const params = new URLSearchParams(search);
    const address = (key: string) => (params.get(key) ?? '').trim();
    // Names are cut to what the server accepts for a name.
    const name = (key: string) => (params.get(key) ?? '').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
    const costar = address('costar');
    const link = { hero: address('hero'), heroName: name('heroName'), costar, costarName: costar ? name('costarName') : '' };
    return link.hero || link.heroName || link.costar ? link : null;
}

// The query string without the cast, so that a reload does not load it again; other parameters stay.
export function withoutCastLink(search: string): string {
    const params = new URLSearchParams(search);
    for (const key of KEYS) params.delete(key);
    const rest = params.toString();
    return rest ? `?${rest}` : '';
}
