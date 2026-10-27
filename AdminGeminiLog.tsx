import React, { useCallback, useEffect, useState } from 'react';
import { AdminAuthError, adminRequest, errorText, formatNumber, type GeminiLogEntry } from './adminApi';
import { t } from './i18n';

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });

function Result({ entry }: { entry: GeminiLogEntry }) {
    if (entry.blockReason) return <span className="badge deleted">{t('admin.log.blocked', { reason: entry.blockReason })}</span>;
    if (!entry.ok) return <span className="badge deleted">{t('admin.log.failed', { status: entry.httpStatus })}</span>;
    return <span className="badge complete">{t('admin.log.ok')}</span>;
}

export function AdminGeminiLog({ onAuthLost }: { onAuthLost: () => void }) {
    const [failedOnly, setFailedOnly] = useState(true);
    const [data, setData] = useState<{ enabled: boolean; items: GeminiLogEntry[] } | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(() => {
        const controller = new AbortController();
        adminRequest<{ enabled: boolean; items: GeminiLogEntry[] }>(
            `/gemini-log?limit=200&failed=${failedOnly ? 1 : 0}`, { signal: controller.signal })
            .then(result => { setData(result); setError(''); })
            .catch(failure => {
                if (controller.signal.aborted) return;
                if (failure instanceof AdminAuthError) onAuthLost();
                else setError(errorText(failure));
            });
        return () => controller.abort();
    }, [failedOnly, onAuthLost]);

    useEffect(() => load(), [load]);

    return (
        <section>
            <h1>{t('admin.geminiLog')}</h1>
            <p className="muted">{t('admin.log.hint')}</p>
            <p>
                <label><input type="checkbox" checked={failedOnly} onChange={event => setFailedOnly(event.target.checked)} /> {t('admin.log.onlyFailed')}</label>
                {' '}<button type="button" className="secondary" onClick={load}>{t('admin.log.refresh')}</button>
            </p>
            {error && <p role="alert" className="error">{error}</p>}
            {data && !data.enabled && <p className="muted">{t('admin.log.disabled')}</p>}
            {!data && !error && <p role="status">{t('common.loading')}</p>}
            {data?.enabled && (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>{t('admin.log.time')}</th><th>{t('admin.log.comic')}</th><th>{t('admin.log.operation')}</th>
                                <th>{t('admin.log.model')}</th><th>{t('admin.log.result')}</th><th>{t('admin.log.latency')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map((entry, index) => (
                                <React.Fragment key={`${entry.ts}-${index}`}>
                                    <tr>
                                        <td>{timeFormat.format(new Date(entry.ts))}</td>
                                        <td>{entry.scope === 'story'
                                            ? <a href={`#/story/${encodeURIComponent(entry.scopeId)}`}>{entry.scopeId.slice(0, 8)}</a>
                                            : `${t('admin.log.draft')} ${entry.scopeId.slice(0, 8)}`}</td>
                                        <td>{entry.op}</td>
                                        <td>{entry.model}</td>
                                        <td><Result entry={entry} /></td>
                                        <td>{formatNumber(entry.latencyMs)} ms</td>
                                    </tr>
                                    <tr>
                                        <td colSpan={6}>
                                            <details>
                                                <summary>{t('admin.log.details')}{entry.finishReason ? ` · ${entry.finishReason}` : ''}</summary>
                                                {entry.error && <p><strong>{t('admin.log.error')}:</strong> {[entry.error.status, entry.error.message, entry.error.detail].filter(Boolean).join(' — ')}</p>}
                                                {(entry.safetyRatings || entry.promptSafetyRatings) && (
                                                    <p><strong>{t('admin.log.ratings')}:</strong> {[...(entry.promptSafetyRatings ?? []), ...(entry.safetyRatings ?? [])]
                                                        .map(rating => `${rating.category.replace('HARM_CATEGORY_', '')}=${rating.probability ?? '?'}${rating.blocked ? '!' : ''}`).join(', ')}</p>
                                                )}
                                                <p><strong>{t('admin.log.prompt', { images: entry.prompt.images })}:</strong></p>
                                                <pre style={{ whiteSpace: 'pre-wrap' }}>{entry.prompt.text}</pre>
                                                {entry.reply && <><p><strong>{t('admin.log.reply')}:</strong></p><pre style={{ whiteSpace: 'pre-wrap' }}>{entry.reply}</pre></>}
                                            </details>
                                        </td>
                                    </tr>
                                </React.Fragment>
                            ))}
                            {!data.items.length && <tr><td colSpan={6} className="muted">{t('admin.noData')}</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
