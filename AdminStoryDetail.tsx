import React, { useEffect, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import {
    AdminAuthError, adminRequest, errorText, formatCost, formatDate, formatNumber, formatUsd, imageUrl, statusLabel,
    type AdminFace, type AdminStoryDetail, type UsageTotals
} from './adminApi';

const faceLabel = (face: AdminFace) => face.type === 'cover' ? 'Portada' : face.type === 'back_cover' ? 'Contraportada' : `Página ${face.pageIndex}`;
const faceImage = (face: AdminFace) => face.id;

function UsageTable({ title, rows }: { title: string; rows: Record<string, UsageTotals> }) {
    const entries = Object.entries(rows);
    return (
        <table>
            <thead><tr><th scope="col">{title}</th><th scope="col">Llamadas</th><th scope="col">Errores</th><th scope="col">Entrada</th><th scope="col">Salida</th><th scope="col">Coste</th></tr></thead>
            <tbody>
                {entries.map(([key, totals]) => (
                    <tr key={key}>
                        <th scope="row">{key}</th>
                        <td>{formatNumber(totals.calls)}</td>
                        <td>{formatNumber(totals.errors)}</td>
                        <td>{formatNumber(totals.tokens.inputText + totals.tokens.inputImage)}</td>
                        <td>{formatNumber(totals.tokens.outputText + totals.tokens.outputImage)}</td>
                        <td>{formatCost(totals)}</td>
                    </tr>
                ))}
                {!entries.length && <tr><td colSpan={6} className="muted">Sin datos.</td></tr>}
            </tbody>
        </table>
    );
}

export function AdminStoryDetailView({ id, onAuthLost }: { id: string; onAuthLost: () => void }) {
    const [story, setStory] = useState<AdminStoryDetail | null>(null);
    const [error, setError] = useState('');
    const [lightbox, setLightbox] = useState<AdminFace | null>(null);
    const [confirmTitle, setConfirmTitle] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [pdfBusy, setPdfBusy] = useState(false);
    const dialogRef = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const controller = new AbortController();
        adminRequest<AdminStoryDetail>(`/stories/${encodeURIComponent(id)}`, { signal: controller.signal })
            .then(setStory)
            .catch(failure => {
                if (controller.signal.aborted) return;
                if (failure instanceof AdminAuthError) onAuthLost();
                else setError(errorText(failure));
            });
        return () => controller.abort();
    }, [id, onAuthLost]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (lightbox && !dialog.open) dialog.showModal();
        if (!lightbox && dialog.open) dialog.close();
    }, [lightbox]);

    const remove = async () => {
        if (!story) return;
        setDeleting(true);
        setError('');
        try {
            await adminRequest(`/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' });
            window.location.hash = '#/stories';
        } catch (failure) {
            if (failure instanceof AdminAuthError) onAuthLost();
            else setError(errorText(failure));
            setDeleting(false);
        }
    };

    const downloadPdf = async () => {
        if (!story) return;
        setPdfBusy(true);
        setError('');
        try {
            const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [480, 720] });
            doc.setProperties({ title: story.title, subject: `Cómic de ${story.hostName}${story.guestName ? ` y ${story.guestName}` : ''}`, author: story.hostName });
            let first = true;
            for (const face of story.faces.filter(item => item.hasImage)) {
                const blob = await (await fetch(imageUrl(story.id, faceImage(face)), { credentials: 'same-origin' })).blob();
                const data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = () => reject(new Error('No se pudo leer una página.'));
                    reader.readAsDataURL(blob);
                });
                if (!first) doc.addPage([480, 720], 'portrait');
                doc.addImage(data, 'JPEG', 0, 0, 480, 720);
                first = false;
            }
            if (first) throw new Error('No hay páginas dibujadas para el PDF.');
            doc.save(`${story.title.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.pdf`);
        } catch (failure) {
            setError(errorText(failure));
        } finally {
            setPdfBusy(false);
        }
    };

    if (error && !story) return <><p role="alert" className="error">{error}</p><a href="#/stories">Volver a la lista</a></>;
    if (!story) return <p role="status">Cargando cómic...</p>;

    const deleted = story.status === 'deleted';
    const totals = story.usage.totals;

    return (
        <>
            <p><a href="#/stories">← Cómics</a></p>
            <h1>{story.title} <span className={`badge ${story.status}`}>{statusLabel[story.status]}</span></h1>
            {error && <p role="alert" className="error">{error}</p>}

            <section className="card cast" aria-label="Personajes">
                <figure>
                    {deleted ? <span className="photo big placeholder">—</span> : <img className="photo big" src={imageUrl(story.id, 'hero')} alt={`Foto de ${story.hostName}`} />}
                    <figcaption><strong>{story.hostName}</strong><br /><span className="muted small">Protagonista</span></figcaption>
                </figure>
                {story.guestName && (
                    <figure>
                        {deleted ? <span className="photo big placeholder">—</span> : <img className="photo big" src={imageUrl(story.id, 'friend')} alt={`Foto de ${story.guestName}`} />}
                        <figcaption><strong>{story.guestName}</strong><br /><span className="muted small">Coprotagonista</span></figcaption>
                    </figure>
                )}
                <dl>
                    <dt>Creado</dt><dd>{formatDate(story.createdAt)}</dd>
                    {story.updatedAt !== undefined && <><dt>Última actividad</dt><dd>{formatDate(story.updatedAt)}</dd></>}
                    {story.deletedAt && <><dt>Borrado</dt><dd>{formatDate(story.deletedAt)} ({story.deletedBy === 'admin' ? 'administración' : 'protagonista'})</dd></>}
                    <dt>Páginas</dt><dd>{story.completedPages}/{story.totalPages}</dd>
                    {story.settings && <><dt>Género</dt><dd>{story.settings.genre}</dd><dt>Idioma</dt><dd>{story.settings.language}</dd></>}
                    {story.settings?.premise && <><dt>Premisa</dt><dd>{story.settings.premise}</dd></>}
                    {story.tone && <><dt>Tono</dt><dd>{story.tone}</dd></>}
                </dl>
            </section>

            <section className="card" aria-label="Consumo">
                <h2>Consumo (estimado)</h2>
                <div className="stats">
                    <div className="stat"><span className="stat-label">Coste</span><span className="stat-value">{formatCost(totals)}</span></div>
                    <div className="stat"><span className="stat-label">Llamadas</span><span className="stat-value">{formatNumber(totals.calls)}</span><span className="muted small">{totals.errors} con error</span></div>
                    <div className="stat"><span className="stat-label">Tokens de entrada</span><span className="stat-value">{formatNumber(totals.tokens.inputText + totals.tokens.inputImage)}</span></div>
                    <div className="stat"><span className="stat-label">Tokens de salida</span><span className="stat-value">{formatNumber(totals.tokens.outputText + totals.tokens.outputImage)}</span><span className="muted small">{formatNumber(totals.tokens.outputImage)} de imagen</span></div>
                </div>
                <h3>Por operación</h3>
                <UsageTable title="Operación" rows={story.usage.byOperation} />
                <h3>Por modelo</h3>
                <UsageTable title="Modelo" rows={story.usage.byModel} />
                <details>
                    <summary>Últimas llamadas ({story.usage.events.length})</summary>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th scope="col">Fecha</th><th scope="col">Operación</th><th scope="col">Modelo</th><th scope="col">Estado</th><th scope="col">Tokens</th><th scope="col">Coste</th><th scope="col">Latencia</th></tr></thead>
                            <tbody>
                                {[...story.usage.events].reverse().map((event, index) => (
                                    <tr key={`${event.ts}-${index}`}>
                                        <td>{formatDate(event.ts)}</td>
                                        <td>{event.op}</td>
                                        <td>{event.model}</td>
                                        <td>{event.ok ? 'OK' : `Error ${event.httpStatus}`}</td>
                                        <td>{formatNumber(event.tokens.total)}</td>
                                        <td>{formatUsd(event.costUsd)}</td>
                                        <td>{(event.latencyMs / 1000).toFixed(1)} s</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </details>
            </section>

            {!deleted && (
                <section className="card" aria-label="Páginas">
                    <div className="row">
                        <h2>Páginas</h2>
                        <button type="button" onClick={downloadPdf} disabled={pdfBusy || !story.faces.some(face => face.hasImage)}>{pdfBusy ? 'Generando PDF...' : 'Descargar PDF'}</button>
                    </div>
                    <ul className="gallery">
                        {story.faces.map(face => (
                            <li key={face.id}>
                                {face.hasImage ? (
                                    <button type="button" className="thumb" onClick={() => setLightbox(face)} aria-label={`Ampliar ${faceLabel(face)}`}>
                                        <img src={imageUrl(story.id, faceImage(face))} alt={faceLabel(face)} loading="lazy" />
                                    </button>
                                ) : <span className="thumb placeholder">{face.isLoading ? 'Dibujando...' : 'Sin imagen'}</span>}
                                <span className="small">{faceLabel(face)}</span>
                                {face.resolvedChoice && <span className="muted small">Decisión: {face.resolvedChoice}</span>}
                            </li>
                        ))}
                    </ul>
                    {story.styleGuide && <details><summary>Guía de personajes</summary><pre>{story.styleGuide}</pre></details>}
                </section>
            )}

            {!deleted && (
                <section className="card danger" aria-label="Borrar cómic">
                    <h2>Borrar cómic</h2>
                    <p>Se eliminan las fotos y las páginas. El registro de consumo se conserva. Para confirmar, escribe el título: <strong>{story.title}</strong></p>
                    <div className="row">
                        <input aria-label="Título para confirmar el borrado" value={confirmTitle} onChange={event => setConfirmTitle(event.target.value)} />
                        <button type="button" className="destructive" disabled={deleting || confirmTitle !== story.title} onClick={remove}>{deleting ? 'Borrando...' : 'Borrar definitivamente'}</button>
                    </div>
                </section>
            )}

            <dialog ref={dialogRef} className="lightbox" onClose={() => setLightbox(null)} onClick={event => { if (event.target === dialogRef.current) setLightbox(null); }}>
                {lightbox && (
                    <>
                        <img src={imageUrl(story.id, faceImage(lightbox))} alt={faceLabel(lightbox)} />
                        {lightbox.narrative && <p className="small">{lightbox.narrative.caption} {lightbox.narrative.dialogue && `— «${lightbox.narrative.dialogue}»`}</p>}
                        <div className="row">
                            <a href={imageUrl(story.id, faceImage(lightbox))} download={`${faceLabel(lightbox)}.jpg`}>Descargar imagen</a>
                            <button type="button" className="secondary" onClick={() => setLightbox(null)}>Cerrar</button>
                        </div>
                    </>
                )}
            </dialog>
        </>
    );
}
