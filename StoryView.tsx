import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import { Book } from './Book';
import { DECISION_PAGES, TOTAL_PAGES, type Beat, type ComicFace, type Persona } from './types';
import { errorMessage } from './invitations';
import {
    compressImage, deleteStory, fetchStory, fetchStoryDelta, loadStoryKeys, patchStory, saveFace, saveStoryKeys, submitChoice,
    type StoryAuth, type StoryDocument
} from './stories';
import { faceId, faceType, findFace, isStoryFinished, mergeFaces, nextPageToGenerate, pendingDecision, previousImage, upsertFace } from './storyLogic';
import { createAI, generateBeat, generateImage, generatePersona, generateStyleGuide, isApiKeyError, type StoryContext } from './generation';

interface StoryViewProps {
    storyId: string;
    auth: StoryAuth;
    onExit: () => void;
    onApiKeyError: () => void;
}

type GeneratorStatus =
    | { kind: 'idle' }
    | { kind: 'styling' }
    | { kind: 'generating'; pageIndex: number }
    | { kind: 'waiting' }
    | { kind: 'finished' }
    | { kind: 'stopped'; reason: string };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelado', 'AbortError')); }, { once: true });
});

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function StoryView({ storyId, auth, onExit, onApiKeyError }: StoryViewProps) {
    const [story, setStory] = useState<StoryDocument | null>(null);
    const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [status, setStatus] = useState<GeneratorStatus>({ kind: 'idle' });
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [generatorRun, setGeneratorRun] = useState(0);
    const storyRef = useRef<StoryDocument | null>(null);
    const versionRef = useRef(0);
    const persistQueue = useRef<Promise<unknown>>(Promise.resolve());

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
                    completedPages: delta.completedPages, updatedAt: delta.updatedAt,
                    faces: mergeFaces(current.faces, delta.faces, isOwner ? 'owner' : 'guest')
                }));
            } catch (failure) {
                if (controller.signal.aborted) return;
                if ((failure as { status?: number }).status === 404) {
                    setError('Este cómic ya no existe. La protagonista lo ha borrado.');
                    return;
                }
                setNotice(`Sin conexión con el servidor: ${errorMessage(failure)}`);
            }
            if (!controller.signal.aborted) timer = setTimeout(tick, 3000);
        };
        timer = setTimeout(tick, 3000);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [story?.id, storyId, auth, isOwner, updateStory]);

    const persist = useCallback((face: ComicFace) => {
        const attempt = async () => {
            for (let retry = 0; ; retry++) {
                try {
                    const result = await saveFace(storyId, auth, face);
                    versionRef.current = Math.max(versionRef.current, result.version);
                    return;
                } catch (failure) {
                    if (retry >= 2) throw failure;
                    await new Promise(resolve => setTimeout(resolve, 1500 * (retry + 1)));
                }
            }
        };
        const run = persistQueue.current.then(attempt);
        persistQueue.current = run.catch(() => {});
        return run;
    }, [storyId, auth]);

    useEffect(() => {
        if (!story || !isOwner) return;
        const controller = new AbortController();
        const signal = controller.signal;
        const context = (): StoryContext => {
            const current = storyRef.current!;
            return { hero: current.hero, friend: current.friend, hostName: current.hostName, guestName: current.guestName, settings: current.settings, tone: current.tone, styleGuide: current.styleGuide };
        };
        const ensureNotCancelled = () => { if (signal.aborted) throw new DOMException('Cancelado', 'AbortError'); };

        const toJpegPersona = async (persona: Persona): Promise<Persona> => {
            const dataUrl = await compressImage(`data:image/png;base64,${persona.base64}`, 768, 0.85);
            return { base64: dataUrl.split(',')[1], desc: persona.desc };
        };

        const generatePage = async (ai: ReturnType<typeof createAI>, pageIndex: number) => {
            const id = faceId(pageIndex);
            const type = faceType(pageIndex);
            const isDecision = DECISION_PAGES.includes(pageIndex);
            const existing = findFace(storyRef.current!.faces, pageIndex);
            let face: ComicFace = { id, type, pageIndex, isLoading: true, isDecisionPage: isDecision, choices: [], resolvedChoice: existing?.resolvedChoice };
            applyFace(face);
            await persist(face);
            ensureNotCancelled();

            let beat: Beat = { scene: 'Thematic teaser image', choices: [], focus_char: 'other' };
            if (type === 'story') {
                beat = await generateBeat(ai, context(), storyRef.current!.faces, pageIndex, isDecision);
                ensureNotCancelled();
                if (beat.focus_char === 'friend' && !storyRef.current!.friend) {
                    try {
                        const name = storyRef.current!.guestName || (storyRef.current!.settings.genre === 'Custom' ? 'A fitting sidekick for this story' : `Sidekick for ${storyRef.current!.settings.genre} story.`);
                        const persona = await toJpegPersona(await generatePersona(ai, context(), name));
                        ensureNotCancelled();
                        await patchStory(storyId, auth, { friend: persona });
                        updateStory(current => ({ ...current, friend: persona }));
                    } catch (failure) {
                        if (isAbort(failure)) throw failure;
                        beat.focus_char = 'other';
                    }
                }
                face = { ...face, narrative: beat, choices: beat.choices };
                applyFace(face);
                await persist(face);
                ensureNotCancelled();
            }

            const rawImage = await generateImage(ai, context(), beat, type, previousImage(storyRef.current!.faces, pageIndex));
            ensureNotCancelled();
            const imageUrl = await compressImage(rawImage);
            face = { ...face, imageUrl, isLoading: false };
            applyFace(face);
            await persist(face);
        };

        (async () => {
            const ai = createAI();
            let failures = 0;
            while (!signal.aborted) {
                try {
                    if (!storyRef.current!.styleGuide) {
                        setStatus({ kind: 'styling' });
                        const styleGuide = await generateStyleGuide(ai, context());
                        ensureNotCancelled();
                        await patchStory(storyId, auth, { styleGuide });
                        updateStory(current => ({ ...current, styleGuide }));
                    }
                    const next = nextPageToGenerate(storyRef.current!.faces);
                    if (next === null) {
                        if (isStoryFinished(storyRef.current!.faces)) { setStatus({ kind: 'finished' }); return; }
                        setStatus({ kind: 'waiting' });
                        await sleep(2000, signal);
                        continue;
                    }
                    setStatus({ kind: 'generating', pageIndex: next });
                    await generatePage(ai, next);
                    failures = 0;
                    setError('');
                } catch (failure) {
                    if (isAbort(failure) || signal.aborted) return;
                    failures++;
                    if (isApiKeyError(failure)) {
                        setStatus({ kind: 'stopped', reason: 'Se necesita una clave de API válida.' });
                        onApiKeyError();
                        return;
                    }
                    if (failures >= 5) {
                        setStatus({ kind: 'stopped', reason: errorMessage(failure) });
                        return;
                    }
                    setError(`Error al generar: ${errorMessage(failure)}. Reintentando (${failures}/5)...`);
                    try { await sleep(3000 * failures, signal); } catch { return; }
                }
            }
        })();
        return () => controller.abort();
    }, [story?.id, isOwner, generatorRun, storyId, auth, applyFace, persist, updateStory, onApiKeyError]);

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
                setNotice(`Otra persona decidió antes: «${resolved}».`);
            } else {
                applyFace(face);
                setError(`No se pudo registrar la decisión: ${errorMessage(failure)}`);
            }
        }
    };

    const downloadPDF = () => {
        if (!story) return;
        const pages = story.faces.filter(face => face.imageUrl && !face.isLoading).sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
        if (!pages.length) return;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [480, 720] });
        pages.forEach((face, index) => {
            if (index > 0) doc.addPage([480, 720], 'portrait');
            doc.addImage(face.imageUrl!, 'JPEG', 0, 0, 480, 720);
        });
        doc.save(`${story.title.replace(/[^\p{L}\p{N}]+/gu, '-')}.pdf`);
    };

    const sharePage = async (face: ComicFace) => {
        if (!face.imageUrl || !story) return;
        const label = face.type === 'cover' ? 'portada' : face.type === 'back_cover' ? 'contraportada' : `pagina-${face.pageIndex}`;
        try {
            const blob = await (await fetch(face.imageUrl)).blob();
            const file = new File([blob], `${label}.jpg`, { type: 'image/jpeg' });
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
            setNotice('Este navegador no permite compartir directamente; la página se ha descargado.');
        } catch (failure) {
            if (!isAbort(failure)) setError(`No se pudo compartir la página: ${errorMessage(failure)}`);
        }
    };

    const remove = async () => {
        try {
            await deleteStory(storyId, auth);
            saveStoryKeys(loadStoryKeys().filter(key => key.id !== storyId));
            onExit();
        } catch (failure) {
            setError(`No se pudo borrar el cómic: ${errorMessage(failure)}`);
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
        if (!isOwner) {
            const decision = pendingDecision(story.faces);
            if (decision) return `Página ${decision.pageIndex}: ¡hay una decisión pendiente!`;
            if (isStoryFinished(story.faces)) return 'Cómic completo';
            return `${story.hostName} está dibujando... ${story.completedPages}/${TOTAL_PAGES + 1} páginas listas`;
        }
        switch (status.kind) {
            case 'styling': return 'Definiendo el aspecto de los personajes...';
            case 'generating': return status.pageIndex === 0 ? 'Dibujando la portada...' : status.pageIndex === TOTAL_PAGES ? 'Dibujando la contraportada...' : `Dibujando la página ${status.pageIndex} de ${TOTAL_PAGES - 1}...`;
            case 'waiting': return 'Esperando una decisión para continuar la historia';
            case 'finished': return 'Cómic completo';
            case 'stopped': return `Generación detenida: ${status.reason}`;
            default: return 'Cargando...';
        }
    })();

    const hasPages = !!story?.faces.some(face => face.imageUrl);

    return (
        <>
            <div className="fixed top-2 right-2 z-[500] flex flex-wrap justify-end gap-2 max-w-[70vw]">
                <button type="button" onClick={downloadPDF} disabled={!hasPages} className="comic-btn bg-blue-500 text-white px-3 py-2 text-lg disabled:bg-gray-400">Descargar PDF</button>
                {isOwner && !confirmDelete && <button type="button" onClick={() => setConfirmDelete(true)} className="comic-btn bg-red-600 text-white px-3 py-2 text-lg">Borrar cómic</button>}
                {isOwner && confirmDelete && <>
                    <button type="button" onClick={remove} className="comic-btn bg-red-700 text-white px-3 py-2 text-lg">Confirmar borrado</button>
                    <button type="button" onClick={() => setConfirmDelete(false)} className="comic-btn bg-gray-200 px-3 py-2 text-lg">Cancelar</button>
                </>}
                {isOwner && status.kind === 'stopped' && <button type="button" onClick={() => { setError(''); setGeneratorRun(run => run + 1); }} className="comic-btn bg-yellow-400 px-3 py-2 text-lg">Reintentar</button>}
            </div>
            <div className="fixed top-16 inset-x-0 z-[450] flex flex-col items-center gap-1 pointer-events-none px-4">
                {story && <p role="status" className="font-comic text-lg text-white bg-black/70 px-3 py-1 border-2 border-yellow-400">{story.title} · {statusText}</p>}
                {notice && <p role="status" className="pointer-events-auto text-sm bg-white border-2 border-black px-3 py-1">{notice} <button type="button" className="underline ml-1" onClick={() => setNotice('')}>Cerrar</button></p>}
                {error && <p role="alert" className="pointer-events-auto text-sm bg-white border-2 border-red-800 text-red-800 px-3 py-1">{error} <button type="button" className="underline ml-1" onClick={() => setError('')}>Cerrar</button></p>}
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
            {!story && !error && <p role="status" className="font-comic text-3xl text-white">Cargando cómic...</p>}
        </>
    );
}
