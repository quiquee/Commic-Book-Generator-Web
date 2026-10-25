import React, { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

const DURATION_MS = 10_000;
const COMPANY = 'HCPartners Sàrl';
const COMPANY_URL = 'https://hcpartners.ch';

interface CreditsProps {
    // Called once the countdown reaches zero.
    onDone: () => void;
}

// Shown at the end of a comic ("Back to menu"): it cannot be skipped and returns to the menu after ten seconds.
export function Credits({ onDone }: CreditsProps) {
    const [elapsed, setElapsed] = useState(0);
    const done = useRef(onDone);
    done.current = onDone;

    useEffect(() => {
        const start = Date.now();
        const timer = setInterval(() => {
            const now = Math.min(Date.now() - start, DURATION_MS);
            setElapsed(now);
            if (now >= DURATION_MS) {
                clearInterval(timer);
                done.current();
            }
        }, 100);
        return () => clearInterval(timer);
    }, []);

    const remaining = Math.ceil((DURATION_MS - elapsed) / 1000);
    const percent = 100 - (elapsed / DURATION_MS) * 100;

    return (
        // Above every other layer, including the fixed "Main menu" button, so it cannot be skipped.
        <div className="fixed inset-0 z-[900] flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-labelledby="credits-title">
            <div className="max-w-lg w-full bg-white border-[6px] border-black shadow-[12px_12px_0px_rgba(0,0,0,0.6)] p-6 text-center rotate-1">
                <h1 id="credits-title" className="font-comic text-5xl leading-none mb-6" style={{ textShadow: '2px 2px 0px black' }}>
                    <span className="text-red-600">MUNDOS</span> <span className="text-yellow-400">CRUZADOS</span>
                </h1>
                <p className="text-lg mb-4">
                    {t('credits.builtBy')}{' '}
                    <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className="font-bold text-blue-700 underline">{COMPANY}</a>
                    {' '}© {new Date().getFullYear()}
                </p>
                <a href="/" className="comic-btn inline-block bg-red-600 text-white text-2xl px-6 py-3 mb-6">{t('credits.createOwn')}</a>
                <div role="progressbar" aria-label={t('credits.progress')} aria-valuemin={0} aria-valuemax={10} aria-valuenow={remaining}
                    className="h-4 w-full border-2 border-black bg-gray-200 overflow-hidden">
                    <div className="h-full bg-yellow-400" style={{ width: `${percent}%` }} />
                </div>
                <p className="text-sm text-gray-700 mt-2">{t('credits.returning', { seconds: remaining })}</p>
            </div>
        </div>
    );
}
