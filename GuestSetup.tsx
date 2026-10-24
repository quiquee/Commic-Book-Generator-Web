import React, { useEffect, useState } from 'react';
import { Setup } from './Setup';
import type { Persona } from './types';
import {
    errorMessage, invitationRequest, photoFromFile,
    type Invitation, type JoinCredentials
} from './invitations';
import { formatDate, type StorySummary } from './stories';

type GuestInvitation = Omit<Invitation, 'responses'> & { stories?: StorySummary[] };

interface GuestSetupProps {
    credentials: JoinCredentials;
    onOpenStory: (storyId: string) => void;
}

export function GuestSetup({ credentials, onOpenStory }: GuestSetupProps) {
    const [invitation, setInvitation] = useState<GuestInvitation | null>(null);
    const [photo, setPhoto] = useState<Persona | null>(null);
    const [responseId, setResponseId] = useState<string | null>(null);
    const [status, setStatus] = useState<'pending' | 'accepted' | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        try {
            const saved = sessionStorage.getItem(`infinite-heroes.response.${credentials.id}`);
            if (saved) {
                const data: unknown = JSON.parse(saved);
                if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string' ||
                    !('persona' in data) || !data.persona || typeof data.persona !== 'object' ||
                    !('base64' in data.persona) || typeof data.persona.base64 !== 'string' ||
                    !('desc' in data.persona) || typeof data.persona.desc !== 'string') {
                    throw new Error('La participación guardada no es válida.');
                }
                setResponseId(data.id);
                setPhoto({ base64: data.persona.base64, desc: data.persona.desc });
                setStatus('pending');
            }
        } catch (error) {
            setError(errorMessage(error));
        }
        invitationRequest<GuestInvitation>(`/${credentials.id}/join`, credentials.token, undefined, controller.signal)
            .then(setInvitation)
            .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
        return () => controller.abort();
    }, [credentials.id, credentials.token]);

    // Keeps the shared-comics list fresh while the host creates or completes stories.
    useEffect(() => {
        if (!invitation) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const latest = await invitationRequest<GuestInvitation>(`/${credentials.id}/join`, credentials.token, undefined, controller.signal);
                if (!controller.signal.aborted) setInvitation(latest);
            } catch {
                // Transient failures are reported by the other polling effect.
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
            }
        };
        timer = setTimeout(refresh, 5000);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [invitation?.id, credentials.id, credentials.token]);

    useEffect(() => {
        if (!responseId || status === 'accepted') return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const result = await invitationRequest<{ status: 'pending' | 'accepted' }>(
                    `/${credentials.id}/responses/${responseId}`, credentials.token, undefined, controller.signal
                );
                if (!controller.signal.aborted) { setStatus(result.status); setError(''); }
            } catch (error) {
                if (!controller.signal.aborted) setError(errorMessage(error));
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
            }
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [credentials.id, credentials.token, responseId, status]);

    const upload = async (file: File) => {
        setBusy(true);
        try {
            setPhoto(await photoFromFile(file));
            setError('');
        } catch (error) {
            setError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const join = async () => {
        if (!photo || responseId) return;
        setBusy(true);
        setError('');
        try {
            const result = await invitationRequest<{ id: string; status: 'pending' }>(
                `/${credentials.id}/responses`, credentials.token, { persona: photo }
            );
            setResponseId(result.id);
            setStatus(result.status);
            sessionStorage.setItem(`infinite-heroes.response.${credentials.id}`, JSON.stringify({ id: result.id, persona: photo }));
        } catch (error) {
            setError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    if (!invitation) return (
        <div className="bg-white border-4 border-black p-8 max-w-lg">
            <h1 className="font-comic text-3xl">Unirse a una historia</h1>
            {error ? <p role="alert" className="text-red-700">{error}</p> : <p role="status">Cargando invitación...</p>}
        </div>
    );

    return (
        <Setup
            show isTransitioning={false}
            hero={invitation.hero} friend={photo}
            selectedGenre={invitation.settings.genre}
            selectedLanguage={invitation.settings.language}
            customPremise={invitation.settings.premise}
            richMode={invitation.settings.richMode}
            guestMode hostName={invitation.hostName} guestName={invitation.guestName}
            friendPhotoLocked={!!responseId || busy}
            onHeroUpload={() => {}} onFriendUpload={upload}
            onGenreChange={() => {}} onLanguageChange={() => {}}
            onPremiseChange={() => {}} onRichModeChange={() => {}}
            onLaunch={join}
            launchDisabled={!photo || busy || !!responseId}
            launchLabel={busy ? 'Procesando...' : responseId ? 'Solicitud enviada' : '¡Empezar historia juntos!'}
        >
            <div className="text-left border-2 border-black bg-blue-50 p-3 mb-4">
                <p>Has recibido una invitación de <strong>{invitation.hostName}</strong> para ser coprotagonista como <strong>{invitation.guestName}</strong>.</p>
                {!responseId && <p>Sube únicamente tu foto y pulsa «Empezar historia juntos». El protagonista confirmará tu participación y creará la historia desde su dispositivo.</p>}
                {status === 'pending' && <p role="status" className="font-bold">Foto enviada. Esperando la confirmación de {invitation.hostName}...</p>}
                {status === 'accepted' && <p role="status" className="font-bold text-green-800">¡{invitation.hostName} ha aceptado! El cómic aparecerá en la lista de abajo en cuanto empiece a crearse.</p>}
                {error && <p role="alert" className="text-red-700">{error}</p>}
            </div>
            {!!invitation.stories?.length && (
                <section className="text-left border-4 border-black bg-green-50 p-3 mb-4">
                    <h2 className="font-comic text-2xl">Cómics compartidos contigo</h2>
                    <p className="text-sm mb-2">Puedes leerlos mientras se crean y tomar las decisiones de la historia. Solo {invitation.hostName} puede borrarlos.</p>
                    <ul className="flex flex-col gap-2">
                        {invitation.stories.map(summary => (
                            <li key={summary.id} className="border-2 border-black bg-white p-2 flex flex-wrap items-center gap-2">
                                <div className="flex-1 min-w-[12rem]">
                                    <p className="font-comic text-lg">{summary.title}</p>
                                    <p className="text-xs text-gray-700">{summary.completedPages}/{summary.totalPages} páginas · {formatDate(summary.updatedAt)}</p>
                                </div>
                                <button type="button" onClick={() => onOpenStory(summary.id)} className="comic-btn bg-blue-500 text-white px-3 py-2">Abrir</button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </Setup>
    );
}
