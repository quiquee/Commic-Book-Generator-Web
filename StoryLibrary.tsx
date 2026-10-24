import React, { useEffect, useState } from 'react';
import { errorMessage } from './invitations';
import { fetchStoryDelta, formatDate, loadStoryKeys, saveStoryKeys, deleteStory, type StoryKey, type StoryMeta } from './stories';

interface StoryLibraryProps {
    onOpen: (storyId: string) => void;
}

export function StoryLibrary({ onOpen }: StoryLibraryProps) {
    const [keys, setKeys] = useState<StoryKey[]>([]);
    const [stories, setStories] = useState<Record<string, StoryMeta | { missing: true }>>({});
    const [error, setError] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);

    useEffect(() => {
        try {
            setKeys(loadStoryKeys());
        } catch (failure) {
            setError(errorMessage(failure));
        }
    }, []);

    useEffect(() => {
        if (!keys.length) return;
        const controller = new AbortController();
        Promise.allSettled(keys.map(key =>
            fetchStoryDelta(key.id, { kind: 'owner', token: key.ownerToken }, Number.MAX_SAFE_INTEGER, controller.signal)
        )).then(results => {
            if (controller.signal.aborted) return;
            const next: Record<string, StoryMeta | { missing: true }> = {};
            const problems: string[] = [];
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') next[keys[index].id] = result.value;
                else if ((result.reason as { status?: number }).status === 404 || (result.reason as { status?: number }).status === 401) next[keys[index].id] = { missing: true };
                else problems.push(errorMessage(result.reason));
            });
            setStories(next);
            setError(problems[0] ? `No se pudieron cargar algunos cómics: ${problems[0]}` : '');
        });
        return () => controller.abort();
    }, [keys]);

    const forget = (id: string) => {
        const updated = keys.filter(key => key.id !== id);
        saveStoryKeys(updated);
        setKeys(updated);
        setConfirmId(null);
    };

    const remove = async (key: StoryKey) => {
        try {
            await deleteStory(key.id, { kind: 'owner', token: key.ownerToken });
            forget(key.id);
        } catch (failure) {
            if ((failure as { status?: number }).status === 404) { forget(key.id); return; }
            setError(`No se pudo borrar el cómic: ${errorMessage(failure)}`);
        }
    };

    if (!keys.length) return null;

    return (
        <section className="border-4 border-black bg-green-50 p-3 mb-4 text-left">
            <h2 className="font-comic text-2xl">Mis cómics</h2>
            <p className="text-sm mb-2">Los cómics se guardan en el servidor y puedes continuarlos desde aquí. Solo tú puedes borrarlos.</p>
            {error && <p role="alert" className="text-red-700 font-bold mb-2">{error}</p>}
            <ul className="flex flex-col gap-2">
                {keys.map(key => {
                    const meta = stories[key.id];
                    const missing = !!meta && 'missing' in meta;
                    const loaded = meta && !('missing' in meta) ? meta : null;
                    return (
                        <li key={key.id} className="border-2 border-black bg-white p-2 flex flex-wrap items-center gap-2">
                            <div className="flex-1 min-w-[12rem]">
                                <p className="font-comic text-lg">{loaded?.title ?? (missing ? 'Cómic no disponible' : 'Cargando...')}</p>
                                {loaded && <p className="text-xs text-gray-700">{loaded.completedPages}/{loaded.totalPages} páginas · {formatDate(loaded.updatedAt)}{loaded.guestName ? ` · con ${loaded.guestName}` : ''}</p>}
                                {missing && <p className="text-xs text-gray-700">Ya no existe en el servidor.</p>}
                            </div>
                            {loaded && <button type="button" onClick={() => onOpen(key.id)} className="comic-btn bg-blue-500 text-white px-3 py-2">{loaded.completedPages >= loaded.totalPages ? 'Leer' : 'Continuar'}</button>}
                            {missing && <button type="button" onClick={() => forget(key.id)} className="comic-btn bg-gray-200 px-3 py-2">Quitar de la lista</button>}
                            {loaded && confirmId !== key.id && <button type="button" onClick={() => setConfirmId(key.id)} className="comic-btn bg-red-600 text-white px-3 py-2">Borrar</button>}
                            {loaded && confirmId === key.id && <>
                                <button type="button" onClick={() => remove(key)} className="comic-btn bg-red-700 text-white px-3 py-2">Confirmar borrado</button>
                                <button type="button" onClick={() => setConfirmId(null)} className="comic-btn bg-gray-200 px-3 py-2">Cancelar</button>
                            </>}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
