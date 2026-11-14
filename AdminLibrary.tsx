import React, { useEffect, useState } from 'react';
import { adminRequest, errorText, statusLabel, type AdminStoryItem, type AdminStoryList } from './adminApi';
import { groupLibrary } from './seriesLogic';
import { formatDate, loadStoryKeys, rememberAdminStoryKey, type StoryKey } from './stories';
import { t } from './i18n';

interface AdminLibraryProps {
    onOpen: (storyId: string) => void;
}

type Comic = AdminStoryItem & { updatedAt: number };

// Shown on the main page only while an admin session is active: everyone's comics, to read or finish them.
// The issues of a series (and the copies and other versions people made of them) come under one entry.
export function AdminLibrary({ onOpen }: AdminLibraryProps) {
    const [items, setItems] = useState<Comic[] | null>(null);
    const [total, setTotal] = useState(0);
    const [openingId, setOpeningId] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [error, setError] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        (async () => {
            let authenticated = false;
            try {
                const session = await adminRequest<{ authenticated: boolean }>('/session', { signal: controller.signal });
                if (!session.authenticated) return;
                authenticated = true;
                const list = await adminRequest<AdminStoryList>('/stories?status=all&sort=updatedAt&order=desc&pageSize=100', { signal: controller.signal });
                let own = new Set<string>();
                try { own = new Set(loadStoryKeys().map(key => key.id)); } catch { /* show them all */ }
                const others = list.items.filter(item => item.status !== 'deleted' && !own.has(item.id));
                setItems(others.map(item => ({ ...item, updatedAt: item.updatedAt ?? item.createdAt })));
                setTotal(list.total);
            } catch (failure) {
                // Without an admin session (or with the panel disabled) the section simply stays hidden.
                if (!controller.signal.aborted && authenticated) {
                    setItems([]);
                    setError(t('adminLib.loadFailed', { reason: errorText(failure) }));
                }
            }
        })();
        return () => controller.abort();
    }, []);

    const open = async (item: AdminStoryItem) => {
        setOpeningId(item.id);
        setError('');
        try {
            rememberAdminStoryKey(await adminRequest<StoryKey>(`/stories/${item.id}/continue`, { method: 'POST' }));
            onOpen(item.id);
        } catch (failure) {
            setError(t('adminLib.openFailed', { title: item.title, reason: errorText(failure) }));
        } finally {
            setOpeningId(null);
        }
    };

    if (items === null) return null;

    const openButton = (item: Comic) => (
        <button type="button" onClick={() => open(item)} disabled={openingId !== null}
            className={`comic-btn px-3 py-2 ${item.status === 'complete' ? 'btn-blue' : 'btn-primary'}`}>
            {openingId === item.id ? t('adminLib.opening') : item.status === 'complete' ? t('common.read') : t('common.continue')}
        </button>
    );
    const details = (item: Comic) => (
        <p className="text-xs text-gray-700">
            {item.hostName}{item.guestName ? ` ${t('library.with', { name: item.guestName })}` : ''}{item.ownerAlias ? ` · ${item.ownerAlias}` : ''} · {t('library.pages', { done: item.completedPages, total: item.totalPages })} · {statusLabel(item.status)} · {formatDate(item.updatedAt)}
        </p>
    );

    return (
        <section className="border-4 border-black bg-sky-50 p-3 mb-4 text-left">
            <h2 className="font-comic text-2xl">{t('adminLib.title')} <span className="text-base bg-black text-yellow-300 px-2 align-middle">ADMIN</span></h2>
            <p className="text-sm mb-2">
                {t('adminLib.hint')}
            </p>
            {error && <p role="alert" className="text-red-700 font-bold mb-2">{error}</p>}
            {!items.length ? <p className="text-sm">{t('adminLib.empty')}</p> : (
                <ul className="flex flex-col gap-2 max-h-[28rem] overflow-y-auto">
                    {groupLibrary(items).map(group => {
                        if (group.comics.length === 1) {
                            const item = group.comics[0];
                            return (
                                <li key={group.id} className="border-2 border-black bg-white p-2 flex flex-wrap items-center gap-2">
                                    <div className="flex-1 min-w-[12rem]">
                                        <p className="font-comic text-lg">{item.title}</p>
                                        {details(item)}
                                    </div>
                                    {openButton(item)}
                                </li>
                            );
                        }
                        // A copy has the pages of its original: each issue counts once, with the most pages any comic of it has.
                        const pages = new Map<string, number>();
                        for (const comic of group.comics) {
                            const issue = comic.series?.originId ?? comic.id;
                            pages.set(issue, Math.max(pages.get(issue) ?? 0, comic.completedPages));
                        }
                        const owners = new Set(group.comics.map(comic => comic.ownerAlias).filter(Boolean));
                        const isOpen = expanded.has(group.id);
                        const listId = `admin-series-${group.id}`;
                        return (
                            <li key={group.id} className="border-2 border-black bg-white p-2 flex flex-col gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="flex-1 min-w-[12rem]">
                                        <p className="font-comic text-lg">{group.name}<span className="text-xs font-sans ml-2 border border-black bg-yellow-200 px-1">{t('library.seriesTag')}</span></p>
                                        <p className="text-xs text-gray-700">
                                            {t('library.seriesSummary', { issues: group.issues, pages: [...pages.values()].reduce((sum, count) => sum + count, 0) })} · {t('adminLib.seriesComics', { comics: group.comics.length, owners: owners.size })} · {formatDate(group.updatedAt)}
                                        </p>
                                    </div>
                                    <button type="button" aria-expanded={isOpen} aria-controls={listId}
                                        onClick={() => setExpanded(known => { const next = new Set(known); if (!next.delete(group.id)) next.add(group.id); return next; })}
                                        className="comic-btn btn-white px-3 py-2">{isOpen ? t('library.hideIssues') : t('library.showIssues')} {isOpen ? '▴' : '▾'}</button>
                                    {openButton(group.comics[0])}
                                </div>
                                {isOpen && (
                                    <ul id={listId} className="flex flex-col gap-1 border-t-2 border-black pt-2">
                                        {group.comics.map(item => (
                                            <li key={item.id} className="flex flex-wrap items-center gap-2 bg-sky-50 border border-black p-2">
                                                <div className="flex-1 min-w-[12rem]">
                                                    <p className="font-comic">#{item.series?.issue ?? 1} · {item.title}</p>
                                                    {details(item)}
                                                </div>
                                                {openButton(item)}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {total > 100 && <p className="text-xs mt-2">{t('adminLib.more')}</p>}
        </section>
    );
}
