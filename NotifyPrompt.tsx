import React, { useEffect, useState } from 'react';
import { errorMessage } from './invitations';
import { subscribeToStory, type StoryAuth } from './stories';
import { locale, t } from './i18n';

interface NotifyPromptProps {
    storyId: string;
    auth: StoryAuth;
    // Only while the comic is still being drawn.
    active: boolean;
}

const PROMPT_DELAY_MS = 3_000;
const dismissedKey = 'infinite-heroes.notify-dismissed';
const DISMISS_MS = 3 * 24 * 60 * 60 * 1000;

// Web Push needs HTTPS, a service worker and the Push API (on iPhone only once the site is on the home screen).
const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function keyBytes(base64Url: string): Uint8Array {
    const base64 = (base64Url + '='.repeat((4 - base64Url.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

async function subscribe(storyId: string, auth: StoryAuth): Promise<void> {
    const response = await fetch('/api/push/key');
    if (!response.ok) throw new Error(t('notify.unsupported'));
    const { publicKey } = await response.json() as { publicKey: string };
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await subscribeToStory(storyId, auth, subscription.toJSON(), `${window.location.pathname}${window.location.hash}`, locale);
}

function recentlyDismissed(): boolean {
    try {
        return Date.now() - Number(localStorage.getItem(dismissedKey) || 0) < DISMISS_MS;
    } catch {
        return false;
    }
}

// After a short while on an unfinished comic, offers to notify when it ends or needs a decision.
// With permission already granted it subscribes silently, so later comics need no prompt.
export function NotifyPrompt({ storyId, auth, active }: NotifyPromptProps) {
    const [show, setShow] = useState<'ask' | 'ios' | 'info' | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState('');

    useEffect(() => {
        if (!active) { setShow(null); return; }
        const granted = pushSupported() && Notification.permission === 'granted';
        // With permission already granted it subscribes silently, so later comics need no prompt.
        if (granted) subscribe(storyId, auth).catch(() => { /* notices are optional */ });
        if (recentlyDismissed()) return;
        const timer = setTimeout(() => setShow(pushSupported() ? 'ask' : isIOS() && window.isSecureContext ? 'ios' : 'info'), PROMPT_DELAY_MS);
        return () => clearTimeout(timer);
    }, [active, storyId, auth]);

    const dismiss = () => {
        try { localStorage.setItem(dismissedKey, String(Date.now())); } catch { /* ignore */ }
        setShow(null);
    };

    // Closing the notice is what asks the browser for permission to notify.
    const close = () => {
        dismiss();
        if (show === 'ask' && Notification.permission === 'default') void accept();
    };

    const accept = async () => {
        setBusy(true);
        try {
            if (await Notification.requestPermission() !== 'granted') {
                setShow(null);
                return;
            }
            await subscribe(storyId, auth);
            setShow(null);
            setResult(t('notify.done'));
            setTimeout(() => setResult(''), 6000);
        } catch (failure) {
            setResult(t('notify.failed', { reason: errorMessage(failure) }));
            setShow(null);
        } finally {
            setBusy(false);
        }
    };

    if (result) return (
        <div role="status" className="fixed bottom-4 inset-x-4 z-[600] mx-auto max-w-md bg-white border-4 border-black p-3 text-sm shadow-[6px_6px_0px_black]">
            {result}
        </div>
    );
    if (!show) return null;

    return (
        <div className="fixed inset-0 z-[600] bg-black/60 flex items-center justify-center p-4">
            <div role="dialog" aria-modal="true" aria-labelledby="notify-title" className="relative w-full max-w-md bg-yellow-50 border-4 border-black p-6 pt-8 shadow-[8px_8px_0px_black] text-left">
                <button type="button" onClick={close} aria-label={t('common.close')} disabled={busy}
                  className="absolute -top-5 -right-5 w-11 h-11 rounded-full bg-red-600 text-white border-4 border-black font-comic text-2xl leading-none flex items-center justify-center shadow-[3px_3px_0px_black] hover:scale-110">✕</button>
                <h2 id="notify-title" className="font-comic text-4xl mb-3">🔔 {t('notify.title')}</h2>
                <p className="text-xl">{show === 'ios' ? t('notify.ios') : t('notify.body')}</p>
                {show === 'ask' && <p className="text-base mt-3 text-gray-700">{t('notify.hint')}</p>}
            </div>
        </div>
    );
}
