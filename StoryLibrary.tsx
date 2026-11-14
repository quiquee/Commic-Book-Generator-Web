import React, { useEffect, useState } from 'react';
import { errorMessage } from './invitations';
import { t } from './i18n';
import { fetchStory, fetchStoryDelta, formatDate, loadStoryKeys, saveStoryKeys, deleteStory, type StoryDocument, type StoryKey, type StoryMeta } from './stories';
import { groupLibrary } from './seriesLogic';
import { downloadSeriesPdf } from './seriesPdf';

interface StoryLibraryProps {
    onOpen: (storyId: string) => void;
    // Loads a comic's parameters into the setup so a new one can be made from them.
    onRedo: (story: StoryDocument) => void;
    // Opens the «next issue» dialog for a finished comic (its pages come with the full document).
    onContinue: (story: StoryDocument, ownerToken: string) => void;
    onTitlesLoaded?: (titles: string[]) => void;
}

export function StoryLibrary({ onOpen, onRedo, onContinue, onTitlesLoaded }: StoryLibraryProps) {
    const [keys, setKeys] = useState<StoryKey[]>([]);
    const [stories, setStories] = useState<Record<string, StoryMeta | { missing: true }>>({});
    const [error, setError] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [redoingId, setRedoingId] = useState<string | null>(null);
    // Series whose issues are listed.
    const [openSeries, setOpenSeries] = useState<string[]>([]);
    // The series whose PDF is being put together, and how far it is.
    const [seriesPdf, setSeriesPdf] = useState<{ id: string; done: number; total: number } | null>(null);

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

    const forget = (...ids: string[]) => {
        const updated = keys.filter(key => !ids.includes(key.id));
        saveStoryKeys(updated);
        setKeys(updated);
        setConfirmId(null);
    };

    // Deletes every own comic of a series, last issue first, so a failure never leaves a gap in the middle.
    const removeSeries = async (comics: StoryKey[]) => {
        const gone: string[] = [];
        try {
            for (const key of [...comics].reverse()) {
                try {
                    await deleteStory(key.id, { kind: 'owner', token: key.ownerToken });
                } catch (failure) {
                    if ((failure as { status?: number }).status !== 404) throw failure;
                }
                gone.push(key.id);
            }
        } catch (failure) {
            setError(t('library.deleteFailed', { reason: errorMessage(failure) }));
        }
        forget(...gone);
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

    const continueSeries = async (key: StoryKey) => {
        setRedoingId(key.id);
        setError('');
        try {
            onContinue(await fetchStory(key.id, { kind: 'owner', token: key.ownerToken }), key.ownerToken);
        } catch (failure) {
            setError(t('continue.loadFailed', { reason: errorMessage(failure) }));
        } finally {
            setRedoingId(null);
        }
    };

    // The whole series in one PDF: the branch of the reader's latest issue, from the first issue on.
    const downloadSeries = async (seriesId: string, key: StoryKey) => {
        setSeriesPdf({ id: seriesId, done: 0, total: 0 });
        setError('');
        try {
            await downloadSeriesPdf(key.id, { kind: 'owner', token: key.ownerToken }, { onProgress: (done, total) => setSeriesPdf({ id: seriesId, done, total }) });
        } catch (failure) {
            setError(t('series.pdfFailed', { reason: errorMessage(failure) }));
        } finally {
            setSeriesPdf(null);
        }
    };

    if (!keys.length) return null;

    const keyOf = new Map(keys.map(key => [key.id, key]));
    const loadedComics = keys.flatMap(key => {
        const meta = stories[key.id];
        return meta && !('missing' in meta) ? [meta] : [];
    });
    const groups = groupLibrary(loadedComics);
    const finished = (meta: StoryMeta) => meta.completedPages >= meta.totalPages;
    const issueOf = (meta: StoryMeta) => meta.series?.issue ?? meta.continuation?.issue ?? 1;

    const deleteButtons = (confirmKey: string, confirmLabel: string, label: string, onConfirm: () => void) => confirmId !== confirmKey
        ? <button type="button" onClick={() => setConfirmId(confirmKey)} className="comic-btn btn-danger px-3 py-2">{label}</button>
        : <>
            <button type="button" onClick={onConfirm} className="comic-btn btn-danger px-3 py-2">{confirmLabel}</button>
            <button type="button" onClick={() => setConfirmId(null)} className="comic-btn btn-white px-3 py-2">{t('common.cancel')}</button>
        </>;

    // One comic: on its own row, or as an issue inside its series (where only the last issue can be deleted alone).
    const comicRow = (meta: StoryMeta, { inSeries = false, deletable = true } = {}) => {
        const key = keyOf.get(meta.id)!;
        return (
            <li key={meta.id} className={`border-2 border-black p-2 flex flex-wrap items-center gap-2 ${inSeries ? 'bg-sky-50' : 'bg-white'}`}>
                <div className="flex-1 min-w-[12rem]">
                    <p className="font-comic text-lg">{meta.title}{(inSeries || issueOf(meta) > 1) && <span className="text-xs font-sans ml-2 border border-black px-1">{t('library.issue', { issue: issueOf(meta) })}</span>}</p>
                    <p className="text-xs text-gray-700">{t('library.pages', { done: meta.completedPages, total: meta.totalPages })} · {formatDate(meta.updatedAt)}{meta.guestName ? ` · ${t('library.with', { name: meta.guestName })}` : ''}{!inSeries && meta.ownerAlias ? ` · ${t('library.alias', { alias: meta.ownerAlias })}` : ''}</p>
                </div>
                <button type="button" onClick={() => onOpen(meta.id)} className="comic-btn btn-blue px-3 py-2">{finished(meta) ? t('common.read') : t('common.continue')}</button>
                {!inSeries && finished(meta) && <button type="button" onClick={() => continueSeries(key)} disabled={redoingId !== null} className="comic-btn btn-primary px-3 py-2">{redoingId === key.id ? t('common.loading') : t('continue.button')}</button>}
                <button type="button" onClick={() => redo(key)} disabled={redoingId !== null} title={t('library.redoHint')} className="comic-btn btn-yellow px-3 py-2">{redoingId === key.id ? t('common.loading') : t('library.redo')}</button>
                {deletable && deleteButtons(meta.id, t('common.confirmDelete'), t('common.delete'), () => remove(key))}
            </li>
        );
    };

    return (
        <section className="border-4 border-black bg-sky-50 p-3 mb-4 text-left">
            <h2 className="font-comic text-2xl">{t('library.title')}</h2>
            <p className="text-sm mb-2">{t('library.hint')}</p>
            {error && <p role="alert" className="text-red-700 font-bold mb-2">{error}</p>}
            <ul className="flex flex-col gap-2">
                {groups.map(group => {
                    if (group.comics.length === 1) return comicRow(group.comics[0]);
                    const open = openSeries.includes(group.id);
                    const lastKey = keyOf.get(group.last.id)!;
                    const lastIssue = issueOf(group.last);
                    const guests = [...new Set(group.comics.map(meta => meta.guestName).filter(Boolean))];
                    const aliases = [...new Set(group.comics.flatMap(meta => meta.ownerAlias ? [meta.ownerAlias] : []))];
                    const confirmKey = `series:${group.id}`;
                    return (
                        <li key={confirmKey} className="border-2 border-black bg-white p-2 flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="flex-1 min-w-[12rem]">
                                    <p className="font-comic text-lg">{group.name}<span className="text-xs font-sans ml-2 border border-black bg-yellow-200 px-1">{t('library.seriesTag')}</span></p>
                                    <p className="text-xs text-gray-700">{t('library.seriesSummary', { issues: group.issues, pages: group.pages })} · {formatDate(group.updatedAt)}{guests.length ? ` · ${t('library.with', { name: guests.join(', ') })}` : ''}{aliases.length ? ` · ${t('library.alias', { alias: aliases.join(', ') })}` : ''}</p>
                                </div>
                                <button type="button" onClick={() => onOpen(group.comics[0].id)} className="comic-btn btn-blue px-3 py-2">{t('common.read')}</button>
                                {finished(group.last)
                                    ? <button type="button" onClick={() => continueSeries(lastKey)} disabled={redoingId !== null} className="comic-btn btn-primary px-3 py-2">{redoingId === lastKey.id ? t('common.loading') : t('continue.button')}</button>
                                    : <button type="button" onClick={() => onOpen(group.last.id)} className="comic-btn btn-primary px-3 py-2">{t('library.continueIssue', { issue: lastIssue })}</button>}
                                <button type="button" onClick={() => downloadSeries(group.id, lastKey)} disabled={seriesPdf !== null} className="comic-btn btn-blue px-3 py-2">
                                    {seriesPdf?.id !== group.id ? t('library.seriesPdf') : seriesPdf.total ? t('series.pdfProgress', { done: seriesPdf.done, total: seriesPdf.total }) : t('common.loading')}</button>
                                <button type="button" onClick={() => setOpenSeries(open ? openSeries.filter(id => id !== group.id) : [...openSeries, group.id])} aria-expanded={open}
                                  className="comic-btn btn-white px-3 py-2">{open ? t('library.hideIssues') : t('library.showIssues')} {open ? '▴' : '▾'}</button>
                                {deleteButtons(confirmKey, t('library.confirmDeleteSeries', { count: group.comics.length }), t('library.deleteSeries'), () => removeSeries(group.comics.map(meta => keyOf.get(meta.id)!)))}
                            </div>
                            {open && <>
                                <ul className="flex flex-col gap-2">
                                    {group.comics.map(meta => comicRow(meta, { inSeries: true, deletable: issueOf(meta) === lastIssue }))}
                                </ul>
                                <p className="text-xs text-gray-700">{t('library.deleteHint')}</p>
                            </>}
                        </li>
                    );
                })}
                {keys.filter(key => !stories[key.id] || 'missing' in stories[key.id]).map(key => {
                    const missing = !!stories[key.id];
                    return (
                        <li key={key.id} className="border-2 border-black bg-white p-2 flex flex-wrap items-center gap-2">
                            <div className="flex-1 min-w-[12rem]">
                                <p className="font-comic text-lg">{missing ? t('library.unavailable') : t('common.loading')}</p>
                                {missing && <p className="text-xs text-gray-700">{t('library.gone')}</p>}
                            </div>
                            {missing && <button type="button" onClick={() => forget(key.id)} className="comic-btn btn-white px-3 py-2">{t('library.forget')}</button>}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
