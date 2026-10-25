import React, { useEffect, useState } from 'react';
import { AdminAuthError, adminRequest, errorText, formatCost, formatNumber, formatUsd, type AdminOverview, type UsageTotals } from './adminApi';
import { t } from './i18n';

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
    if (!overview) return <p role="status">{t('admin.loadingOverview')}</p>;

    const { stories, budget, daily } = overview;
    const maxDailyTokens = Math.max(1, ...daily.map(day => day.tokens.total));

    return (
        <>
            <h1>{t('admin.overview')}</h1>
            {!overview.pricingConfigured && (
                <p className="notice">{t('admin.noPricing')} <code>.data/pricing.json</code> {t('admin.seeReadme')}</p>
            )}
            <section className="stats" aria-label={t('admin.comics')}>
                <Stat label={t('admin.comics')} value={formatNumber(stories.total)} hint={t('admin.activeDeleted', { active: stories.active, deleted: stories.deleted })} />
                <Stat label={t('admin.completeCount')} value={formatNumber(stories.complete)} />
                <Stat label={t('admin.status.inProgress')} value={formatNumber(stories.inProgress)} />
                <Stat label={t('admin.totalCost')} value={formatCost(overview.totals)} hint={overview.pricingVersion ? t('admin.pricingVersion', { version: overview.pricingVersion }) : undefined} />
            </section>

            {(budget.dailyBudgetUsd > 0 || budget.dailyTokenLimit > 0) && (
                <section className="card" aria-label={t('admin.dailyLimits')}>
                    <h2>{t('admin.todayLimits')}</h2>
                    {budget.dailyBudgetUsd > 0 && (
                        <p>{t('admin.budgetOf', { used: formatUsd(budget.todayCostUsd), limit: formatUsd(budget.dailyBudgetUsd) })}
                            <progress value={budget.todayCostUsd} max={budget.dailyBudgetUsd} />
                        </p>
                    )}
                    {budget.dailyTokenLimit > 0 && (
                        <p>{t('admin.tokensOf', { used: formatNumber(budget.todayTokens), limit: formatNumber(budget.dailyTokenLimit) })}
                            <progress value={budget.todayTokens} max={budget.dailyTokenLimit} />
                        </p>
                    )}
                </section>
            )}

            <section className="card" aria-label={t('admin.usageByPeriod')}>
                <h2>{t('admin.usage')}</h2>
                <table>
                    <thead><tr><th scope="col">{t('admin.period')}</th><th scope="col">{t('admin.calls')}</th><th scope="col">{t('admin.errors')}</th><th scope="col">{t('admin.tokens')}</th><th scope="col">{t('admin.cost')}</th></tr></thead>
                    <tbody>
                        {usageRow(t('admin.today'), overview.today)}
                        {usageRow(t('admin.days', { days: 7 }), overview.last7Days)}
                        {usageRow(t('admin.days', { days: 30 }), overview.last30Days)}
                        {usageRow(t('admin.total'), overview.totals)}
                    </tbody>
                </table>
                {overview.draftsUnassigned.calls > 0 && (
                    <p className="muted small">{t('admin.draftCalls', { count: overview.draftsUnassigned.calls })}</p>
                )}
            </section>

            <section className="card" aria-label={t('admin.last30')}>
                <h2>{t('admin.last30')}</h2>
                <table>
                    <thead><tr><th scope="col">{t('admin.day')}</th><th scope="col">{t('admin.calls')}</th><th scope="col">{t('admin.tokens')}</th><th scope="col">{t('admin.cost')}</th><th scope="col"><span className="visually-hidden">{t('admin.volume')}</span></th></tr></thead>
                    <tbody>
                        {[...daily].reverse().map(day => (
                            <tr key={day.date}>
                                <th scope="row">{day.date}</th>
                                <td>{formatNumber(day.calls)}</td>
                                <td>{formatNumber(day.tokens.total)}</td>
                                <td>{formatUsd(day.costUsd)}</td>
                                <td><progress value={day.tokens.total} max={maxDailyTokens} aria-label={t('admin.tokensOfDay', { date: day.date })} /></td>
                            </tr>
                        ))}
                        {!daily.length && <tr><td colSpan={5} className="muted">{t('admin.noActivity')}</td></tr>}
                    </tbody>
                </table>
            </section>
        </>
    );
}
