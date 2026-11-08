import React, { useEffect, useRef, useState } from 'react';
import { randomTrack, type Mood } from './music';
import { t } from './i18n';

const mutedKey = 'infinite-heroes.music-muted';
const VOLUME = 0.35;

const readMuted = () => { try { return localStorage.getItem(mutedKey) === '1'; } catch { return false; } };

interface MusicPlayerProps {
    // Mood of the story being read; null before there is one (a random track of any mood plays).
    mood: Mood | null;
}

// Background music: one track at a time, the next one of the same mood when it ends. Browsers block
// sound until the page is touched, so playback starts on the first click or key press.
export function MusicPlayer({ mood }: MusicPlayerProps) {
    const [muted, setMuted] = useState(readMuted);
    const audio = useRef<HTMLAudioElement | null>(null);
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const moodRef = useRef(mood);
    moodRef.current = mood;

    const play = () => { if (!mutedRef.current) audio.current?.play().catch(() => { /* waits for a gesture */ }); };

    const load = (url: string) => {
        if (!audio.current) return;
        audio.current.src = url;
        play();
    };

    useEffect(() => {
        const element = new Audio();
        element.volume = VOLUME;
        element.preload = 'auto';
        element.addEventListener('ended', () => load(randomTrack(moodRef.current, new URL(element.src).pathname)));
        audio.current = element;
        load(randomTrack(moodRef.current));
        const unlock = () => play();
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('keydown', unlock);
        return () => {
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
            element.pause();
            element.removeAttribute('src');
            audio.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // The story's genre/tone is known: switch to a track that fits it.
    const first = useRef(true);
    useEffect(() => {
        if (first.current) { first.current = false; return; }
        load(randomTrack(mood));
    }, [mood]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggle = () => {
        const next = !muted;
        setMuted(next);
        try { localStorage.setItem(mutedKey, next ? '1' : '0'); } catch { /* ignore */ }
        mutedRef.current = next;
        if (next) audio.current?.pause(); else play();
    };

    return (
        <button type="button" onClick={toggle} aria-pressed={!muted} aria-label={muted ? t('music.on') : t('music.off')} title={muted ? t('music.on') : t('music.off')}
          className="fixed bottom-2 right-2 z-[500] comic-btn bg-yellow-400/90 text-black w-10 h-10 text-xl leading-none flex items-center justify-center">
            {muted ? '🔇' : '🔊'}
        </button>
    );
}
