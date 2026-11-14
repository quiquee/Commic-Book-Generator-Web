import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createComicPdf, pdfFileName } from './comicPdf';
import { downloadSeriesPdf } from './seriesPdf';
import { Book } from './Book';
import { TOTAL_PAGES, type ComicFace } from './types';
import { copyText, errorMessage, fetchPublicBaseUrl } from './invitations';
import { comicOf, copyStory, createReadLink, fetchSeries, fetchStoryDelta, holdsKey, issueAuth, keepStory, openStory, prefetchStory, readLinkUrl, restartGeneration, submitChoice, updateInstructions, type CopiedStory, type StoryAuth, type StoryDocument } from './stories';
import { finishedIssues, seriesPosition, type SeriesNode, type SeriesTree } from './seriesLogic';
import { SeriesChooser } from './SeriesChooser';
import { findFace, isStoryFinished, mergeFaces, pendingDecision, upsertFace } from './storyLogic';
import { titleSlug } from './titles';
import { NotifyPrompt } from './NotifyPrompt';
import { Credits } from './Credits';
import { ContinueStory } from './ContinueStory';
import { moodFor, type Mood } from './music';
import { localizeText, t, tFor } from './i18n';

interface StoryViewProps {
    storyId: string;
    auth: StoryAuth;
    onExit: () => void;
    // The comic was copied into the visitor's own library: opens that copy.
    onCopied?: (key: CopiedStory) => void;
    // Tells the music player which mood fits this comic (null when leaving it).
    onMood?: (mood: Mood | null) => void;
    // Opens another issue of the series (at its back cover when the reader came to it turning pages backwards).
    onOpenIssue?: (storyId: string, options: { atEnd: boolean }) => void;
    // Open the comic at its back cover instead of its cover.
    startAtEnd?: boolean;
}

// Sheets of paper in an issue: with all of them turned, the back cover is in view.
const SHEETS = Math.floor(TOTAL_PAGES / 2) + 1;

// The series of the comic read last, so the next issue shows its place in the series while it loads.
let lastTree: SeriesTree | null = null;

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function StoryView({ storyId, auth, onExit, onCopied, onMood, onOpenIssue, startAtEnd }: StoryViewProps) {
    const [story, setStory] = useState<StoryDocument | null>(null);
    const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    // «Back to menu» at the end of the comic shows the credits before leaving.
    const [showCredits, setShowCredits] = useState(false);
    // Dialog to rewrite the instructions after Gemini refused the content.
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [continuing, setContinuing] = useState(false);
    const [statusHidden, setStatusHidden] = useState(false);
    const [tree, setTree] = useState<SeriesTree | null>(() => lastTree?.nodes.some(node => node.stories.includes(storyId)) ? lastTree : null);
    // Which issues the chooser offers: the ones that continue this issue, or the other versions of it.
    const [choosing, setChoosing] = useState<'next' | 'versions' | null>(null);
    // How far the PDF of the whole series is, while it is being put together.
    const [seriesPdf, setSeriesPdf] = useState<{ done: number; total: number } | null>(null);
    const storyRef = useRef<StoryDocument | null>(null);
    const versionRef = useRef(0);

    const isOwner = auth.kind === 'owner';
    // The server says what this key may do here: a link or a key of another comic of the series only reads.
    const readOnly = story ? story.role === 'reader' || story.role === 'family' : auth.kind === 'reader' || auth.kind === 'family';

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
        openStory(storyId, auth, controller.signal)
            .then(document => {
                if (controller.signal.aborted) return;
                storyRef.current = document;
                versionRef.current = document.version;
                if (startAtEnd && isStoryFinished(document.faces)) setCurrentSheetIndex(SHEETS);
                setStory(document);
                setError('');
            })
            .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
        return () => controller.abort();
    }, [storyId, auth]); // eslint-disable-line react-hooks/exhaustive-deps

    // The other issues of the series; asked again at the back cover, where a new next issue matters.
    const atBackCover = currentSheetIndex >= SHEETS;
    useEffect(() => {
        if (!story?.id) return;
        const controller = new AbortController();
        fetchSeries(storyId, auth, controller.signal)
            .then(result => { lastTree = result; setTree(result); })
            .catch(() => { /* the comic reads fine without its series */ });
        return () => controller.abort();
    }, [story?.id, storyId, auth, atBackCover]);

    // The genre and tone are known once the comic loads: the music follows them.
    const genre = story?.settings.genre;
    const tone = story?.tone;
    useEffect(() => {
        if (!genre) return;
        onMood?.(moodFor(genre, tone ?? ''));
        return () => onMood?.(null);
    }, [genre, tone]); // eslint-disable-line react-hooks/exhaustive-deps

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
                    title: delta.title, tone: delta.tone, styleGuide: delta.styleGuide || current.styleGuide, soundEffects: delta.soundEffects ?? current.soundEffects,
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

    const currentInstructions = story
        ? (story.settings.genre === 'Custom' ? story.settings.premise : story.settings.extraInstructions) ?? ''
        : '';
    const openInstructions = () => { setDraft(currentInstructions); setEditing(true); };

    const saveInstructions = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
            await updateInstructions(storyId, auth, draft.trim());
            updateStory(current => ({
                ...current,
                settings: current.settings.genre === 'Custom'
                    ? { ...current.settings, premise: draft.trim() }
                    : { ...current.settings, extraInstructions: draft.trim() },
                generation: { state: 'queued', at: Date.now() }
            }));
            setEditing(false);
        } catch (failure) {
            setError(t('view.instructionsFailed', { reason: errorMessage(failure) }));
        } finally {
            setSaving(false);
        }
    };

    const choose = async (pageIndex: number, choice: string) => {
        const face = story && findFace(story.faces, pageIndex);
        if (!face || face.resolvedChoice) return;
        if (readOnly) { setNotice(t('view.readOnly')); return; }
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
        const cast = story.guestName ? t('pdf.castPair', { host: story.hostName, guest: story.guestName }) : story.hostName;
        const pdf = createComicPdf({ title: story.title, subject: t('pdf.subject', { cast }), author: story.hostName });
        if (pdf.addIssue({ faces: story.faces, language: story.settings.language })) pdf.doc.save(pdfFileName(titleSlug(story.title)));
    };

    // Every finished issue of the branch being read, first issue first, in one PDF.
    const downloadSeries = async () => {
        if (!story || !tree || seriesPdf) return;
        setSeriesPdf({ done: 0, total: seriesIssues.length });
        try {
            await downloadSeriesPdf(storyId, auth, { tree, current: story, onProgress: (done, total) => setSeriesPdf({ done, total }) });
        } catch (failure) {
            setError(t('series.pdfFailed', { reason: errorMessage(failure) }));
        } finally {
            setSeriesPdf(null);
        }
    };

    // Shares a link anyone can open to read the comic (a reader re-shares the link they came with).
    const shareLink = async () => {
        if (!story) return;
        try {
            const baseUrl = await fetchPublicBaseUrl().catch(() => null);
            const url = auth.kind === 'reader' ? readLinkUrl(baseUrl, storyId, auth.token) : await createReadLink(storyId, auth, baseUrl);
            if (navigator.share) {
                await navigator.share({ title: story.title, text: t('view.shareText', { title: story.title }), url });
                return;
            }
            try {
                await copyText(url);
                setNotice(t('view.shareCopied'));
            } catch {
                setNotice(t('view.shareManual', { url }));
            }
        } catch (failure) {
            if (!isAbort(failure)) setError(t('view.shareFailed', { reason: errorMessage(failure) }));
        }
    };

    // Whoever opened a finished comic through a link (reader or invited co-star) keeps their own copy.
    const saveCopy = async () => {
        try {
            onCopied?.(await copyStory(storyId, auth));
        } catch (failure) {
            setError(t('copy.failed', { reason: errorMessage(failure) }));
        }
    };

    const position = tree ? seriesPosition(tree, storyId, holdsKey) : null;
    const finished = !!story && isStoryFinished(story.faces);
    const seriesIssues = position ? finishedIssues(position) : [];

    // Another comic of the series opens with its own key when the reader has it, with this comic's key otherwise.
    const authFor = useCallback((id: string): StoryAuth => issueAuth(auth, id), [auth]);

    const openIssue = (node: SeriesNode, atEnd = false) => {
        if (!onOpenIssue) return;
        setChoosing(null);
        if (comicOf(node) === storyId) return;
        if (storyRef.current && isStoryFinished(storyRef.current.faces)) keepStory(auth, storyRef.current);
        onOpenIssue(comicOf(node), { atEnd });
    };
    const nextIssue = () => {
        if (!position?.next.length) return;
        if (position.next.length > 1) setChoosing('next');
        else openIssue(position.next[0]);
    };

    // Past the middle of an issue, its next one starts loading so the last page turns straight into it.
    const upcoming = finished && currentSheetIndex >= 3 && position?.next.length ? comicOf(position.next[0]) : null;
    useEffect(() => {
        if (upcoming) prefetchStory(upcoming, authFor(upcoming));
    }, [upcoming, authFor]);

    // The arrow keys turn the pages and go on into the next or the previous issue.
    const turnRef = useRef<(forward: boolean) => void>(() => {});
    turnRef.current = (forward: boolean) => {
        if (!story || editing || continuing || choosing || showCredits) return;
        if (forward) {
            if (currentSheetIndex < SHEETS) { if (findFace(story.faces, currentSheetIndex * 2 + 1)?.imageUrl) setCurrentSheetIndex(currentSheetIndex + 1); }
            else nextIssue();
        } else if (currentSheetIndex > 0) setCurrentSheetIndex(currentSheetIndex - 1);
        else if (position?.previous) openIssue(position.previous, true);
    };
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
            if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
            // On narrow screens the open book is wider than the window and the arrows scroll across it.
            if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) return;
            turnRef.current(event.key === 'ArrowRight');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

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
            case 'stopped': return t('status.stopped', { reason: `${localizeText(generation.reason ?? '')}${generation.detail ? ` (${generation.detail})` : ''}` });
            default: return t('status.queued', { done: story.completedPages, total: TOTAL_PAGES + 1 });
        }
    })();
    const inProgress = !!story && !isStoryFinished(story.faces) && story.generation?.state !== 'stopped';

    const hasPages = !!story?.faces.some(face => face.imageUrl);

    return (
        <>
            <div className="fixed bottom-2 inset-x-0 z-[450] flex flex-col items-center gap-1 pointer-events-none px-4">
                {story && position && (position.path.length > 1 || position.versions.length > 1) && (
                    <nav aria-label={t('series.nav')} className="pointer-events-auto max-w-full flex items-center gap-2 sm:gap-3 font-comic text-sm sm:text-base text-white bg-black/80 px-2 py-1 border-2 border-yellow-400">
                        <button type="button" disabled={!position.previous} onClick={() => position.previous && openIssue(position.previous)} aria-label={t('series.previous')}
                          className="shrink-0 whitespace-nowrap px-2 bg-yellow-400 text-black border-2 border-black disabled:opacity-30">{'\u25C4'}{position.previous ? ` #${position.previous.issue}` : ''}</button>
                        <span className="min-w-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
                            <span>{tree!.title} · {t('series.position', { issue: position.node.issue, total: position.path[position.path.length - 1].issue })}
                                {' · '}{t('series.page', { page: position.pagesBefore + Math.min(currentSheetIndex * 2 + 1, story.completedPages || 1), total: Math.max(position.pagesTotal, 1) })}</span>
                            {story.role === 'family' && <span className="text-xs font-sans border border-white px-1">{t('series.notYours')}</span>}
                            {position.versions.length > 1 && <button type="button" onClick={() => setChoosing('versions')}
                              className="px-2 bg-white text-black border-2 border-black">{t('series.versions', { count: position.versions.length })}</button>}
                        </span>
                        <button type="button" disabled={!position.next.length} onClick={nextIssue} aria-label={t('series.next')}
                          className="shrink-0 whitespace-nowrap px-2 bg-yellow-400 text-black border-2 border-black disabled:opacity-30">{position.next.length ? `#${position.next[0].issue} ` : ''}{'\u25BA'}</button>
                    </nav>
                )}
                {story && !statusHidden && (
                    <p role="status" className="pointer-events-auto flex items-center gap-3 font-comic text-lg text-white bg-black/70 pl-3 pr-1 py-1 border-2 border-yellow-400">
                        <span>{story.title} · {statusText}</span>
                        <button type="button" onClick={() => setStatusHidden(true)} aria-label={t('common.close')}
                          className="shrink-0 w-7 h-7 rounded-full bg-red-600 text-white border-2 border-black text-base leading-none flex items-center justify-center hover:scale-110">✕</button>
                    </p>
                )}
                {notice && <p role="status" className="pointer-events-auto text-sm bg-white border-2 border-black px-3 py-1">{notice} <button type="button" className="underline ml-1" onClick={() => setNotice('')}>{t('common.close')}</button></p>}
                {isOwner && story?.generation?.state === 'stopped' && (
                    <div className="pointer-events-auto flex flex-wrap justify-center gap-2 mt-2">
                        <button type="button" onClick={openInstructions} className="comic-btn btn-blue px-3 py-2 text-lg">{t('view.editInstructions')}</button>
                        <button type="button" onClick={retry} className="comic-btn btn-primary px-3 py-2 text-lg">{t('view.retry')}</button>
                    </div>
                )}
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
                onDownloadSeries={seriesIssues.length > 1 ? downloadSeries : undefined}
                downloadSeriesLabel={seriesPdf ? t('series.pdfProgress', seriesPdf) : t('panel.downloadSeries', { count: seriesIssues.length })}
                onReset={() => setShowCredits(true)}
                onShare={isOwner || story.role === 'guest' || auth.kind === 'reader' ? shareLink : undefined}
                onSaveCopy={!isOwner && onCopied && finished ? saveCopy : undefined}
                onContinue={isOwner && finished ? () => setContinuing(true) : undefined}
                onNextIssue={finished && onOpenIssue && position?.next.length ? nextIssue : undefined}
                nextIssueLabel={!position?.next.length ? undefined : position.next.length > 1
                    ? t('series.chooseNext', { issue: position.next[0].issue, count: position.next.length })
                    : tFor(story.settings.language, 'panel.readIssue', { issue: position.next[0].issue })}
                issue={story.series?.issue ?? story.continuation?.issue}
                soundEffects={story.soundEffects}
                comicLanguage={story.settings.language}
            />}
            {!story && !error && <p role="status" className="font-comic text-3xl text-white">{t('view.loading')}</p>}
            {story && !readOnly && <NotifyPrompt storyId={storyId} auth={auth} active={inProgress} />}
            {editing && (
                <div role="dialog" aria-modal="true" aria-labelledby="instructions-title" className="fixed inset-0 z-[700] bg-black/70 flex items-center justify-center p-4">
                    <form onSubmit={saveInstructions} className="bg-white border-4 border-black p-4 w-full max-w-lg flex flex-col gap-3">
                        <h2 id="instructions-title" className="font-comic text-2xl">{t('view.instructionsTitle')}</h2>
                        <p className="text-sm">{t('view.instructionsHint')}</p>
                        <textarea aria-label={t('view.instructionsLabel')} value={draft} onChange={event => setDraft(event.target.value)}
                            maxLength={2000} rows={6} autoFocus className="border-2 border-black p-2 w-full" />
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setEditing(false)} className="comic-btn btn-white px-3 py-2">{t('view.instructionsCancel')}</button>
                            <button type="submit" disabled={saving || (story?.settings.genre === 'Custom' && !draft.trim())} className="comic-btn btn-primary px-3 py-2">{t('view.instructionsSave')}</button>
                        </div>
                    </form>
                </div>
            )}
            {continuing && story && auth.kind === 'owner' && <ContinueStory source={story} ownerToken={auth.token} existingTitles={[]} onCancel={() => setContinuing(false)} onCreated={() => setContinuing(false)} />}
            {choosing && position && (
                <SeriesChooser
                    title={choosing === 'next' ? t('series.chooserNext', { issue: position.next[0]?.issue ?? position.node.issue + 1 }) : t('series.chooserVersions', { issue: position.node.issue })}
                    nodes={choosing === 'next' ? position.next : position.versions}
                    current={position.node}
                    isMine={holdsKey}
                    comicOf={comicOf}
                    authFor={authFor}
                    onPick={node => openIssue(node)}
                    onClose={() => setChoosing(null)}
                />
            )}
            {showCredits && <Credits onDone={onExit} />}
        </>
    );
}
