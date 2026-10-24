import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { Persona } from './types';
import {
    errorMessage, invitationRequest, invitationUrl, normalizeBaseUrl, storageKeys,
    type Invitation, type InvitationKeys, type InvitationResponse, type StorySettings
} from './invitations';

interface InvitationPanelProps {
    hero: Persona | null;
    settings: StorySettings;
    onAccept: (invitation: Invitation, response: InvitationResponse, ownerToken: string) => void;
}

export function InvitationPanel({ hero, settings, onAccept }: InvitationPanelProps) {
    const [hostName, setHostName] = useState('');
    const [guestName, setGuestName] = useState('');
    const [baseUrl, setBaseUrl] = useState(window.location.origin);
    const [keys, setKeys] = useState<InvitationKeys[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [pollError, setPollError] = useState('');
    const [notice, setNotice] = useState('');
    const mutationController = useRef<AbortController | null>(null);

    useEffect(() => {
        mutationController.current = new AbortController();
        try {
            setHostName(localStorage.getItem(storageKeys.hostName) || '');
            setBaseUrl(localStorage.getItem(storageKeys.baseUrl) || window.location.origin);
            const saved: unknown = JSON.parse(localStorage.getItem(storageKeys.invitations) || '[]');
            if (!Array.isArray(saved) || !saved.every(item =>
                item && typeof item.id === 'string' && typeof item.ownerToken === 'string' && typeof item.guestToken === 'string'
            )) throw new Error('Las invitaciones guardadas no son válidas.');
            setKeys(saved);
        } catch (error) {
            setError(`No se pudo recuperar la configuración: ${errorMessage(error)}`);
        }
        setReady(true);
        return () => mutationController.current?.abort();
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
            } catch (error) {
                if (!controller.signal.aborted) setPollError(`No se pudieron actualizar las invitaciones: ${errorMessage(error)}`);
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
            }
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [keys]);

    const createInvitation = async () => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            if (!hero) throw new Error('Primero sube tu foto de protagonista.');
            if (!hostName.trim() || !guestName.trim()) throw new Error('Escribe tu nombre y el de la persona invitada.');
            if (settings.genre === 'Custom' && !settings.premise.trim()) throw new Error('Escribe la premisa de la historia antes de invitar.');
            const normalized = normalizeBaseUrl(baseUrl);
            localStorage.setItem(storageKeys.baseUrl, normalized);
            localStorage.setItem(storageKeys.hostName, hostName.trim());
            const created = await invitationRequest<InvitationKeys>('', undefined, {
                hostName: hostName.trim(), guestName: guestName.trim(), hero, settings
            }, mutationController.current?.signal);
            if (mutationController.current?.signal.aborted) return;
            const updated = [...keys, created];
            setKeys(updated);
            localStorage.setItem(storageKeys.invitations, JSON.stringify(updated));
            setBaseUrl(normalized);
            setGuestName('');
        } catch (error) {
            if (!mutationController.current?.signal.aborted) setError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const accept = async (invitation: Invitation, response: InvitationResponse) => {
        const key = keys.find(key => key.id === invitation.id);
        if (!key) return;
        setBusy(true);
        setError('');
        try {
            if (response.status !== 'accepted') {
                await invitationRequest(`/${key.id}/accept`, key.ownerToken, { responseId: response.id }, mutationController.current?.signal);
            }
            if (mutationController.current?.signal.aborted) return;
            onAccept(invitation, response, key.ownerToken);
            setInvitations(current => current.map(item => item.id === invitation.id ? {
                ...item, responses: item.responses.map(candidate => ({
                    ...candidate, status: candidate.id === response.id ? 'accepted' : 'pending'
                }))
            } : item));
            setNotice(`${response.name} ya está preparado. Pulsa «Empezar aventura» para crear la historia.`);
        } catch (error) {
            if (!mutationController.current?.signal.aborted) setError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const saveBaseUrl = () => {
        try {
            const normalized = normalizeBaseUrl(baseUrl);
            localStorage.setItem(storageKeys.baseUrl, normalized);
            setBaseUrl(normalized);
            setError('');
            setNotice('URL base guardada. Usa una dirección accesible desde el dispositivo de la persona invitada.');
        } catch (error) {
            setError(errorMessage(error));
        }
    };

    const forgetInvitation = (id: string) => {
        try {
            const updated = keys.filter(key => key.id !== id);
            localStorage.setItem(storageKeys.invitations, JSON.stringify(updated));
            setKeys(updated);
            setInvitations(current => current.filter(invitation => invitation.id !== id));
            setError('');
        } catch (error) {
            setError(errorMessage(error));
        }
    };

    return (
        <section className="border-4 border-black bg-purple-50 p-3 mb-4 text-left">
            <h2 className="font-comic text-2xl">Invitar a un coprotagonista</h2>
            <p className="text-sm mb-2">Comparte tu foto y esta configuración mediante una invitación. Las invitaciones caducan a los 7 días.</p>
            <div className="grid md:grid-cols-2 gap-2">
                <label className="text-sm font-bold">Tu nombre
                    <input aria-label="Tu nombre" maxLength={80} value={hostName} onChange={event => setHostName(event.target.value)} className="block w-full border-2 border-black p-2 bg-white" />
                </label>
                <label className="text-sm font-bold">Nombre de la persona invitada
                    <input aria-label="Nombre de la persona invitada" maxLength={80} value={guestName} onChange={event => setGuestName(event.target.value)} className="block w-full border-2 border-black p-2 bg-white" />
                </label>
            </div>
            <label className="block text-sm font-bold mt-2">URL base pública
                <input aria-label="URL base pública" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} className="block w-full border-2 border-black p-2 bg-white" />
            </label>
            <p className="text-xs mt-1">Por ejemplo, https://comics.example.com o http://192.168.1.10:3000. «localhost» no funciona desde otro dispositivo. Los enlaces nuevos usarán esta URL; la aplicación y su API deben estar disponibles en ella.</p>
            <div className="flex flex-wrap gap-2 mt-2">
                <button type="button" onClick={saveBaseUrl} disabled={!ready || busy} className="comic-btn bg-yellow-400 px-3 py-2">Guardar URL base</button>
                <button type="button" onClick={createInvitation} disabled={!ready || busy || !hero} className="comic-btn bg-purple-600 text-white px-3 py-2 disabled:bg-gray-400">{busy ? 'Procesando...' : 'Crear invitación'}</button>
            </div>
            {error && <p role="alert" className="text-red-700 font-bold mt-2">{error}</p>}
            {keys.length > 0 && pollError && <p role="alert" className="text-red-700 mt-2">{pollError}</p>}
            {notice && <p role="status" className="text-green-800 font-bold mt-2">{notice}</p>}
            {keys.map(key => {
                const invitation = invitations.find(item => item.id === key.id);
                let url: string;
                try { url = invitationUrl(baseUrl, key); } catch { return <p key={key.id}>Guarda una URL base válida para mostrar el enlace.</p>; }
                return (
                    <div key={key.id} className="border-2 border-black bg-white p-3 mt-3">
                        <h3 className="font-comic text-xl">Invitación para {invitation?.guestName || 'coprotagonista'}</h3>
                        <div className="flex flex-col sm:flex-row gap-3 mt-2 items-start">
                            <QRCodeSVG value={url} size={144} title="Código QR para unirse a la historia" />
                            <div className="min-w-0">
                                <a href={url} className="text-blue-800 underline break-all">{url}</a>
                                <p className="text-sm mt-2">Comparte este enlace o escanea el QR. Las fotos serán visibles para quienes tengan el enlace.</p>
                                <button type="button" className="underline text-sm mt-2" onClick={() => forgetInvitation(key.id)}>Quitar de mi lista</button>
                            </div>
                        </div>
                        {!invitation?.responses.length && <p className="mt-2 text-sm">Esperando a que acepte empezar una historia...</p>}
                        {invitation?.responses.map(response => (
                            <div key={response.id} className="flex flex-wrap items-center gap-3 border-t-2 mt-3 pt-2">
                                <img src={`data:image/jpeg;base64,${response.persona.base64}`} alt={`Foto de ${response.name}`} className="w-16 h-16 object-cover border-2 border-black" />
                                <p className="flex-1">{response.name} quiere empezar una historia.</p>
                                <button type="button" disabled={busy || (response.status !== 'accepted' && invitation.responses.some(item => item.status === 'accepted'))} onClick={() => accept(invitation, response)} className="comic-btn bg-green-500 px-3 py-2 disabled:bg-gray-400">
                                    {response.status === 'accepted' ? 'Preparar de nuevo' : 'Aceptar y preparar historia'}
                                </button>
                            </div>
                        ))}
                    </div>
                );
            })}
        </section>
    );
}
