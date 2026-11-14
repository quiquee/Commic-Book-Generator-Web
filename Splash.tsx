import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './i18n';

// On screen for less than five seconds in all: the time it stays plus the time it takes to fade away, with room
// to spare for timers that fire late while the app is still loading.
const SHOW_MS = 4000;
const FADE_MS = 400;
// The colour of the picture's own edges, so the picture has no visible frame.
const BACKGROUND = '#01122e';
const COPYRIGHT_YEAR = 2026;
const BUILDER_EMAIL = 'emelero@hcpartners.ch';
// Remembered for the browser tab, so a reload or the way back from the credits does not show it again.
const SEEN_KEY = 'infinite-heroes.splash-seen';

const SOCIAL = [
    { name: 'Instagram', handle: '@mundoscruzados_official', url: 'https://www.instagram.com/mundoscruzados_official/' },
    { name: 'TikTok', handle: '@mundos_cruzados', url: 'https://www.tiktok.com/@mundos_cruzados' },
] as const;

function SocialIcon({ name }: { name: typeof SOCIAL[number]['name'] }) {
    if (name === 'Instagram') {
        return (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4.2" />
                <circle cx="17.4" cy="6.6" r="1.2" fill="currentColor" stroke="none" />
            </svg>
        );
    }
    return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
        </svg>
    );
}

function alreadySeen(): boolean {
    try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

// The first thing a visitor sees: the logo, what the site is for and where to follow it. It goes away by itself
// and can be closed sooner with the button, a click outside the links or the Escape key. The app loads underneath.
export function Splash() {
    const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>(() => (alreadySeen() ? 'gone' : 'shown'));
    const closeButton = useRef<HTMLButtonElement>(null);
    // When it must be gone at the latest, whatever happens to the timers on the way.
    const deadline = useRef(0);
    const close = useCallback(() => setPhase(current => (current === 'shown' ? 'leaving' : current)), []);

    useEffect(() => {
        if (phase !== 'shown') return;
        try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* Private browsing: it will show again after a reload. */ }
        closeButton.current?.focus({ preventScroll: true });
        deadline.current = performance.now() + SHOW_MS + FADE_MS;
        const timer = setTimeout(close, SHOW_MS);
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('keydown', onKey);
        };
    }, [phase, close]);

    useEffect(() => {
        if (phase !== 'leaving') return;
        const timer = setTimeout(() => setPhase('gone'), Math.max(0, Math.min(FADE_MS, deadline.current - performance.now())));
        return () => clearTimeout(timer);
    }, [phase]);

    if (phase === 'gone') return null;
    const leaving = phase === 'leaving';

    return (
        // Above every other layer. While it fades, clicks already reach the app below.
        <div role="dialog" aria-modal="true" aria-label="Mundos Cruzados" onClick={close}
            className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-3 sm:gap-4 p-4 text-center overflow-hidden cursor-pointer"
            style={{ backgroundColor: BACKGROUND, opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ease`, pointerEvents: leaving ? 'none' : 'auto' }}>
            <style>{'@keyframes splash-countdown { from { transform: scaleX(1); } to { transform: scaleX(0); } }'}</style>

            <button ref={closeButton} type="button" onClick={close} aria-label={t('common.close')} title={t('common.close')}
                className="comic-btn btn-yellow absolute top-3 right-3 w-11 h-11 text-2xl leading-none flex items-center justify-center">✕</button>

            <div className="relative shrink min-h-0" style={{ width: 'min(84vw, 52vh)', aspectRatio: '1 / 1' }}>
                <img src="/splash.jpg" alt="Mundos Cruzados" width={1024} height={1024} className="block w-full h-full object-contain" />
                {/* Blends the picture's edges into the background. */}
                <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: `inset 0 0 18px 12px ${BACKGROUND}` }} />
            </div>

            <p className="font-comic text-yellow-400 leading-none tracking-wide uppercase"
                style={{ fontSize: 'clamp(1.75rem, 6.5vmin, 3.25rem)', textShadow: '3px 3px 0px black' }}>{t('splash.tagline')}</p>

            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
                {SOCIAL.map(({ name, handle, url }) => (
                    <a key={name} href={url} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}
                        aria-label={`${name} ${handle}`} title={name}
                        className="inline-flex items-center gap-2 rounded-full border-2 border-white/70 bg-white/10 px-4 py-2 text-white font-bold hover:bg-white hover:text-black">
                        <SocialIcon name={name} />
                        <span>{handle}</span>
                    </a>
                ))}
            </div>

            <p className="text-sm text-blue-100/90">
                © {COPYRIGHT_YEAR} Mundos Cruzados · {t('credits.builtBy')}{' '}
                <a href={`mailto:${BUILDER_EMAIL}`} onClick={event => event.stopPropagation()}
                    className="font-bold text-white underline">{BUILDER_EMAIL}</a>
            </p>

            {/* Runs out when the screen goes away by itself. */}
            <div aria-hidden="true" className="absolute bottom-0 left-0 h-1.5 w-full bg-yellow-400 origin-left"
                style={{ animation: `splash-countdown ${SHOW_MS}ms linear forwards` }} />
        </div>
    );
}
