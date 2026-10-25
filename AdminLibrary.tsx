import React, { useEffect, useState } from 'react';
import { adminRequest, errorText, statusLabel, type AdminStoryItem, type AdminStoryList } from './adminApi';
import { formatDate, loadStoryKeys, rememberAdminStoryKey, type StoryKey } from './stories';

interface AdminLibraryProps {
    onOpen: (storyId: string) => void;
}

// Shown on the main page only while an admin session is active: everyone's comics, to read or finish them.
export function AdminLibrary({ onOpen }: AdminLibraryProps) {
    const [items, setItems] = useState<AdminStoryItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [openingId, setOpeningId] = useState<string | null>(null);
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
                setItems(others);
                setTotal(list.total);
            } catch (failure) {
                // Without an admin session (or with the panel disabled) the section simply stays hidden.
                if (!controller.signal.aborted && authenticated) {
                    setItems([]);
                    setError(`No se pudieron cargar los cómics: ${errorText(failure)}`);
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
            setError(`No se pudo abrir «${item.title}»: ${errorText(failure)}`);
        } finally {
            setOpeningId(null);
        }
    };

    if (items === null) return null;

    return (
        <section className="border-4 border-black bg-sky-50 p-3 mb-4 text-left">
            <h2 className="font-comic text-2xl">Todos los cómics <span className="text-base bg-black text-yellow-300 px-2 align-middle">ADMIN</span></h2>
            <p className="text-sm mb-2">
                Cómics de todos los usuarios (los tuyos están en «Mis cómics»). Al continuar uno, las páginas que falten se generan desde aquí
                y se registra en la auditoría. Si su creador lo tiene abierto a la vez, podrían generarse páginas dos veces.
            </p>
            {error && <p role="alert" className="text-red-700 font-bold mb-2">{error}</p>}
            {!items.length ? <p className="text-sm">No hay cómics de otros usuarios.</p> : (
                <ul className="flex flex-col gap-2 max-h-[28rem] overflow-y-auto">
                    {items.map(item => (
                        <li key={item.id} className="border-2 border-black bg-white p-2 flex flex-wrap items-center gap-2">
                            <div className="flex-1 min-w-[12rem]">
                                <p className="font-comic text-lg">{item.title}</p>
                                <p className="text-xs text-gray-700">
                                    {item.hostName}{item.guestName ? ` con ${item.guestName}` : ''} · {item.completedPages}/{item.totalPages} páginas · {statusLabel[item.status]} · {formatDate(item.updatedAt ?? item.createdAt)}
                                </p>
                            </div>
                            <button type="button" onClick={() => open(item)} disabled={openingId !== null}
                                className={`comic-btn px-3 py-2 ${item.status === 'complete' ? 'bg-blue-500 text-white' : 'bg-green-500 text-black'}`}>
                                {openingId === item.id ? 'Abriendo...' : item.status === 'complete' ? 'Leer' : 'Continuar'}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {total > 100 && <p className="text-xs mt-2">Se muestran los 100 más recientes; el resto está en el panel /admin.</p>}
        </section>
    );
}
