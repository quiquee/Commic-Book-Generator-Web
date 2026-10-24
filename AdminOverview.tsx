import React, { useEffect, useState } from 'react';
import { AdminAuthError, adminRequest, errorText, formatCost, formatNumber, formatUsd, type AdminOverview, type UsageTotals } from './adminApi';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="stat">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value}</span>
            {hint && <span className="muted small">{hint}</span>}
        </div>
    );
}

function usageRow(label: string, totals: UsageTotals) {
    return (
        <tr key={label}>
            <th scope="row">{label}</th>
            <td>{formatNumber(totals.calls)}</td>
            <td>{formatNumber(totals.errors)}</td>
            <td>{formatNumber(totals.tokens.total)}</td>
            <td>{formatCost(totals)}</td>
        </tr>
    );
}

export function AdminOverviewView({ onAuthLost }: { onAuthLost: () => void }) {
    const [overview, setOverview] = useState<AdminOverview | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        adminRequest<AdminOverview>('/overview', { signal: controller.signal })
            .then(setOverview)
            .catch(failure => {
                if (controller.signal.aborted) return;
                if (failure instanceof AdminAuthError) onAuthLost();
                else setError(errorText(failure));
            });
        return () => controller.abort();
    }, [onAuthLost]);

    if (error) return <p role="alert" className="error">{error}</p>;
    if (!overview) return <p role="status">Cargando resumen...</p>;

    const { stories, budget, daily } = overview;
    const maxDailyTokens = Math.max(1, ...daily.map(day => day.tokens.total));

    return (
        <>
            <h1>Resumen</h1>
            {!overview.pricingConfigured && (
                <p className="notice">No hay tarifas configuradas: se muestran tokens, pero el coste aparece como «sin tarifa». Crea <code>.data/pricing.json</code> (ver README).</p>
            )}
            <section className="stats" aria-label="Cómics">
                <Stat label="Cómics" value={formatNumber(stories.total)} hint={`${stories.active} activos · ${stories.deleted} borrados`} />
                <Stat label="Completos" value={formatNumber(stories.complete)} />
                <Stat label="En curso" value={formatNumber(stories.inProgress)} />
                <Stat label="Coste total (estimado)" value={formatCost(overview.totals)} hint={overview.pricingVersion ? `Tarifa ${overview.pricingVersion}` : undefined} />
            </section>

            {(budget.dailyBudgetUsd > 0 || budget.dailyTokenLimit > 0) && (
                <section className="card" aria-label="Límites diarios">
                    <h2>Límites de hoy (UTC)</h2>
                    {budget.dailyBudgetUsd > 0 && (
                        <p>Presupuesto: {formatUsd(budget.todayCostUsd)} de {formatUsd(budget.dailyBudgetUsd)}
                            <progress value={budget.todayCostUsd} max={budget.dailyBudgetUsd} />
                        </p>
                    )}
                    {budget.dailyTokenLimit > 0 && (
                        <p>Tokens: {formatNumber(budget.todayTokens)} de {formatNumber(budget.dailyTokenLimit)}
                            <progress value={budget.todayTokens} max={budget.dailyTokenLimit} />
                        </p>
                    )}
                </section>
            )}

            <section className="card" aria-label="Consumo por periodo">
                <h2>Consumo</h2>
                <table>
                    <thead><tr><th scope="col">Periodo</th><th scope="col">Llamadas</th><th scope="col">Errores</th><th scope="col">Tokens</th><th scope="col">Coste</th></tr></thead>
                    <tbody>
                        {usageRow('Hoy', overview.today)}
                        {usageRow('7 días', overview.last7Days)}
                        {usageRow('30 días', overview.last30Days)}
                        {usageRow('Total', overview.totals)}
                    </tbody>
                </table>
                {overview.draftsUnassigned.calls > 0 && (
                    <p className="muted small">Incluye {overview.draftsUnassigned.calls} llamadas previas a crear un cómic (propuestas de título) sin asignar.</p>
                )}
            </section>

            <section className="card" aria-label="Últimos 30 días">
                <h2>Últimos 30 días</h2>
                <table>
                    <thead><tr><th scope="col">Día</th><th scope="col">Llamadas</th><th scope="col">Tokens</th><th scope="col">Coste</th><th scope="col"><span className="visually-hidden">Volumen</span></th></tr></thead>
                    <tbody>
                        {[...daily].reverse().map(day => (
                            <tr key={day.date}>
                                <th scope="row">{day.date}</th>
                                <td>{formatNumber(day.calls)}</td>
                                <td>{formatNumber(day.tokens.total)}</td>
                                <td>{formatUsd(day.costUsd)}</td>
                                <td><progress value={day.tokens.total} max={maxDailyTokens} aria-label={`Tokens del ${day.date}`} /></td>
                            </tr>
                        ))}
                        {!daily.length && <tr><td colSpan={5} className="muted">Sin actividad registrada.</td></tr>}
                    </tbody>
                </table>
            </section>
        </>
    );
}
