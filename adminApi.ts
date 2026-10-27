import { intlLocale, localizeText, t } from './i18n';

export interface TokenCounts {
    inputText: number;
    inputImage: number;
    outputText: number;
    outputImage: number;
    cached: number;
    total: number;
}

export interface UsageTotals {
    calls: number;
    errors: number;
    tokens: TokenCounts;
    costUsd: number;
    uncostedCalls: number;
}

export interface UsageEvent {
    ts: number;
    op: string;
    page: number | null;
    model: string;
    ok: boolean;
    httpStatus: number;
    latencyMs: number;
    tokens: TokenCounts;
    images: number;
    costUsd: number | null;
    priceVersion: string | null;
}

export type StoryStatus = 'in_progress' | 'complete' | 'deleted';

export interface AdminStoryItem {
    id: string;
    title: string;
    hostName: string;
    guestName: string;
    createdAt: number;
    updatedAt?: number;
    completedPages: number;
    totalPages: number;
    status: StoryStatus;
    deletedAt?: number;
    deletedBy?: 'owner' | 'admin';
    hasFriend: boolean;
    usage: UsageTotals;
    // Times the Share button was used / times a shared link was opened.
    shares: number;
    opens: number;
}

export interface AdminStoryList {
    items: AdminStoryItem[];
    total: number;
    page: number;
    pageSize: number;
}

export interface AdminFace {
    id: string;
    type: 'cover' | 'story' | 'back_cover';
    pageIndex: number;
    isLoading: boolean;
    isDecisionPage: boolean;
    choices: string[];
    resolvedChoice?: string;
    hasImage: boolean;
    narrative?: { caption?: string; dialogue?: string; scene: string };
}

export interface AdminStoryDetail {
    id: string;
    title: string;
    hostName: string;
    guestName: string;
    createdAt: number;
    updatedAt?: number;
    deletedAt?: number;
    deletedBy?: 'owner' | 'admin';
    settings?: { genre: string; language: string; premise: string; richMode: boolean };
    tone?: string;
    styleGuide?: string;
    invitationId?: string | null;
    status: StoryStatus;
    completedPages: number;
    totalPages: number;
    shares?: number;
    opens?: number;
    lastSharedAt?: number;
    lastOpenedAt?: number;
    faces: AdminFace[];
    usage: {
        totals: UsageTotals;
        byOperation: Record<string, UsageTotals>;
        byModel: Record<string, UsageTotals>;
        events: UsageEvent[];
    };
}

export interface DailyUsage {
    date: string;
    calls: number;
    errors: number;
    tokens: TokenCounts;
    costUsd: number;
}

export interface AdminOverview {
    totals: UsageTotals;
    today: UsageTotals;
    last7Days: UsageTotals;
    last30Days: UsageTotals;
    daily: DailyUsage[];
    draftsUnassigned: { calls: number; costUsd: number; tokens: TokenCounts };
    stories: { total: number; active: number; deleted: number; complete: number; inProgress: number };
    budget: { dailyBudgetUsd: number; dailyTokenLimit: number; todayCostUsd: number; todayTokens: number };
    pricingConfigured: boolean;
    pricingVersion: string | null;
}

export class AdminAuthError extends Error {
    constructor(message = t('admin.sessionExpired')) {
        super(message);
    }
}

export async function adminRequest<T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: object; signal?: AbortSignal } = {}
): Promise<T> {
    const method = options.method ?? 'GET';
    const response = await fetch(`/api/admin${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
            ...(method !== 'GET' ? { 'X-Admin-Request': '1' } : {}),
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal
    });
    if (response.status === 204) return undefined as T;
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const result = isJson ? await response.json() : null;
    if (response.status === 401 && path !== '/login') throw new AdminAuthError();
    if (!response.ok) {
        throw new Error(typeof result?.error === 'string' ? result.error : t('admin.serverError', { status: response.status }));
    }
    return result as T;
}

export function errorText(error: unknown): string {
    return error instanceof Error ? localizeText(error.message) : t('error.unexpected');
}

const dateFormat = new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat(intlLocale);

export const formatDate = (timestamp: number | null | undefined) =>
    typeof timestamp === 'number' && Number.isFinite(timestamp) ? dateFormat.format(new Date(timestamp)) : '—';
export const formatNumber = (value: number) => numberFormat.format(Math.round(value));

export function formatCost(totals: { costUsd: number; uncostedCalls: number }): string {
    if (totals.uncostedCalls > 0 && totals.costUsd === 0) return 'sin tarifa';
    const amount = `${totals.costUsd.toLocaleString(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} US$`;
    return totals.uncostedCalls > 0 ? t('admin.costPlusUncosted', { amount, count: totals.uncostedCalls }) : amount;
}

export function formatUsd(value: number | null): string {
    return value === null ? '—' : `${value.toLocaleString(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} US$`;
}

export const statusLabel = (status: StoryStatus) => t(({
    in_progress: 'admin.status.inProgress', complete: 'admin.status.complete', deleted: 'admin.status.deleted'
} as const)[status]);

export const imageUrl = (storyId: string, which: string) => `/api/admin/stories/${storyId}/image/${which}`;

export interface GeminiLogEntry {
    ts: string;
    scope: 'story' | 'draft';
    scopeId: string;
    model: string;
    op: string;
    httpStatus: number;
    latencyMs: number;
    ok: boolean;
    blockReason?: string;
    finishReason?: string;
    error?: { code?: number; status?: string; message?: string; detail?: string };
    safetyRatings?: { category: string; probability?: string; blocked?: boolean }[];
    promptSafetyRatings?: { category: string; probability?: string; blocked?: boolean }[];
    totalTokens?: number;
    prompt: { text: string; images: number };
    reply?: string;
}
