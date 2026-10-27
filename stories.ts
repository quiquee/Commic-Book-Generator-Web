import type { ComicFace, Persona } from './types.ts';
import { invitationRequest, type StorySettings } from './invitations.ts';
import { intlLocale, t } from './i18n.ts';

export type StoryAuth =
    | { kind: 'owner'; token: string }
    | { kind: 'guest'; invitationId: string; token: string }
    // Opened from a shared link: can read the comic and nothing else.
    | { kind: 'reader'; token: string };

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
    version: number;
    role: 'owner' | 'guest' | 'reader';
    generation: GenerationStatus | null;
    // Only sent to the owner.
    invitationId?: string | null;
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
}

export const storyStorageKey = 'infinite-heroes.stories';

export function getRoute(): AppRoute {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return { story: params.get('story'), join: params.get('join'), token: params.get('token'), read: params.get('read') };
}

export function routeHash(route: Partial<AppRoute>): string {
    const params = new URLSearchParams();
    if (route.join) params.set('join', route.join);
    if (route.token) params.set('token', route.token);
    if (route.read) params.set('read', route.read);
    if (route.story) params.set('story', route.story);
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
