import React, { useEffect, useState } from 'react';
import {
    AdminAuthError, adminRequest, errorText, formatCost, formatDate, formatNumber, imageUrl, statusLabel,
    type AdminSeriesDetail, type AdminSeriesList, type AdminSeriesNode
} from './adminApi';
import { t } from './i18n';

const PAGE_SIZE = 20;

function Cover({ storyId, alt }: { storyId?: string; alt: string }) {
    const [failed, setFailed] = useState(false);
    if (!storyId || failed) return <span className="cover placeholder" aria-label={t('admin.unavailable', { label: alt })}>—</span>;
    return <img className="cover" src={imageUrl(storyId, 'cover')} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

// One row per series: how many issues it has, how it branched and what it cost.
export function AdminSeriesList({ onAuthLost }: { onAuthLost: () => void }) {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [sort, setSort] = useState('updatedAt');
    const [order, setOrder] = useState<'asc' | 'desc'>('desc');
    const [page, setPage] = useState(1);
    const [data, setData] = useState<AdminSeriesList | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => { setDebouncedQuery(query.trim()); setPage(1); }, 300);
        return () => clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        const controller = new AbortController();
        const params = new URLSearchParams({ query: debouncedQuery, sort, order, page: String(page), pageSize: String(PAGE_SIZE) });
        adminRequest<AdminSeriesList>(`/series?${params}`, { signal: controller.signal })
            .then(result => { setData(result); setError(''); })
            .catch(failure => {
                if (controller.signal.aborted) return;
                if (failure instanceof AdminAuthError) onAuthLost();
                else setError(errorText(failure));
            });
        return () => controller.abort();
    }, [debouncedQuery, sort, order, page, onAuthLost]);

    const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

    return (
        <>
            <h1>{t('admin.series')}</h1>
            <p className="muted">{t('admin.seriesHint')}</p>
            <form className="filters" role="search" onSubmit={event => event.preventDefault()}>
                <label>{t('admin.search')}
                    <input type="search" placeholder={t('admin.seriesSearchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
                </label>
                <label>{t('admin.sortBy')}
                    <select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>
                        <option value="updatedAt">{t('admin.sort.updated')}</option>
                        <option value="createdAt">{t('admin.sort.created')}</option>
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
            {!data && !error && <p role="status">{t('admin.loadingSeries')}</p>}
            {data && (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">{t('admin.cover')}</th><th scope="col">{t('admin.series')}</th><th scope="col">{t('admin.issues')}</th>
                                <th scope="col">{t('admin.versions')}</th><th scope="col">{t('admin.comics')}</th><th scope="col">{t('admin.pages')}</th>
                                <th scope="col">{t('admin.owners')}</th><th scope="col">{t('admin.cost')}</th><th scope="col">{t('admin.sort.updated')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map(item => (
                                <tr key={item.id}>
                                    <td><Cover storyId={item.coverId} alt={t('admin.coverOf', { title: item.title })} /></td>
                                    <td>
                                        <a href={`#/series/${encodeURIComponent(item.id)}`}><strong>{item.title}</strong></a>
                                        <div className="muted small">{item.cast.join(', ')}</div>
                                    </td>
                                    <td>{formatNumber(item.issues)}</td>
                                    <td>{item.versions > 0 ? formatNumber(item.versions) : <span className="muted">—</span>}</td>
                                    <td>{formatNumber(item.comics)}{item.complete < item.comics && <span className="muted small"> ({t('admin.unfinished', { count: item.comics - item.complete })})</span>}</td>
                                    <td>{formatNumber(item.pages)}</td>
                                    <td className="small">{item.owners.join(', ') || '—'}</td>
                                    <td>{formatCost(item.usage)}</td>
                                    <td>{formatDate(item.updatedAt)}</td>
                                </tr>
                            ))}
                            {!data.items.length && <tr><td colSpan={9} className="muted">{t('admin.noSeries')}</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
            {data && pages > 1 && (
                <nav className="pager" aria-label={t('admin.pagination')}>
                    <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('admin.previous')}</button>
                    <span>{t('admin.seriesPageOf', { page, pages, total: data.total })}</span>
                    <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('admin.next')}</button>
                </nav>
            )}
        </>
    );
}

// The issues of a series in reading order: each issue under the one it continues, with the comics that hold it.
export function AdminSeriesDetailView({ id, onAuthLost }: { id: string; onAuthLost: () => void }) {
    const [series, setSeries] = useState<AdminSeriesDetail | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        adminRequest<AdminSeriesDetail>(`/series/${encodeURIComponent(id)}`, { signal: controller.signal })
            .then(setSeries)
            .catch(failure => {
                if (controller.signal.aborted) return;
                if (failure instanceof AdminAuthError) onAuthLost();
                else setError(errorText(failure));
            });
        return () => controller.abort();
    }, [id, onAuthLost]);

    if (error) return <><p role="alert" className="error">{error}</p><a href="#/series">{t('admin.backToList')}</a></>;
    if (!series) return <p role="status">{t('admin.loadingSeries')}</p>;

    // An issue is an alternative version when another one continues the same issue.
    const alternative = (node: AdminSeriesNode) => node.parentOriginId !== null
        && series.nodes.some(other => other !== node && other.parentOriginId === node.parentOriginId);

    return (
        <>
            <p><a href="#/series">← {t('admin.series')}</a></p>
            <h1>{series.title}</h1>
            <div className="stats">
                <div className="stat"><span className="stat-label">{t('admin.issues')}</span><span className="stat-value">{formatNumber(series.issues)}</span>
                    {series.versions > 0 && <span className="muted small">{t('admin.versionsCount', { count: series.versions })}</span>}</div>
                <div className="stat"><span className="stat-label">{t('admin.comics')}</span><span className="stat-value">{formatNumber(series.comics)}</span>
                    {series.comics > series.nodes.length && <span className="muted small">{t('admin.copiesCount', { count: series.comics - series.nodes.length })}</span>}</div>
                <div className="stat"><span className="stat-label">{t('admin.pages')}</span><span className="stat-value">{formatNumber(series.pages)}</span></div>
                <div className="stat"><span className="stat-label">{t('admin.cost')}</span><span className="stat-value">{formatCost(series.usage)}</span></div>
                <div className="stat"><span className="stat-label">{t('admin.owners')}</span><span className="stat-value">{formatNumber(series.owners.length)}</span>
                    <span className="muted small">{series.owners.join(', ')}</span></div>
            </div>

            <section className="card" aria-label={t('admin.issues')}>
                <h2>{t('admin.issues')}</h2>
                <p className="muted small">{t('admin.treeHint')}</p>
                <ol className="tree">
                    {series.nodes.map(node => (
                        <li key={node.originId} className={`tree-node depth-${Math.min(node.depth, 6)}`}>
                            <Cover storyId={node.coverId} alt={t('admin.coverOf', { title: node.title })} />
                            <div className="tree-body">
                                <p>
                                    <strong>#{node.issue} · {node.title}</strong>
                                    {alternative(node) && <> <span className="badge">{t('admin.alternative')}</span></>}
                                </p>
                                {node.direction && <p className="muted small">{t('admin.direction', { direction: node.direction })}</p>}
                                {node.missingParent && <p className="muted small">{t('admin.missingParent')}</p>}
                                <ul className="holders">
                                    {node.comics.map(comic => (
                                        <li key={comic.id}>
                                            <a href={`#/story/${encodeURIComponent(comic.id)}`}>{comic.ownerAlias ?? comic.title}</a>
                                            <span className="muted small">{comic.original ? t('admin.original') : t('admin.copy')}</span>
                                            <span className={`badge ${comic.status}`}>{statusLabel(comic.status)}</span>
                                            <span className="small">{t('library.pages', { done: comic.completedPages, total: comic.totalPages })}</span>
                                            <span className="small">{formatCost(comic.usage)}</span>
                                            <span className="muted small">{formatDate(comic.updatedAt ?? comic.createdAt)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </li>
                    ))}
                </ol>
            </section>
        </>
    );
}
