import React, { useEffect, useState } from 'react';
import { errorMessage } from './invitations';
import { t } from './i18n';
import { fetchStory, fetchStoryDelta, formatDate, loadStoryKeys, saveStoryKeys, deleteStory, type StoryDocument, type StoryKey, type StoryMeta } from './stories';

interface StoryLibraryProps {
    onOpen: (storyId: string) => void;
    // Loads a comic's parameters into the setup so a new one can be made from them.
    onRedo: (story: StoryDocument) => void;
    onTitlesLoaded?: (titles: string[]) => void;
}

export function StoryLibrary({ onOpen, onRedo, onTitlesLoaded }: StoryLibraryProps) {
    const [keys, setKeys] = useState<StoryKey[]>([]);
    const [stories, setStories] = useState<Record<string, StoryMeta | { missing: true }>>({});
    const [error, setError] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [redoingId, setRedoingId] = useState<string | null>(null);

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
            setError(problems[0] ? t('library.loadSomeFailed', { reason: problems[0] }) : '');
            onTitlesLoaded?.(Object.values(next).flatMap(meta => 'missing' in meta ? [] : [meta.title]));
        });
        return () => controller.abort();
    }, [keys, onTitlesLoaded]);

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
            setError(t('library.deleteFailed', { reason: errorMessage(failure) }));
        }
    };

    // The library only has summaries; the photos come with the full comic.
    const redo = async (key: StoryKey) => {
        setRedoingId(key.id);
        setError('');
        try {
            onRedo(await fetchStory(key.id, { kind: 'owner', token: key.ownerToken }));
        } catch (failure) {
            setError(t('library.redoFailed', { reason: errorMessage(failure) }));
        } finally {
            setRedoingId(null);
        }
    };

    if (!keys.length) return null;

    return (
        <section className="border-4 border-black bg-green-50 p-3 mb-4 text-left">
            <h2 className="font-comic text-2xl">{t('library.title')}</h2>
            <p className="text-sm mb-2">{t('library.hint')}</p>
            {error && <p role="alert" className="text-red-700 font-bold mb-2">{error}</p>}
            <ul className="flex flex-col gap-2">
                {keys.map(key => {
                    const meta = stories[key.id];
                    const missing = !!meta && 'missing' in meta;
                    const loaded = meta && !('missing' in meta) ? meta : null;
                    return (
                        <li key={key.id} className="border-2 border-black bg-white p-2 flex flex-wrap items-center gap-2">
                            <div className="flex-1 min-w-[12rem]">
                                <p className="font-comic text-lg">{loaded?.title ?? (missing ? t('library.unavailable') : t('common.loading'))}</p>
                                {loaded && <p className="text-xs text-gray-700">{t('library.pages', { done: loaded.completedPages, total: loaded.totalPages })} · {formatDate(loaded.updatedAt)}{loaded.guestName ? ` · ${t('library.with', { name: loaded.guestName })}` : ''}</p>}
                                {missing && <p className="text-xs text-gray-700">{t('library.gone')}</p>}
                            </div>
                            {loaded && <button type="button" onClick={() => onOpen(key.id)} className="comic-btn bg-blue-500 text-white px-3 py-2">{loaded.completedPages >= loaded.totalPages ? t('common.read') : t('common.continue')}</button>}
                            {loaded && <button type="button" onClick={() => redo(key)} disabled={redoingId !== null} title={t('library.redoHint')} className="comic-btn bg-yellow-400 text-black px-3 py-2">{redoingId === key.id ? t('common.loading') : t('library.redo')}</button>}
                            {missing && <button type="button" onClick={() => forget(key.id)} className="comic-btn bg-gray-200 px-3 py-2">{t('library.forget')}</button>}
                            {loaded && confirmId !== key.id && <button type="button" onClick={() => setConfirmId(key.id)} className="comic-btn bg-red-600 text-white px-3 py-2">{t('common.delete')}</button>}
                            {loaded && confirmId === key.id && <>
                                <button type="button" onClick={() => remove(key)} className="comic-btn bg-red-700 text-white px-3 py-2">{t('common.confirmDelete')}</button>
                                <button type="button" onClick={() => setConfirmId(null)} className="comic-btn bg-gray-200 px-3 py-2">{t('common.cancel')}</button>
                            </>}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
