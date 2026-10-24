import type { Persona } from './types.ts';
import { toJpegDataUrl } from './images.ts';

export interface StorySettings {
    genre: string;
    language: string;
    premise: string;
    richMode: boolean;
}

export interface InvitationResponse {
    id: string;
    name: string;
    persona: Persona;
    status: 'pending' | 'accepted';
}

export interface Invitation {
    id: string;
    hostName: string;
    guestName: string;
    hero: Persona;
    settings: StorySettings;
    responses: InvitationResponse[];
}

export interface InvitationKeys {
    id: string;
    ownerToken: string;
    guestToken: string;
}

export interface JoinCredentials {
    id: string;
    token: string;
}

export const storageKeys = {
    hero: 'infinite-heroes.hero',
    hostName: 'infinite-heroes.host-name',
    invitations: 'infinite-heroes.invitations'
};

export function getJoinCredentials(): JoinCredentials | null {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const id = params.get('join');
    const token = params.get('token');
    return params.has('join') ? { id: id || '', token: token || '' } : null;
}

export function normalizeBaseUrl(value: string): string {
    if (value.trim().length > 2000) throw new Error('La URL base no puede superar los 2000 caracteres.');
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('Introduce una URL base válida, por ejemplo https://comics.example.com.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('La URL debe usar http o https y no puede incluir credenciales.');
    }
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
}

export interface ServerConfig {
    baseUrl: string | null;
    geminiProxy: boolean | null;
}

// Public server settings; null fields mean "unknown" (for example when only the static frontend is served).
export async function fetchServerConfig(signal?: AbortSignal): Promise<ServerConfig> {
    const response = await fetch('/api/config', { signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        return { baseUrl: null, geminiProxy: null };
    }
    const result: unknown = await response.json();
    const field = (name: string): unknown => result && typeof result === 'object' && name in result
        ? (result as Record<string, unknown>)[name] : null;
    const baseUrl = field('baseUrl');
    const geminiProxy = field('geminiProxy');
    return {
        baseUrl: typeof baseUrl === 'string' && baseUrl ? normalizeBaseUrl(baseUrl) : null,
        geminiProxy: typeof geminiProxy === 'boolean' ? geminiProxy : null
    };
}

// Server-configured public base URL (PUBLIC_BASE_URL); null means "use the URL the app is opened with".
export async function fetchPublicBaseUrl(signal?: AbortSignal): Promise<string | null> {
    return (await fetchServerConfig(signal)).baseUrl;
}

export function invitationUrl(baseUrl: string, keys: InvitationKeys): string {
    return `${normalizeBaseUrl(baseUrl)}/#${new URLSearchParams({ join: keys.id, token: keys.guestToken })}`;
}

export async function invitationRequest<T>(
    path: string,
    token?: string,
    body?: object,
    signal?: AbortSignal
): Promise<T> {
    const response = await fetch(`/api/invitations${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal
    });
    if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('El servidor de invitaciones no está disponible. Arranca la aplicación con npm run dev o npm start.');
    }
    const result = await response.json();
    if (!response.ok) {
        throw new Error(typeof result.error === 'string' ? result.error : 'No se pudo completar la petición.');
    }
    return result as T;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Se ha producido un error inesperado.';
}

export async function photoFromFile(file: File): Promise<Persona> {
    if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
        throw new Error('Selecciona una imagen de hasta 20 MB.');
    }
    const base64 = (await toJpegDataUrl(file, 1024, 0.8)).split(',')[1];
    if (base64.length > 1_398_104) throw new Error('La imagen es demasiado grande. Selecciona otra foto.');
    return { base64, desc: 'User provided character' };
}
