import React, { useEffect, useState } from 'react';
import {
    AdminAuthError, adminRequest, errorText, formatCost, formatDate, formatNumber, imageUrl, statusLabel,
    type AdminStoryList, type StoryStatus
} from './adminApi';
import { t } from './i18n';

const PAGE_SIZE = 20;

function Photo({ storyId, which, alt, deleted }: { storyId: string; which: string; alt: string; deleted: boolean }) {
    const [failed, setFailed] = useState(false);
    if (deleted || failed) return <span className="photo placeholder" aria-label={t('admin.unavailable', { label: alt })}>—</span>;
    return <img className="photo" src={imageUrl(storyId, which)} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

export function AdminStories({ onAuthLost }: { onAuthLost: () => void }) {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [status, setStatus] = useState<'all' | StoryStatus>('all');
    const [sort, setSort] = useState('createdAt');
    const [order, setOrder] = useState<'asc' | 'desc'>('desc');
    const [page, setPage] = useState(1);
    const [data, setData] = useState<AdminStoryList | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => { setDebouncedQuery(query.trim()); setPage(1); }, 300);
        return () => clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams({ query: debouncedQuery, status, sort, order, page: String(page), pageSize: String(PAGE_SIZE) });
        adminRequest<AdminStoryList>(`/stories?${params}`, { signal: controller.signal })
            .then(result => { setData(result); setError(''); })
            .catch(failure => {
                if (controller.signal.aborted) return;
                if (failure instanceof AdminAuthError) onAuthLost();
                else setError(errorText(failure));
            });
        return () => controller.abort();
    }, [debouncedQuery, status, sort, order, page, onAuthLost]);

    const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

    return (
        <>
            <h1>{t('admin.comics')}</h1>
            <form className="filters" role="search" onSubmit={event => event.preventDefault()}>
                <label>{t('admin.search')}
                    <input type="search" placeholder={t('admin.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
                </label>
                <label>{t('admin.statusLabel')}
                    <select value={status} onChange={event => { setStatus(event.target.value as 'all' | StoryStatus); setPage(1); }}>
                        <option value="all">{t('admin.all')}</option>
                        <option value="in_progress">{t('admin.status.inProgress')}</option>
                        <option value="complete">{t('admin.completeCount')}</option>
                        <option value="deleted">{t('admin.deletedCount')}</option>
                    </select>
                </label>
                <label>{t('admin.sortBy')}
                    <select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>
                        <option value="createdAt">{t('admin.sort.created')}</option>
                        <option value="updatedAt">{t('admin.sort.updated')}</option>
                        <option value="cost">{t('admin.cost')}</option>
                        <option value="title">{t('admin.sort.title')}</option>
                    </select>
                </label>
                <label>{t('admin.order')}
                    <select value={order} onChange={event => { setOrder(event.target.value as 'asc' | 'desc'); setPage(1); }}>
                        <option value="desc">{t('admin.desc')}</option>
                        <option value="asc">{t('admin.asc')}</option>
                    </select>
                </label>
            </form>
            {error && <p role="alert" className="error">{error}</p>}
            {!data && !error && <p role="status">{t('admin.loadingComics')}</p>}
            {data && (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">{t('admin.photos')}</th><th scope="col">{t('admin.comic')}</th><th scope="col">{t('admin.statusLabel')}</th>
                                <th scope="col">{t('admin.pages')}</th><th scope="col">{t('admin.calls')}</th><th scope="col">{t('admin.tokens')}</th>
                                <th scope="col">{t('admin.cost')}</th><th scope="col">{t('admin.shares')}</th><th scope="col">{t('admin.opens')}</th><th scope="col">{t('admin.created')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map(item => {
                                const deleted = item.status === 'deleted';
                                return (
                                    <tr key={item.id}>
                                        <td>
                                            <div className="photos">
                                                <Photo storyId={item.id} which="hero" alt={t('invite.photoOf', { name: item.hostName })} deleted={deleted} />
                                                {item.hasFriend && <Photo storyId={item.id} which="friend" alt={t('invite.photoOf', { name: item.guestName || t('cast.costar') })} deleted={deleted} />}
                                            </div>
                                        </td>
                                        <td>
                                            <a href={`#/story/${item.id}`}><strong>{item.title}</strong></a>
                                            <div className="muted small">{item.guestName ? t('pdf.castPair', { host: item.hostName, guest: item.guestName }) : item.hostName}</div>
                                        </td>
                                        <td><span className={`badge ${item.status}`}>{statusLabel(item.status)}</span></td>
                                        <td>{item.completedPages}/{item.totalPages}</td>
                                        <td>{formatNumber(item.usage.calls)}{item.usage.errors > 0 && <span className="muted small"> ({t('admin.errShort', { count: item.usage.errors })})</span>}</td>
                                        <td>{formatNumber(item.usage.tokens.total)}</td>
                                        <td>{formatCost(item.usage)}</td>
                                        <td>{formatNumber(item.shares)}</td>
                                        <td>{formatNumber(item.opens)}</td>
                                        <td>{formatDate(item.createdAt)}</td>
                                    </tr>
                                );
                            })}
                            {!data.items.length && <tr><td colSpan={8} className="muted">{t('admin.noMatches')}</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
            {data && pages > 1 && (
                <nav className="pager" aria-label={t('admin.pagination')}>
                    <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('admin.previous')}</button>
                    <span>{t('admin.pageOf', { page, pages, total: data.total })}</span>
                    <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('admin.next')}</button>
                </nav>
            )}
            <p className="muted"><a href="/api/admin/usage.csv" download>{t('admin.exportCsv')}</a></p>
        </>
    );
}
