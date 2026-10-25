import React, { useEffect, useState } from 'react';
import { errorMessage } from './invitations';
import { subscribeToStory, type StoryAuth } from './stories';

interface NotifyPromptProps {
    storyId: string;
    auth: StoryAuth;
    // Only while the comic is still being drawn.
    active: boolean;
}

const PROMPT_DELAY_MS = 20_000;
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
    if (!response.ok) throw new Error('El servidor no admite notificaciones.');
    const { publicKey } = await response.json() as { publicKey: string };
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await subscribeToStory(storyId, auth, subscription.toJSON(), `${window.location.pathname}${window.location.hash}`);
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
    const [show, setShow] = useState<'ask' | 'ios' | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState('');

    useEffect(() => {
        if (!active) { setShow(null); return; }
        if (!pushSupported()) {
            // On iPhone the Push API only appears when the site was added to the home screen.
            if (!isIOS() || !window.isSecureContext || recentlyDismissed()) return;
            const timer = setTimeout(() => setShow('ios'), PROMPT_DELAY_MS);
            return () => clearTimeout(timer);
        }
        if (Notification.permission === 'granted') {
            subscribe(storyId, auth).catch(() => { /* notices are optional */ });
            return;
        }
        if (Notification.permission === 'denied' || recentlyDismissed()) return;
        const timer = setTimeout(() => setShow('ask'), PROMPT_DELAY_MS);
        return () => clearTimeout(timer);
    }, [active, storyId, auth]);

    const dismiss = () => {
        try { localStorage.setItem(dismissedKey, String(Date.now())); } catch { /* ignore */ }
        setShow(null);
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
            setResult('¡Hecho! Te avisaremos cuando haya que decidir algo y cuando el cómic esté terminado.');
            setTimeout(() => setResult(''), 6000);
        } catch (failure) {
            setResult(`No se pudieron activar los avisos: ${errorMessage(failure)}`);
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
        <div role="dialog" aria-labelledby="notify-title" className="fixed bottom-4 inset-x-4 z-[600] mx-auto max-w-md bg-yellow-50 border-4 border-black p-4 shadow-[8px_8px_0px_black] text-left">
            <h2 id="notify-title" className="font-comic text-2xl">🔔 ¿Te avisamos?</h2>
            {show === 'ask' ? <>
                <p className="text-sm my-2">Puedes cerrar esta página: seguiremos dibujando tu cómic y te enviaremos una notificación cuando esté terminado o cuando haya que tomar una decisión.</p>
                <div className="flex gap-2 justify-end">
                    <button type="button" onClick={dismiss} disabled={busy} className="comic-btn bg-gray-200 text-black px-3 py-2">Ahora no</button>
                    <button type="button" onClick={accept} disabled={busy} className="comic-btn bg-red-600 text-white px-3 py-2">{busy ? 'Activando...' : 'Avisarme'}</button>
                </div>
            </> : <>
                <p className="text-sm my-2">En iPhone, para recibir un aviso cuando el cómic esté listo, añade esta web a la pantalla de inicio (botón Compartir → «Añadir a pantalla de inicio») y ábrela desde allí.</p>
                <div className="flex justify-end">
                    <button type="button" onClick={dismiss} className="comic-btn bg-gray-200 text-black px-3 py-2">Entendido</button>
                </div>
            </>}
        </div>
    );
}
