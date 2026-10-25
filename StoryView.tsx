import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import { Book } from './Book';
import { TOTAL_PAGES, type ComicFace } from './types';
import { errorMessage } from './invitations';
import { fetchStory, fetchStoryDelta, restartGeneration, submitChoice, type StoryAuth, type StoryDocument } from './stories';
import { findFace, isStoryFinished, mergeFaces, pendingDecision, upsertFace } from './storyLogic';
import { titleSlug } from './titles';
import { NotifyPrompt } from './NotifyPrompt';
import { localizeText, t } from './i18n';

interface StoryViewProps {
    storyId: string;
    auth: StoryAuth;
    onExit: () => void;
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function StoryView({ storyId, auth, onExit }: StoryViewProps) {
    const [story, setStory] = useState<StoryDocument | null>(null);
    const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const storyRef = useRef<StoryDocument | null>(null);
    const versionRef = useRef(0);

    const isOwner = auth.kind === 'owner';

    const updateStory = useCallback((updater: (current: StoryDocument) => StoryDocument) => {
        if (!storyRef.current) return;
        storyRef.current = updater(storyRef.current);
        setStory(storyRef.current);
    }, []);

    const applyFace = useCallback((face: ComicFace) => {
        updateStory(current => ({ ...current, faces: upsertFace(current.faces, face) }));
    }, [updateStory]);

    useEffect(() => {
        const controller = new AbortController();
        fetchStory(storyId, auth, controller.signal)
            .then(document => {
                storyRef.current = document;
                versionRef.current = document.version;
                setStory(document);
                setError('');
            })
            .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
        return () => controller.abort();
    }, [storyId, auth]);

    useEffect(() => {
        if (!story?.title) return;
        const previous = document.title;
        document.title = `${story.title} · Mundos Cruzados (beta)`;
        return () => { document.title = previous; };
    }, [story?.title]);

    useEffect(() => {
        if (!story) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const tick = async () => {
            try {
                const delta = await fetchStoryDelta(storyId, auth, versionRef.current, controller.signal);
                if (controller.signal.aborted) return;
                versionRef.current = Math.max(versionRef.current, delta.version);
                updateStory(current => ({
                    ...current,
                    title: delta.title, tone: delta.tone, styleGuide: delta.styleGuide || current.styleGuide,
                    completedPages: delta.completedPages, updatedAt: delta.updatedAt, generation: delta.generation,
                    // The server draws every page, so all readers take its version of them.
                    faces: mergeFaces(current.faces, delta.faces, 'guest')
                }));
            } catch (failure) {
                if (controller.signal.aborted) return;
                if ((failure as { status?: number }).status === 404) {
                    setError(t('view.deleted'));
                    return;
                }
                setNotice(t('view.offline', { reason: errorMessage(failure) }));
            }
            if (!controller.signal.aborted) timer = setTimeout(tick, 3000);
        };
        timer = setTimeout(tick, 3000);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [story?.id, storyId, auth, isOwner, updateStory]);

    // Comics are drawn on the server. The owner nudges it for comics it has not picked up yet
    // (e.g. created before background generation existed); it is a no-op for one already in progress.
    useEffect(() => {
        if (!story || !isOwner || story.generation || isStoryFinished(story.faces)) return;
        restartGeneration(storyId, auth).catch(() => { /* the status line shows what happens next */ });
    }, [story?.id, isOwner, storyId, auth]); // eslint-disable-line react-hooks/exhaustive-deps

    const retry = async () => {
        setError('');
        try {
            await restartGeneration(storyId, auth);
            updateStory(current => ({ ...current, generation: { state: 'queued', at: Date.now() } }));
        } catch (failure) {
            setError(t('view.resumeFailed', { reason: errorMessage(failure) }));
        }
    };

    const choose = async (pageIndex: number, choice: string) => {
        const face = story && findFace(story.faces, pageIndex);
        if (!face || face.resolvedChoice) return;
        applyFace({ ...face, resolvedChoice: choice });
        try {
            const result = await submitChoice(storyId, auth, face.id, choice);
            versionRef.current = Math.max(versionRef.current, result.version);
        } catch (failure) {
            const resolved = (failure as { resolvedChoice?: string }).resolvedChoice;
            if (resolved) {
                applyFace({ ...face, resolvedChoice: resolved });
                setNotice(t('view.decidedFirst', { choice: resolved }));
            } else {
                applyFace(face);
                setError(t('view.choiceFailed', { reason: errorMessage(failure) }));
            }
        }
    };

    const downloadPDF = () => {
        if (!story) return;
        const pages = story.faces.filter(face => face.imageUrl && !face.isLoading).sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
        if (!pages.length) return;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [480, 720] });
        const cast = story.guestName ? t('pdf.castPair', { host: story.hostName, guest: story.guestName }) : story.hostName;
        doc.setProperties({ title: story.title, subject: t('pdf.subject', { cast }), author: story.hostName, creator: 'Mundos Cruzados' });
        pages.forEach((face, index) => {
            if (index > 0) doc.addPage([480, 720], 'portrait');
            doc.addImage(face.imageUrl!, 'JPEG', 0, 0, 480, 720);
        });
        doc.save(`${titleSlug(story.title)}.pdf`);
    };

    const sharePage = async (face: ComicFace) => {
        if (!face.imageUrl || !story) return;
        const label = face.type === 'cover' ? t('file.cover') : face.type === 'back_cover' ? t('file.backCover') : t('file.page', { page: face.pageIndex ?? '' });
        try {
            const blob = await (await fetch(face.imageUrl)).blob();
            const file = new File([blob], `${titleSlug(story.title)}-${label}.jpg`, { type: 'image/jpeg' });
            const share = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
            if (share.share && share.canShare?.({ files: [file] })) {
                await share.share({ files: [file], title: story.title, text: `${story.title} – ${label}` });
                return;
            }
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = file.name;
            link.click();
            URL.revokeObjectURL(link.href);
            setNotice(t('view.shareDownloaded'));
        } catch (failure) {
            if (!isAbort(failure)) setError(t('view.shareFailed', { reason: errorMessage(failure) }));
        }
    };

    const handleSheetClick = (index: number) => {
        if (!story) return;
        if (index === 0 && currentSheetIndex === 0) return;
        if (index < currentSheetIndex) setCurrentSheetIndex(index);
        else if (index === currentSheetIndex && findFace(story.faces, index)?.imageUrl) setCurrentSheetIndex(prev => prev + 1);
    };

    const statusText = (() => {
        if (!story) return '';
        const decision = pendingDecision(story.faces);
        if (decision) return t('status.decision', { page: decision.pageIndex ?? '' });
        if (isStoryFinished(story.faces)) return t('status.finished');
        const generation = story.generation;
        switch (generation?.state) {
            case 'styling': return t('status.styling');
            case 'generating': return generation.pageIndex === 0 ? t('status.cover')
                : generation.pageIndex === TOTAL_PAGES ? t('status.backCover')
                : t('status.page', { page: generation.pageIndex ?? '', total: TOTAL_PAGES - 1 });
            case 'retrying': return t('status.retrying', { attempt: generation.attempt ?? 1 });
            case 'stopped': return t('status.stopped', { reason: localizeText(generation.reason ?? '') });
            default: return t('status.queued', { done: story.completedPages, total: TOTAL_PAGES + 1 });
        }
    })();
    const inProgress = !!story && !isStoryFinished(story.faces) && story.generation?.state !== 'stopped';

    const hasPages = !!story?.faces.some(face => face.imageUrl);

    return (
        <>
            <div className="fixed top-2 right-2 z-[500] flex flex-wrap justify-end gap-2 max-w-[70vw]">
                <button type="button" onClick={downloadPDF} disabled={!hasPages} className="comic-btn bg-blue-500 text-white px-3 py-2 text-lg disabled:bg-gray-400">{t('view.downloadPdf')}</button>
                {isOwner && story?.generation?.state === 'stopped' && <button type="button" onClick={retry} className="comic-btn bg-yellow-400 px-3 py-2 text-lg">{t('view.retry')}</button>}
            </div>
            <div className="fixed top-16 inset-x-0 z-[450] flex flex-col items-center gap-1 pointer-events-none px-4">
                {story && <p role="status" className="font-comic text-lg text-white bg-black/70 px-3 py-1 border-2 border-yellow-400">{story.title} · {statusText}</p>}
                {inProgress && !pendingDecision(story!.faces) && <p className="text-xs text-white bg-black/60 px-2 py-0.5">{t('view.canClose')}</p>}
                {notice && <p role="status" className="pointer-events-auto text-sm bg-white border-2 border-black px-3 py-1">{notice} <button type="button" className="underline ml-1" onClick={() => setNotice('')}>{t('common.close')}</button></p>}
                {error && <p role="alert" className="pointer-events-auto text-sm bg-white border-2 border-red-800 text-red-800 px-3 py-1">{error} <button type="button" className="underline ml-1" onClick={() => setError('')}>{t('common.close')}</button></p>}
            </div>
            {story && <Book
                comicFaces={story.faces}
                currentSheetIndex={currentSheetIndex}
                isStarted
                isSetupVisible={false}
                onSheetClick={handleSheetClick}
                onChoice={choose}
                onOpenBook={() => setCurrentSheetIndex(1)}
                onDownload={downloadPDF}
                onReset={onExit}
                onShare={sharePage}
            />}
            {!story && !error && <p role="status" className="font-comic text-3xl text-white">{t('view.loading')}</p>}
            {story && <NotifyPrompt storyId={storyId} auth={auth} active={inProgress} />}
        </>
    );
}
