import type { ComicFace, Persona } from './types.ts';
import { invitationRequest, type StorySettings } from './invitations.ts';
import { intlLocale, t } from './i18n.ts';
import type { SeriesNode, SeriesTree } from './seriesLogic.ts';

export type StoryAuth =
    | { kind: 'owner'; token: string }
    | { kind: 'guest'; invitationId: string; token: string }
    // Opened from a shared link: can read the comic and nothing else.
    | { kind: 'reader'; token: string }
    // Another issue or branch of a series, opened with the key of a comic of that series: read only.
    | { kind: 'family'; token: string };

export interface StoryKey {
    id: string;
    ownerToken: string;
}

export interface StorySummary {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    completedPages: number;
    totalPages: number;
}

// Progress of the server-side generator; null for comics it has not touched yet.
export interface GenerationStatus {
    state: 'queued' | 'styling' | 'generating' | 'waiting' | 'finished' | 'stopped';
    pageIndex?: number;
    attempt?: number;
    reason?: string;
    // Set when Gemini refused the content: retrying is pointless until the instructions change.
    blocked?: boolean;
    // Gemini's own reason for a refusal (e.g. PROHIBITED_CONTENT), shown next to the message.
    detail?: string;
    at: number;
}

export interface StoryMeta extends StorySummary {
    hostName: string;
    guestName: string;
    settings: StorySettings;
    tone: string;
    styleGuide: string;
    // Story-themed sound effects for the page-loading screen (empty: use the generic ones).
    soundEffects?: string[];
    version: number;
    // Set when this comic is issue 2 or later of a series.
    continuation?: { fromId: string; issue: number; recap: string; direction: string } | null;
    // The series this comic belongs to and its number in it (a comic on its own is issue 1 of its series).
    series?: { id: string; issue: number };
    // 'family': the reader owns another comic of the same series, so they can read this one.
    role: 'owner' | 'guest' | 'reader' | 'family';
    generation: GenerationStatus | null;
    // Only sent to the owner.
    invitationId?: string | null;
    // Made-up name of this comic's owner key, only sent to the owner (the admin sees it too).
    ownerAlias?: string;
}

export interface StoryDocument extends StoryMeta {
    hero: Persona;
    friend: Persona | null;
    faces: ComicFace[];
}

export interface StoryDelta extends StoryMeta {
    faces: ComicFace[];
}

export interface AppRoute {
    story: string | null;
    join: string | null;
    token: string | null;
    // Read-only link token (back-cover Share button).
    read: string | null;
    // One-time token of a transfer link made by the admin: hands over a copy of a comic.
    claim: string | null;
    // An own comic of the same series whose key opens `story` (an issue or a branch that belongs to someone else).
    via: string | null;
}

export const storyStorageKey = 'infinite-heroes.stories';

export function getRoute(): AppRoute {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return { story: params.get('story'), join: params.get('join'), token: params.get('token'), read: params.get('read'), claim: params.get('claim'), via: params.get('via') };
}

export function routeHash(route: Partial<AppRoute>): string {
    const params = new URLSearchParams();
    if (route.join) params.set('join', route.join);
    if (route.token) params.set('token', route.token);
    if (route.read) params.set('read', route.read);
    if (route.claim) params.set('claim', route.claim);
    if (route.story) params.set('story', route.story);
    if (route.story && route.via) params.set('via', route.via);
    const value = params.toString();
    return value ? `#${value}` : '';
}

export function navigate(route: Partial<AppRoute>): void {
    const hash = routeHash(route);
    const target = `${window.location.pathname}${window.location.search}${hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` === target) return;
    window.location.hash = hash || '#';
    if (!hash) window.history.replaceState(null, '', target);
}

export function loadStoryKeys(): StoryKey[] {
    const saved: unknown = JSON.parse(localStorage.getItem(storyStorageKey) || '[]');
    if (!Array.isArray(saved) || !saved.every(item =>
        item && typeof item === 'object' && typeof item.id === 'string' && typeof item.ownerToken === 'string'
    )) throw new Error(t('error.savedStoriesInvalid'));
    return saved;
}

export function saveStoryKeys(keys: StoryKey[]): void {
    localStorage.setItem(storyStorageKey, JSON.stringify(keys));
}

// Keys an admin obtained to continue other people's comics: kept for this tab only, apart from «Mis cómics».
const adminStoryKeysKey = 'infinite-heroes.admin-story-keys';

function loadAdminStoryKeys(): StoryKey[] {
    try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(adminStoryKeysKey) || '[]');
        return Array.isArray(saved) ? saved.filter((item): item is StoryKey =>
            item && typeof item.id === 'string' && typeof item.ownerToken === 'string') : [];
    } catch {
        return [];
    }
}

export function rememberAdminStoryKey(key: StoryKey): void {
    sessionStorage.setItem(adminStoryKeysKey, JSON.stringify([...loadAdminStoryKeys().filter(item => item.id !== key.id), key]));
}

export function findOwnerToken(storyId: string): string | null {
    let own: string | null = null;
    try {
        own = loadStoryKeys().find(key => key.id === storyId)?.ownerToken ?? null;
    } catch { /* fall back to admin keys */ }
    return own ?? loadAdminStoryKeys().find(key => key.id === storyId)?.ownerToken ?? null;
}

// The reader holds the key of one of the comics of this issue.
export const holdsKey = (node: SeriesNode): boolean => node.mine || node.stories.some(id => !!findOwnerToken(id));
// An issue is read from the reader's own comic when they have one of it.
export const comicOf = (node: SeriesNode): string => node.stories.find(id => !!findOwnerToken(id)) ?? node.storyId;

// Another comic of the series opens with its own key when the reader has it, with this comic's key otherwise.
export function issueAuth(auth: StoryAuth, id: string): StoryAuth {
    const own = findOwnerToken(id);
    if (own) return { kind: 'owner', token: own };
    return auth.kind === 'owner' ? { kind: 'family', token: auth.token } : auth;
}

export function authToken(auth: StoryAuth): string {
    return auth.token;
}

export async function storyRequest<T>(
    path: string,
    auth: StoryAuth | null,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: object; signal?: AbortSignal } = {}
): Promise<T> {
    const method = options.method ?? (options.body ? 'POST' : 'GET');
    const response = await fetch(`/api/stories${path}`, {
        method,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(auth ? { Authorization: `Bearer ${authToken(auth)}` } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal
    });
    if (response.status === 204) return undefined as T;
    if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(t('error.storyServer'));
    }
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(typeof result.error === 'string' ? result.error : t('error.requestFailed')) as Error & { status?: number; resolvedChoice?: string };
        error.status = response.status;
        if (typeof result.resolvedChoice === 'string') error.resolvedChoice = result.resolvedChoice;
        throw error;
    }
    return result as T;
}

export interface CreateStoryBody {
    title: string;
    hostName: string;
    guestName: string;
    hero: Persona;
    friend: Persona | null;
    settings: StorySettings;
    tone: string;
    invitation: { id: string; ownerToken: string; responseId?: string } | null;
    draftId?: string;
    // Makes this comic the next issue of a finished one (the server copies its cast, look and settings).
    continuation?: { fromId: string; token: string; recap: string; direction: string };
}

// crypto.randomUUID() is unavailable on plain-http LAN addresses, so build a v4 UUID from getRandomValues.
export function newDraftId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createStory(body: CreateStoryBody): Promise<StoryKey> {
    return storyRequest<StoryKey>('', null, { body });
}

export function fetchStory(id: string, auth: StoryAuth, signal?: AbortSignal): Promise<StoryDocument> {
    return storyRequest<StoryDocument>(`/${id}`, auth, { signal });
}

// Comics kept in memory for a moment, so turning the last page of an issue opens the next one at once
// (and going back does not load the previous one again). A comic is a few MB, so only a handful are kept.
const storyCache = new Map<string, Promise<StoryDocument>>();
const cacheKey = (id: string, auth: StoryAuth) => `${id}:${auth.token}`;

function cacheStory(key: string, document: Promise<StoryDocument>): void {
    storyCache.delete(key);
    storyCache.set(key, document);
    for (const oldest of storyCache.keys()) {
        if (storyCache.size <= 3) break;
        storyCache.delete(oldest);
    }
}

// Starts loading a comic the reader is likely to open next.
export function prefetchStory(id: string, auth: StoryAuth): void {
    const key = cacheKey(id, auth);
    if (storyCache.has(key)) return;
    const loading = fetchStory(id, auth);
    loading.catch(() => { if (storyCache.get(key) === loading) storyCache.delete(key); });
    cacheStory(key, loading);
}

// Keeps a finished comic the reader is leaving for another issue.
export function keepStory(auth: StoryAuth, document: StoryDocument): void {
    cacheStory(cacheKey(document.id, auth), Promise.resolve(document));
}

// The comic from memory when it is there, from the server otherwise.
export async function openStory(id: string, auth: StoryAuth, signal?: AbortSignal): Promise<StoryDocument> {
    const key = cacheKey(id, auth);
    const kept = storyCache.get(key);
    storyCache.delete(key);
    if (kept) {
        try { return await kept; } catch { /* ask the server again */ }
    }
    return fetchStory(id, auth, signal);
}

// The issues of the series a comic belongs to, as far as this key may see them.
export function fetchSeries(id: string, auth: StoryAuth, signal?: AbortSignal): Promise<SeriesTree> {
    return storyRequest<SeriesTree>(`/${id}/series`, auth, { signal });
}

// Just the cover of a comic (null while it is not drawn yet).
export function fetchCover(id: string, auth: StoryAuth, signal?: AbortSignal): Promise<string | null> {
    return storyRequest<{ imageUrl: string | null }>(`/${id}/cover`, auth, { signal }).then(result => result.imageUrl);
}

export function fetchStoryDelta(id: string, auth: StoryAuth, after: number, signal?: AbortSignal): Promise<StoryDelta> {
    return storyRequest<StoryDelta>(`/${id}?after=${after}`, auth, { signal });
}

export function submitChoice(id: string, auth: StoryAuth, faceId: string, choice: string): Promise<{ version: number; faceId: string; resolvedChoice: string }> {
    return storyRequest(`/${id}/choices`, auth, { body: { faceId, choice } });
}

// Asks the server to (re)start drawing the comic, e.g. after it stopped on an error.
export function restartGeneration(id: string, auth: StoryAuth): Promise<{ started: boolean }> {
    return storyRequest(`/${id}/generate`, auth, { body: {} });
}

// Rewrites the story instructions after Gemini refused the content, and restarts the drawing.
export function updateInstructions(id: string, auth: StoryAuth, instructions: string): Promise<{ started: boolean }> {
    return storyRequest(`/${id}/instructions`, auth, { body: { instructions } });
}

// Link anyone can open to read this comic. Only the owner and the invited co-star can ask for it.
export function readLinkUrl(baseUrl: string | null, id: string, token: string): string {
    const base = baseUrl ?? `${window.location.origin}${window.location.pathname}`.replace(/\/$/, '');
    return `${base}/${routeHash({ story: id, read: token })}`;
}

export async function createReadLink(id: string, auth: StoryAuth, baseUrl: string | null): Promise<string> {
    const { token } = await storyRequest<{ token: string }>(`/${id}/share`, auth, { body: {} });
    return readLinkUrl(baseUrl, id, token);
}

// `url` is where the notification takes the reader back to (this same comic, with the same credentials).
// `lang` is the interface language the notifications should be written in.
export function subscribeToStory(id: string, auth: StoryAuth, subscription: PushSubscriptionJSON, url: string, lang: string): Promise<{ subscribed: boolean }> {
    return storyRequest(`/${id}/subscriptions`, auth, { body: { subscription, url, lang } });
}

// A copy of a comic comes with copies of the issues before it: `keys` has them all, first issue first.
export type CopiedStory = StoryKey & { keys?: StoryKey[] };

// Adds the comics of a copy to «Mis cómics».
export function saveCopiedKeys(copy: CopiedStory): void {
    let saved: StoryKey[] = [];
    try { saved = loadStoryKeys(); } catch { /* start a new list */ }
    const added = (copy.keys?.length ? copy.keys : [copy]).map(({ id, ownerToken }) => ({ id, ownerToken }));
    saveStoryKeys([...saved.filter(item => !added.some(key => key.id === item.id)), ...added]);
}

// Own copy of a finished comic and of the issues before it (pages, photos and characters) with its own owner
// token: lets whoever received a link continue it, redo it or delete it as if it were theirs.
export function copyStory(id: string, auth: StoryAuth): Promise<CopiedStory> {
    return storyRequest<CopiedStory>(`/${id}/copy`, auth, { body: {} });
}

// Takes over the copy a transfer link points to, with the issues before it (works once).
export function claimStory(id: string, claim: string): Promise<CopiedStory> {
    return storyRequest<CopiedStory>(`/${id}/claim`, null, { body: { claim } });
}

export function deleteStory(id: string, auth: StoryAuth): Promise<void> {
    return storyRequest(`/${id}`, auth, { method: 'DELETE' });
}

export function listGuestStories(invitationId: string, token: string, signal?: AbortSignal): Promise<StorySummary[]> {
    return invitationRequest<{ stories?: StorySummary[] }>(`/${invitationId}/join`, token, undefined, signal)
        .then(result => result.stories ?? []);
}

export function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}
