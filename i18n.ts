import { es, type MessageKey } from './locales/es.ts';
import { en } from './locales/en.ts';
import { fr } from './locales/fr.ts';
import { de } from './locales/de.ts';
import { gl } from './locales/gl.ts';
import { translateServerText } from './locales/serverText.ts';

export type { MessageKey };
export const LOCALES = ['es', 'en', 'fr', 'de', 'gl'] as const;
export type Locale = typeof LOCALES[number];

const catalogs: Record<Locale, Record<MessageKey, string>> = { es, en, fr, de, gl };

// Comic language offered by default for each interface language (codes from types.ts LANGUAGES).
const COMIC_LANGUAGE: Record<Locale, string> = { es: 'es-ES', en: 'en-US', fr: 'fr-FR', de: 'de-DE', gl: 'gl-ES' };

function baseOf(tag: string | null | undefined): Locale | null {
    const base = (tag ?? '').toLowerCase().split(/[-_]/)[0];
    return (LOCALES as readonly string[]).includes(base) ? base as Locale : null;
}

// The browser's preferred languages decide; `?lang=xx` overrides them (handy for testing).
// Languages the app does not have fall back to English.
function detect(): { locale: Locale; tag: string } {
    // Outside a browser (Node also has a `navigator`) the source language is used.
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return { locale: 'es', tag: 'es-ES' };
    const forced = new URLSearchParams(window.location.search).get('lang');
    const candidates = [forced, ...(navigator.languages ?? []), navigator.language];
    for (const tag of candidates) {
        const locale = baseOf(tag);
        if (locale) return { locale, tag: tag!.includes('-') ? tag! : COMIC_LANGUAGE[locale] };
    }
    return { locale: 'en', tag: 'en-US' };
}

const detected = detect();
export const locale: Locale = detected.locale;
// BCP 47 tag for Intl (dates, numbers), keeping the user's region when it matches.
export const intlLocale = detected.tag;
export const defaultComicLanguage = COMIC_LANGUAGE[locale];

if (typeof document !== 'undefined') document.documentElement.lang = locale;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
    const template = catalogs[locale][key] ?? es[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match) : template;
}

// Server and shared code report errors in Spanish; this shows them in the reader's language.
export function localizeText(text: string): string {
    return translateServerText(text, locale);
}
