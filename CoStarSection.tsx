import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Persona } from './types';
import {
    copyText, errorMessage, fetchPublicBaseUrl, invitationRequest, invitationUrl, pickResponse, storageKeys,
    type Invitation, type InvitationKeys, type InvitationResponse, type StorySettings
} from './invitations';

export type CastMode = 'solo' | 'photo' | 'invite';

// The invitation the next comic is tied to; `response` is null until the guest has joined.
export interface ActiveInvitation {
    invitation: Invitation;
    ownerToken: string;
    response: InvitationResponse | null;
}

interface CoStarSectionProps {
    mode: CastMode;
    onModeChange: (mode: CastMode) => void;
    hero: Persona | null;
    friend: Persona | null;
    onFriendUpload: (file: File) => void;
    settings: StorySettings;
    onActiveChange: (active: ActiveInvitation | null) => void;
    // Invitation selected on mount (when redoing a shared comic).
    initialActiveId?: string | null;
}

const MODES: { value: CastMode; label: string; hint: string }[] = [
    { value: 'solo', label: 'Solo yo', hint: 'Sin coprotagonista' },
    { value: 'photo', label: 'Tengo su foto', hint: 'La subes tú' },
    { value: 'invite', label: 'Invitar', hint: 'Le envías un enlace' },
];

function isLoopbackUrl(value: string): boolean {
    try {
        return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
    } catch {
        return false;
    }
}

function ShareInvitation({ url, hostName, guestName }: { url: string; hostName: string; guestName: string }) {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const text = `¡Hola, ${guestName}! ${hostName} te invita a ser coprotagonista de un cómic en Mundos Cruzados. Abre el enlace y sube tu foto:`;
    // Web Share needs HTTPS; on plain HTTP the copy and WhatsApp buttons still work.
    const canShare = typeof navigator.share === 'function';

    const share = async () => {
        setError('');
        try {
            await navigator.share({ title: 'Mundos Cruzados', text, url });
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) setError(errorMessage(error));
        }
    };
    const copy = async () => {
        setError('');
        try {
            await copyText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            setError(`${errorMessage(error)} Ábrelo en «Ver enlace y código QR» y cópialo a mano.`);
        }
    };

    return (
        <div>
            <div className="flex flex-wrap gap-2">
                {canShare && <button type="button" onClick={share} className="comic-btn bg-purple-600 text-white px-3 py-2 text-base">Compartir enlace</button>}
                <button type="button" onClick={copy} className="comic-btn bg-yellow-400 text-black px-3 py-2 text-base">{copied ? '¡Copiado!' : 'Copiar enlace'}</button>
                <a href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`} target="_blank" rel="noopener noreferrer" className="comic-btn bg-green-500 text-black px-3 py-2 text-base inline-block">WhatsApp</a>
            </div>
            {error && <p role="alert" className="text-red-700 text-sm mt-1">{error}</p>}
            <details className="mt-2 text-sm">
                <summary className="cursor-pointer underline">Ver enlace y código QR</summary>
                <div className="flex flex-col sm:flex-row gap-3 mt-2 items-start">
                    <QRCodeSVG value={url} size={128} title="Código QR de la invitación" />
                    <p className="break-all min-w-0">{url}</p>
                </div>
            </details>
        </div>
    );
}

export function CoStarSection({ mode, onModeChange, hero, friend, onFriendUpload, settings, onActiveChange, initialActiveId = null }: CoStarSectionProps) {
    const [hostName, setHostName] = useState('');
    const [guestName, setGuestName] = useState('');
    const [baseUrl, setBaseUrl] = useState(window.location.origin);
    const [keys, setKeys] = useState<InvitationKeys[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [activeId, setActiveId] = useState<string | null>(initialActiveId);
    const [chosenResponseId, setChosenResponseId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [pollError, setPollError] = useState('');
    const mutationController = useRef<AbortController | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        mutationController.current = controller;
        // The public base URL is server configuration (PUBLIC_BASE_URL in .env.local); the page origin is the default.
        fetchPublicBaseUrl(controller.signal)
            .then(configured => { if (!controller.signal.aborted && configured) setBaseUrl(configured); })
            .catch(() => { /* keep the page origin */ });
        localStorage.removeItem('infinite-heroes.base-url');
        try {
            setHostName(localStorage.getItem(storageKeys.hostName) || '');
            const saved: unknown = JSON.parse(localStorage.getItem(storageKeys.invitations) || '[]');
            if (!Array.isArray(saved) || !saved.every(item =>
                item && typeof item.id === 'string' && typeof item.ownerToken === 'string' && typeof item.guestToken === 'string'
            )) throw new Error('Las invitaciones guardadas no son válidas.');
            setKeys(saved);
        } catch (error) {
            setError(`No se pudieron recuperar tus invitaciones: ${errorMessage(error)}`);
        }
        return () => controller.abort();
    }, []);

    useEffect(() => {
        if (!keys.length) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const results = await Promise.allSettled(keys.map(key =>
                    invitationRequest<Invitation>(`/${key.id}`, key.ownerToken, undefined, controller.signal)
                ));
                if (!controller.signal.aborted) {
                    setInvitations(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
                    setPollError(results.flatMap((result, index) => result.status === 'rejected' ?
                        [`Invitación ${keys[index].id}: ${errorMessage(result.reason)}`] : []).join(' '));
                }
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
            }
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [keys]);

    const active = invitations.find(item => item.id === activeId) ?? null;
    const activeKey = keys.find(key => key.id === activeId) ?? null;
    const response = active ? pickResponse(active, chosenResponseId) : null;
    // Report only real changes (selection or the guest joining), not every poll.
    const signature = active && activeKey ? `${active.id}|${response?.id ?? ''}` : '';
    useEffect(() => {
        onActiveChange(active && activeKey ? { invitation: active, ownerToken: activeKey.ownerToken, response } : null);
    }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

    const select = (id: string | null) => {
        setActiveId(id);
        setChosenResponseId(null);
        setError('');
    };

    const createInvitation = async () => {
        setBusy(true);
        setError('');
        try {
            if (!hero) throw new Error('Primero sube tu foto de héroe.');
            if (!hostName.trim() || !guestName.trim()) throw new Error('Escribe tu nombre y el de tu coprotagonista.');
            if (settings.genre === 'Custom' && !settings.premise.trim()) throw new Error('Escribe de qué va tu historia antes de invitar.');
            localStorage.setItem(storageKeys.hostName, hostName.trim());
            const created = await invitationRequest<InvitationKeys>('', undefined, {
                hostName: hostName.trim(), guestName: guestName.trim(), hero, settings
            }, mutationController.current?.signal);
            if (mutationController.current?.signal.aborted) return;
            const updated = [...keys, created];
            localStorage.setItem(storageKeys.invitations, JSON.stringify(updated));
            setKeys(updated);
            select(created.id);
            setGuestName('');
        } catch (error) {
            if (!mutationController.current?.signal.aborted) setError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const forgetInvitation = (id: string) => {
        try {
            const updated = keys.filter(key => key.id !== id);
            localStorage.setItem(storageKeys.invitations, JSON.stringify(updated));
            setKeys(updated);
            setInvitations(current => current.filter(invitation => invitation.id !== id));
            if (activeId === id) select(null);
        } catch (error) {
            setError(errorMessage(error));
        }
    };

    const joinedName = (invitation: Invitation) => invitation.responses.length ? '✓ se ha unido' : '⏳ esperando';
    const others = invitations.filter(item => item.id !== activeId);
    const ready = mode === 'solo' || (mode === 'photo' && friend) || (mode === 'invite' && response);

    let url = '';
    try { if (activeKey) url = invitationUrl(baseUrl, activeKey); } catch { /* reported below */ }

    return (
        <div className={`p-3 border-4 border-dashed ${ready ? 'border-green-500 bg-green-50' : 'border-purple-300 bg-purple-50'} transition-colors`}>
            <p className="font-comic text-lg uppercase font-bold text-purple-900 mb-1">Coprotagonista</p>
            <div role="radiogroup" aria-label="Coprotagonista" className="grid grid-cols-3 gap-1 mb-2">
                {MODES.map(option => (
                    <button key={option.value} type="button" role="radio" aria-checked={mode === option.value}
                        onClick={() => onModeChange(option.value)}
                        className={`border-2 border-black px-1 py-1 leading-tight ${mode === option.value ? 'bg-purple-600 text-white shadow-none' : 'bg-white text-black shadow-[2px_2px_0px_black] hover:bg-purple-100'}`}>
                        <span className="font-comic text-base block">{option.label}</span>
                        <span className="text-[11px] block">{option.hint}</span>
                    </button>
                ))}
            </div>

            {mode === 'solo' && <p className="text-sm">La aventura será solo tuya.</p>}

            {mode === 'photo' && (friend ? (
                <div className="flex gap-3 items-center">
                    <img src={`data:image/jpeg;base64,${friend.base64}`} alt="Vista previa del coprotagonista" className="w-20 h-20 object-cover border-2 border-black bg-white rotate-[2deg]" />
                    <div className="text-sm">
                        <p className="text-green-700 font-bold font-comic">✓ LISTO</p>
                        <label className="cursor-pointer comic-btn bg-yellow-400 text-black text-sm px-3 py-1 inline-block mt-1">
                            REEMPLAZAR
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFriendUpload(e.target.files[0])} />
                        </label>
                    </div>
                </div>
            ) : (
                <>
                    <p className="text-sm mb-2">Sube tú la foto. Esa persona aparecerá en el cómic, pero no podrá seguirlo ni decidir nada.</p>
                    <label className="comic-btn bg-purple-500 text-white text-lg px-3 py-2 block w-full cursor-pointer text-center">
                        SUBIR SU FOTO
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFriendUpload(e.target.files[0])} />
                    </label>
                </>
            ))}

            {mode === 'invite' && !activeId && (
                <>
                    <p className="text-sm mb-2">Le envías un enlace, sube su propia foto y luego puede leer el cómic contigo y elegir en las decisiones. <strong>El cómic no empieza hasta que se una.</strong></p>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="text-sm font-bold">Tu nombre
                            <input maxLength={80} value={hostName} onChange={event => setHostName(event.target.value)} className="block w-full border-2 border-black p-1 bg-white font-normal" />
                        </label>
                        <label className="text-sm font-bold">Su nombre
                            <input maxLength={80} value={guestName} onChange={event => setGuestName(event.target.value)} className="block w-full border-2 border-black p-1 bg-white font-normal" />
                        </label>
                    </div>
                    <button type="button" onClick={createInvitation} disabled={busy || !hero} className="comic-btn bg-purple-600 text-white px-3 py-2 mt-2 w-full disabled:bg-gray-400">
                        {busy ? 'Creando...' : 'Crear invitación'}
                    </button>
                    {!hero && <p className="text-xs mt-1">Primero sube tu foto de héroe.</p>}
                    {others.length > 0 && (
                        <div className="mt-3">
                            <p className="text-sm font-bold">O sigue con una invitación anterior:</p>
                            <ul className="flex flex-col gap-1 mt-1">
                                {others.map(item => (
                                    <li key={item.id} className="flex items-center gap-2 border-2 border-black bg-white px-2 py-1">
                                        <span className="flex-1 text-sm"><strong>{item.guestName}</strong> · {joinedName(item)}</span>
                                        <button type="button" onClick={() => select(item.id)} className="comic-btn bg-purple-500 text-white text-sm px-2 py-0.5">Usar</button>
                                        <button type="button" onClick={() => forgetInvitation(item.id)} className="underline text-xs">Quitar</button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}

            {mode === 'invite' && activeId && (
                <div className="bg-white border-2 border-black p-2">
                    {!active ? <p role="status" className="text-sm">Cargando invitación...</p> : <>
                        <p className="font-comic text-lg">Invitación para {active.guestName}</p>
                        {!response ? <>
                            <ol className="text-sm list-decimal pl-5 my-1">
                                <li>Envíale el enlace.</li>
                                <li>{active.guestName} lo abre y sube su foto.</li>
                                <li>Aquí se activa el botón para empezar el cómic.</li>
                            </ol>
                            {url ? <ShareInvitation url={url} hostName={active.hostName} guestName={active.guestName} />
                                : <p role="alert" className="text-red-700 text-sm">La URL base configurada no es válida.</p>}
                            {isLoopbackUrl(baseUrl) && <p role="note" className="text-xs mt-1 text-amber-800">Estás en «localhost»: el enlace solo funcionará en este equipo. Abre la aplicación con su dirección de red o define PUBLIC_BASE_URL en el servidor.</p>}
                            <p role="status" className="font-bold text-purple-900 mt-2 animate-pulse">⏳ Esperando a que {active.guestName} se una...</p>
                        </> : <>
                            <div className="flex gap-3 items-center mt-1">
                                <img src={`data:image/jpeg;base64,${response.persona.base64}`} alt={`Foto de ${response.name}`} className="w-20 h-20 object-cover border-2 border-black rotate-[2deg]" />
                                <p role="status" className="text-green-700 font-bold">✓ {response.name} se ha unido. ¡Ya podéis empezar!</p>
                            </div>
                            {response.status !== 'accepted' && active.responses.length > 1 && (
                                <div className="mt-2">
                                    <p className="text-sm">Ha enviado varias fotos. Elige cuál usar:</p>
                                    <div className="flex gap-2 mt-1">
                                        {active.responses.map(item => (
                                            <button key={item.id} type="button" aria-pressed={item.id === response.id} onClick={() => setChosenResponseId(item.id)}
                                                className={`border-4 ${item.id === response.id ? 'border-green-600' : 'border-transparent'}`}>
                                                <img src={`data:image/jpeg;base64,${item.persona.base64}`} alt={`Foto ${active.responses.indexOf(item) + 1}`} className="w-12 h-12 object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>}
                        <p className="text-xs text-gray-700 mt-2">La historia queda fijada tal como la ve {active.guestName}. Para cambiarla, crea otra invitación.</p>
                    </>}
                    <div className="flex gap-3 mt-1 text-xs">
                        <button type="button" onClick={() => select(null)} className="underline">Cambiar de invitación</button>
                        <button type="button" onClick={() => forgetInvitation(activeId)} className="underline">Quitar de mi lista</button>
                    </div>
                </div>
            )}

            {error && <p role="alert" className="text-red-700 font-bold text-sm mt-2">{error}</p>}
            {mode === 'invite' && pollError && <p role="alert" className="text-red-700 text-xs mt-2">{pollError}</p>}
        </div>
    );
}
