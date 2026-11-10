import React, { useEffect, useState } from 'react';
import { t } from './i18n';
import { fetchCover, type StoryAuth } from './stories';
import type { SeriesNode } from './seriesLogic';

interface SeriesChooserProps {
    title: string;
    // The versions to choose from: issues that continue the same one in different ways.
    nodes: SeriesNode[];
    // The issue being read.
    current: SeriesNode;
    isMine: (node: SeriesNode) => boolean;
    comicOf: (node: SeriesNode) => string;
    authFor: (storyId: string) => StoryAuth;
    onPick: (node: SeriesNode) => void;
    onClose: () => void;
}

// Shows the alternative versions of an issue by their cover, title and what happens in them.
// Whose they are is not shown: only the reader's own are marked.
export function SeriesChooser({ title, nodes, current, isMine, comicOf, authFor, onPick, onClose }: SeriesChooserProps) {
    const [covers, setCovers] = useState<Record<string, string | null>>({});

    useEffect(() => {
        const controller = new AbortController();
        for (const node of nodes) {
            const id = comicOf(node);
            fetchCover(id, authFor(id), controller.signal)
                .then(imageUrl => setCovers(known => ({ ...known, [node.originId]: imageUrl })))
                .catch(() => { if (!controller.signal.aborted) setCovers(known => ({ ...known, [node.originId]: null })); });
        }
        return () => controller.abort();
    }, [nodes.map(node => node.originId).join()]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div role="dialog" aria-modal="true" aria-labelledby="series-chooser-title" className="fixed inset-0 z-[700] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-white border-4 border-black p-4 w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col gap-3" onClick={event => event.stopPropagation()}>
                <h2 id="series-chooser-title" className="font-comic text-2xl">{title}</h2>
                <p className="text-sm">{t('series.chooserHint')}</p>
                <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {nodes.map(node => {
                        const cover = covers[node.originId];
                        const reading = node.originId === current.originId;
                        return (
                            <li key={node.originId}>
                                <button type="button" onClick={() => onPick(node)} aria-current={reading || undefined}
                                  className={`w-full h-full text-left border-2 border-black bg-yellow-50 hover:bg-yellow-200 flex flex-col ${reading ? 'outline outline-4 outline-blue-500' : ''}`}>
                                    <span className="w-full aspect-[2/3] bg-gray-900 text-white text-sm flex items-center justify-center">
                                        {cover ? <img src={cover} alt="" className="w-full h-full object-cover" />
                                            : <span className="p-2 text-center">{cover === undefined ? t('common.loading') : t('series.noCover')}</span>}
                                    </span>
                                    <span className="p-2 flex flex-col gap-1">
                                        <span className="font-comic text-lg leading-tight">{node.title}</span>
                                        <span className="flex flex-wrap gap-1 text-xs">
                                            {isMine(node) && <span className="border border-black bg-green-200 px-1">{t('series.yours')}</span>}
                                            {reading && <span className="border border-black bg-blue-200 px-1">{t('series.reading')}</span>}
                                            {node.completedPages < node.totalPages && <span className="border border-black bg-white px-1">{t('library.pages', { done: node.completedPages, total: node.totalPages })}</span>}
                                        </span>
                                        {node.direction && <span className="text-sm line-clamp-4">{node.direction}</span>}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
                <div className="flex justify-end">
                    <button type="button" onClick={onClose} className="comic-btn bg-gray-200 px-3 py-2">{t('common.close')}</button>
                </div>
            </div>
        </div>
    );
}
