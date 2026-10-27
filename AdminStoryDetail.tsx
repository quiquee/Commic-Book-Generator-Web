import React, { useEffect, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import { addSiteLink } from './pdfBranding';
import {
    AdminAuthError, adminRequest, errorText, formatCost, formatDate, formatNumber, formatUsd, imageUrl, statusLabel,
    type AdminFace, type AdminStoryDetail, type UsageTotals
} from './adminApi';
import { genreLabel } from './Setup';
import { t } from './i18n';

const faceLabel = (face: AdminFace) => face.type === 'cover' ? t('admin.cover') : face.type === 'back_cover' ? t('admin.backCover') : t('admin.page', { page: face.pageIndex });
const faceImage = (face: AdminFace) => face.id;

function UsageTable({ title, rows }: { title: string; rows: Record<string, UsageTotals> }) {
    const entries = Object.entries(rows);
    return (
        <table>
            <thead><tr><th scope="col">{title}</th><th scope="col">{t('admin.calls')}</th><th scope="col">{t('admin.errors')}</th><th scope="col">{t('admin.input')}</th><th scope="col">{t('admin.output')}</th><th scope="col">{t('admin.cost')}</th></tr></thead>
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
                {!entries.length && <tr><td colSpan={6} className="muted">{t('admin.noData')}</td></tr>}
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
            doc.setProperties({ title: story.title, subject: t('pdf.subject', { cast: story.guestName ? t('pdf.castPair', { host: story.hostName, guest: story.guestName }) : story.hostName }), author: story.hostName });
            let first = true;
            for (const face of story.faces.filter(item => item.hasImage)) {
                const blob = await (await fetch(imageUrl(story.id, faceImage(face)), { credentials: 'same-origin' })).blob();
                const data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = () => reject(new Error(t('admin.readPageFailed')));
                    reader.readAsDataURL(blob);
                });
                if (!first) doc.addPage([480, 720], 'portrait');
                doc.addImage(data, 'JPEG', 0, 0, 480, 720);
                addSiteLink(doc, face.type, 480, 720);
                first = false;
            }
            if (first) throw new Error(t('admin.noPagesForPdf'));
            doc.save(`${story.title.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.pdf`);
        } catch (failure) {
            setError(errorText(failure));
        } finally {
            setPdfBusy(false);
        }
    };

    if (error && !story) return <><p role="alert" className="error">{error}</p><a href="#/stories">{t('admin.backToList')}</a></>;
    if (!story) return <p role="status">{t('view.loading')}</p>;

    const deleted = story.status === 'deleted';
    const totals = story.usage.totals;

    return (
        <>
            <p><a href="#/stories">← {t('admin.comics')}</a></p>
            <h1>{story.title} <span className={`badge ${story.status}`}>{statusLabel(story.status)}</span></h1>
            {error && <p role="alert" className="error">{error}</p>}

            <section className="card cast" aria-label={t('admin.cast')}>
                <figure>
                    {deleted ? <span className="photo big placeholder">—</span> : <img className="photo big" src={imageUrl(story.id, 'hero')} alt={t('invite.photoOf', { name: story.hostName })} />}
                    <figcaption><strong>{story.hostName}</strong><br /><span className="muted small">{t('cast.protagonist')}</span></figcaption>
                </figure>
                {story.guestName && (
                    <figure>
                        {deleted ? <span className="photo big placeholder">—</span> : <img className="photo big" src={imageUrl(story.id, 'friend')} alt={t('invite.photoOf', { name: story.guestName })} />}
                        <figcaption><strong>{story.guestName}</strong><br /><span className="muted small">{t('cast.costar')}</span></figcaption>
                    </figure>
                )}
                <dl>
                    <dt>{t('admin.created')}</dt><dd>{formatDate(story.createdAt)}</dd>
                    {story.updatedAt !== undefined && <><dt>{t('admin.sort.updated')}</dt><dd>{formatDate(story.updatedAt)}</dd></>}
                    {story.deletedAt && <><dt>{t('admin.status.deleted')}</dt><dd>{formatDate(story.deletedAt)} ({story.deletedBy === 'admin' ? t('admin.byAdmin') : t('admin.byOwner')})</dd></>}
                    <dt>{t('admin.pages')}</dt><dd>{story.completedPages}/{story.totalPages}</dd>
                    <dt>{t('admin.shares')}</dt><dd>{formatNumber(story.shares ?? 0)}{story.lastSharedAt ? ` · ${formatDate(story.lastSharedAt)}` : ''}</dd>
                    <dt>{t('admin.opens')}</dt><dd>{formatNumber(story.opens ?? 0)}{story.lastOpenedAt ? ` · ${formatDate(story.lastOpenedAt)}` : ''}</dd>
                    {story.settings && <><dt>{t('story.genreLabel')}</dt><dd>{genreLabel(story.settings.genre)}</dd><dt>{t('admin.language')}</dt><dd>{story.settings.language}</dd></>}
                    {story.settings?.premise && <><dt>{t('admin.premise')}</dt><dd>{story.settings.premise}</dd></>}
                    {story.tone && <><dt>{t('admin.tone')}</dt><dd>{story.tone}</dd></>}
                </dl>
            </section>

            <section className="card" aria-label={t('admin.usage')}>
                <h2>{t('admin.usageEstimated')}</h2>
                <div className="stats">
                    <div className="stat"><span className="stat-label">{t('admin.cost')}</span><span className="stat-value">{formatCost(totals)}</span></div>
                    <div className="stat"><span className="stat-label">{t('admin.calls')}</span><span className="stat-value">{formatNumber(totals.calls)}</span><span className="muted small">{t('admin.withError', { count: totals.errors })}</span></div>
                    <div className="stat"><span className="stat-label">{t('admin.inputTokens')}</span><span className="stat-value">{formatNumber(totals.tokens.inputText + totals.tokens.inputImage)}</span></div>
                    <div className="stat"><span className="stat-label">{t('admin.outputTokens')}</span><span className="stat-value">{formatNumber(totals.tokens.outputText + totals.tokens.outputImage)}</span><span className="muted small">{t('admin.ofImage', { count: formatNumber(totals.tokens.outputImage) })}</span></div>
                </div>
                <h3>{t('admin.byOperation')}</h3>
                <UsageTable title={t('admin.operation')} rows={story.usage.byOperation} />
                <h3>{t('admin.byModel')}</h3>
                <UsageTable title={t('admin.model')} rows={story.usage.byModel} />
                <details>
                    <summary>{t('admin.lastCalls', { count: story.usage.events.length })}</summary>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th scope="col">{t('admin.date')}</th><th scope="col">{t('admin.operation')}</th><th scope="col">{t('admin.model')}</th><th scope="col">{t('admin.statusLabel')}</th><th scope="col">{t('admin.tokens')}</th><th scope="col">{t('admin.cost')}</th><th scope="col">{t('admin.latency')}</th></tr></thead>
                            <tbody>
                                {[...story.usage.events].reverse().map((event, index) => (
                                    <tr key={`${event.ts}-${index}`}>
                                        <td>{formatDate(event.ts)}</td>
                                        <td>{event.op}</td>
                                        <td>{event.model}</td>
                                        <td>{event.ok ? 'OK' : t('admin.errorStatus', { status: event.httpStatus })}</td>
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
                <section className="card" aria-label={t('admin.pages')}>
                    <div className="row">
                        <h2>{t('admin.pages')}</h2>
                        <button type="button" onClick={downloadPdf} disabled={pdfBusy || !story.faces.some(face => face.hasImage)}>{pdfBusy ? t('admin.generatingPdf') : t('view.downloadPdf')}</button>
                    </div>
                    <ul className="gallery">
                        {story.faces.map(face => (
                            <li key={face.id}>
                                {face.hasImage ? (
                                    <button type="button" className="thumb" onClick={() => setLightbox(face)} aria-label={t('admin.enlarge', { label: faceLabel(face) })}>
                                        <img src={imageUrl(story.id, faceImage(face))} alt={faceLabel(face)} loading="lazy" />
                                    </button>
                                ) : <span className="thumb placeholder">{face.isLoading ? t('admin.drawing') : t('admin.noImage')}</span>}
                                <span className="small">{faceLabel(face)}</span>
                                {face.resolvedChoice && <span className="muted small">{t('admin.decision', { choice: face.resolvedChoice })}</span>}
                            </li>
                        ))}
                    </ul>
                    {story.styleGuide && <details><summary>{t('admin.styleGuide')}</summary><pre>{story.styleGuide}</pre></details>}
                </section>
            )}

            {!deleted && (
                <section className="card danger" aria-label={t('admin.deleteComic')}>
                    <h2>{t('admin.deleteComic')}</h2>
                    <p>{t('admin.deleteHint')} <strong>{story.title}</strong></p>
                    <div className="row">
                        <input aria-label={t('admin.deleteConfirmLabel')} value={confirmTitle} onChange={event => setConfirmTitle(event.target.value)} />
                        <button type="button" className="destructive" disabled={deleting || confirmTitle !== story.title} onClick={remove}>{deleting ? t('admin.deleting') : t('admin.deleteForever')}</button>
                    </div>
                </section>
            )}

            <dialog ref={dialogRef} className="lightbox" onClose={() => setLightbox(null)} onClick={event => { if (event.target === dialogRef.current) setLightbox(null); }}>
                {lightbox && (
                    <>
                        <img src={imageUrl(story.id, faceImage(lightbox))} alt={faceLabel(lightbox)} />
                        {lightbox.narrative && <p className="small">{lightbox.narrative.caption} {lightbox.narrative.dialogue && `— «${lightbox.narrative.dialogue}»`}</p>}
                        <div className="row">
                            <a href={imageUrl(story.id, faceImage(lightbox))} download={`${faceLabel(lightbox)}.jpg`}>{t('admin.downloadImage')}</a>
                            <button type="button" className="secondary" onClick={() => setLightbox(null)}>{t('common.close')}</button>
                        </div>
                    </>
                )}
            </dialog>
        </>
    );
}
