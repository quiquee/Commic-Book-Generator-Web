import type { Persona } from './types.ts';
import { toJpegDataUrl } from './images.ts';
import { localizeText, t } from './i18n.ts';

export interface StorySettings {
    genre: string;
    language: string;
    premise: string;
    richMode: boolean;
    // Extra guidance for the preset genres, written after Gemini refused the content (Custom edits `premise`).
    extraInstructions?: string;
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
    if (value.trim().length > 2000) throw new Error(t('error.baseUrlLong'));
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error(t('error.baseUrl'));
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(t('error.baseUrlScheme'));
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

// The response a new comic would use: the accepted one, or else the chosen (default: latest) pending one.
export function pickResponse(invitation: Invitation, chosenId: string | null): InvitationResponse | null {
    return invitation.responses.find(item => item.status === 'accepted')
        ?? invitation.responses.find(item => item.id === chosenId)
        ?? invitation.responses[invitation.responses.length - 1]
        ?? null;
}

// The Clipboard API only exists on HTTPS or localhost; plain-HTTP hosts (e.g. on a LAN) need the legacy path.
export async function copyText(text: string): Promise<void> {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error(t('error.copyLink'));
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
        throw new Error(t('error.invitationServer'));
    }
    const result = await response.json();
    if (!response.ok) {
        throw new Error(typeof result.error === 'string' ? result.error : t('error.requestFailed'));
    }
    return result as T;
}

export function errorMessage(error: unknown): string {
    // Server messages arrive in Spanish; show them in the reader's language.
    return error instanceof Error ? localizeText(error.message) : t('error.unexpected');
}

export async function photoFromFile(file: File): Promise<Persona> {
    if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
        throw new Error(t('error.imageTooLargeFile'));
    }
    const base64 = (await toJpegDataUrl(file, 1024, 0.8)).split(',')[1];
    if (base64.length > 1_398_104) throw new Error(t('error.imageTooLarge'));
    return { base64, desc: 'User provided character' };
}
