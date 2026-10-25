import React, { useCallback, useEffect, useState } from 'react';
import { AdminAuthError, adminRequest, errorText } from './adminApi';
import { AdminOverviewView } from './AdminOverview';
import { AdminStories } from './AdminStories';
import { AdminStoryDetailView } from './AdminStoryDetail';
import { t } from './i18n';

type View = { name: 'overview' } | { name: 'stories' } | { name: 'story'; id: string };

function parseHash(): View {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (hash.startsWith('story/')) return { name: 'story', id: decodeURIComponent(hash.slice(6)) };
    if (hash === 'stories') return { name: 'stories' };
    return { name: 'overview' };
}

function Login({ onLogin }: { onLogin: () => void }) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await adminRequest('/login', { method: 'POST', body: { password } });
            setPassword('');
            onLogin();
        } catch (failure) {
            setError(errorText(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="login">
            <form onSubmit={submit} className="card">
                <h1>{t('admin.title')}</h1>
                <p className="muted">Mundos Cruzados</p>
                <label>{t('admin.password')}
                    <input type="password" autoComplete="current-password" autoFocus required value={password} onChange={event => setPassword(event.target.value)} />
                </label>
                {error && <p role="alert" className="error">{error}</p>}
                <button type="submit" disabled={busy || !password}>{busy ? t('admin.signingIn') : t('admin.signIn')}</button>
            </form>
        </main>
    );
}

export function AdminApp() {
    const [authenticated, setAuthenticated] = useState<boolean | null>(null);
    const [disabled, setDisabled] = useState(false);
    const [view, setView] = useState<View>(parseHash);

    const checkSession = useCallback(() => {
        adminRequest<{ authenticated: boolean }>('/session')
            .then(result => setAuthenticated(result.authenticated))
            .catch(failure => {
                if (failure instanceof AdminAuthError) setAuthenticated(false);
                else { setDisabled(true); setAuthenticated(false); }
            });
    }, []);

    useEffect(() => {
        checkSession();
        const onHashChange = () => setView(parseHash());
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, [checkSession]);

    const onAuthLost = useCallback(() => setAuthenticated(false), []);

    const logout = async () => {
        try { await adminRequest('/logout', { method: 'POST' }); } finally { setAuthenticated(false); }
    };

    if (authenticated === null) return <main className="login"><p role="status">{t('common.loading')}</p></main>;
    if (disabled) return <main className="login"><div className="card"><h1>{t('admin.disabled')}</h1><p>{t('admin.disabledHint')}</p></div></main>;
    if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;

    const active = view.name === 'story' ? 'stories' : view.name;

    return (
        <>
            <header className="topbar">
                <strong>Mundos Cruzados · {t('admin.title')}</strong>
                <nav aria-label={t('admin.nav')}>
                    <a href="#/" aria-current={active === 'overview' ? 'page' : undefined}>{t('admin.overview')}</a>
                    <a href="#/stories" aria-current={active === 'stories' ? 'page' : undefined}>{t('admin.comics')}</a>
                    <a href="/api/admin/usage.csv" download>{t('admin.exportCsv')}</a>
                </nav>
                <button type="button" className="secondary" onClick={logout}>{t('admin.signOut')}</button>
            </header>
            <main className="content">
                {view.name === 'overview' && <AdminOverviewView onAuthLost={onAuthLost} />}
                {view.name === 'stories' && <AdminStories onAuthLost={onAuthLost} />}
                {view.name === 'story' && <AdminStoryDetailView key={view.id} id={view.id} onAuthLost={onAuthLost} />}
            </main>
        </>
    );
}
