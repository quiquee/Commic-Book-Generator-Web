import type { ComicFace, Persona } from './types.ts';
import { invitationRequest, type StorySettings } from './invitations.ts';
export { compressImage } from './images.ts';

export type StoryAuth =
    | { kind: 'owner'; token: string }
    | { kind: 'guest'; invitationId: string; token: string };

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

export interface StoryMeta extends StorySummary {
    hostName: string;
    guestName: string;
    settings: StorySettings;
    tone: string;
    styleGuide: string;
    version: number;
    role: 'owner' | 'guest';
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
}

export const storyStorageKey = 'infinite-heroes.stories';

export function getRoute(): AppRoute {
    const params = new URLSearchParams(window.location.hash.slice(1));
    return { story: params.get('story'), join: params.get('join'), token: params.get('token') };
}

export function routeHash(route: Partial<AppRoute>): string {
    const params = new URLSearchParams();
    if (route.join) params.set('join', route.join);
    if (route.token) params.set('token', route.token);
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
    )) throw new Error('La lista de cómics guardada no es válida.');
    return saved;
}

export function saveStoryKeys(keys: StoryKey[]): void {
    localStorage.setItem(storyStorageKey, JSON.stringify(keys));
}

export function findOwnerToken(storyId: string): string | null {
    try {
        return loadStoryKeys().find(key => key.id === storyId)?.ownerToken ?? null;
    } catch {
        return null;
    }
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
        throw new Error('El servidor de historias no está disponible. Arranca la aplicación con npm run dev o npm start.');
    }
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(typeof result.error === 'string' ? result.error : 'No se pudo completar la petición.') as Error & { status?: number; resolvedChoice?: string };
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
    invitation: { id: string; ownerToken: string } | null;
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

export function saveFace(id: string, auth: StoryAuth, face: ComicFace): Promise<{ version: number }> {
    const { version: _ignored, ...body } = face;
    return storyRequest(`/${id}/faces/${face.id}`, auth, { method: 'PUT', body });
}

export function patchStory(id: string, auth: StoryAuth, body: Partial<Pick<StoryDocument, 'friend' | 'styleGuide' | 'tone' | 'title'>>): Promise<{ version: number }> {
    return storyRequest(`/${id}`, auth, { method: 'PATCH', body });
}

export function submitChoice(id: string, auth: StoryAuth, faceId: string, choice: string): Promise<{ version: number; faceId: string; resolvedChoice: string }> {
    return storyRequest(`/${id}/choices`, auth, { body: { faceId, choice } });
}

export function deleteStory(id: string, auth: StoryAuth): Promise<void> {
    return storyRequest(`/${id}`, auth, { method: 'DELETE' });
}

export function listGuestStories(invitationId: string, token: string, signal?: AbortSignal): Promise<StorySummary[]> {
    return invitationRequest<{ stories?: StorySummary[] }>(`/${invitationId}/join`, token, undefined, signal)
        .then(result => result.stories ?? []);
}

export function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}
