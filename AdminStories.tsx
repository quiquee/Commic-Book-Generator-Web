import React, { useEffect, useState } from 'react';
import {
    AdminAuthError, adminRequest, errorText, formatCost, formatDate, formatNumber, imageUrl, statusLabel,
    type AdminStoryList, type StoryStatus
} from './adminApi';

const PAGE_SIZE = 20;

function Photo({ storyId, which, alt, deleted }: { storyId: string; which: string; alt: string; deleted: boolean }) {
    const [failed, setFailed] = useState(false);
    if (deleted || failed) return <span className="photo placeholder" aria-label={`${alt}: no disponible`}>—</span>;
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
            <h1>Cómics</h1>
            <form className="filters" role="search" onSubmit={event => event.preventDefault()}>
                <label>Buscar
                    <input type="search" placeholder="Título o nombre" value={query} onChange={event => setQuery(event.target.value)} />
                </label>
                <label>Estado
                    <select value={status} onChange={event => { setStatus(event.target.value as 'all' | StoryStatus); setPage(1); }}>
                        <option value="all">Todos</option>
                        <option value="in_progress">En curso</option>
                        <option value="complete">Completos</option>
                        <option value="deleted">Borrados</option>
                    </select>
                </label>
                <label>Ordenar por
                    <select value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>
                        <option value="createdAt">Creación</option>
                        <option value="updatedAt">Última actividad</option>
                        <option value="cost">Coste</option>
                        <option value="title">Título</option>
                    </select>
                </label>
                <label>Orden
                    <select value={order} onChange={event => { setOrder(event.target.value as 'asc' | 'desc'); setPage(1); }}>
                        <option value="desc">Descendente</option>
                        <option value="asc">Ascendente</option>
                    </select>
                </label>
            </form>
            {error && <p role="alert" className="error">{error}</p>}
            {!data && !error && <p role="status">Cargando cómics...</p>}
            {data && (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">Fotos</th><th scope="col">Cómic</th><th scope="col">Estado</th>
                                <th scope="col">Páginas</th><th scope="col">Llamadas</th><th scope="col">Tokens</th>
                                <th scope="col">Coste</th><th scope="col">Creado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.items.map(item => {
                                const deleted = item.status === 'deleted';
                                return (
                                    <tr key={item.id}>
                                        <td>
                                            <div className="photos">
                                                <Photo storyId={item.id} which="hero" alt={`Foto de ${item.hostName}`} deleted={deleted} />
                                                {item.hasFriend && <Photo storyId={item.id} which="friend" alt={`Foto de ${item.guestName || 'coprotagonista'}`} deleted={deleted} />}
                                            </div>
                                        </td>
                                        <td>
                                            <a href={`#/story/${item.id}`}><strong>{item.title}</strong></a>
                                            <div className="muted small">{item.hostName}{item.guestName ? ` y ${item.guestName}` : ''}</div>
                                        </td>
                                        <td><span className={`badge ${item.status}`}>{statusLabel[item.status]}</span></td>
                                        <td>{item.completedPages}/{item.totalPages}</td>
                                        <td>{formatNumber(item.usage.calls)}{item.usage.errors > 0 && <span className="muted small"> ({item.usage.errors} err.)</span>}</td>
                                        <td>{formatNumber(item.usage.tokens.total)}</td>
                                        <td>{formatCost(item.usage)}</td>
                                        <td>{formatDate(item.createdAt)}</td>
                                    </tr>
                                );
                            })}
                            {!data.items.length && <tr><td colSpan={8} className="muted">No hay cómics que coincidan.</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
            {data && pages > 1 && (
                <nav className="pager" aria-label="Paginación">
                    <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
                    <span>Página {page} de {pages} · {data.total} cómics</span>
                    <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Siguiente</button>
                </nav>
            )}
        </>
    );
}
