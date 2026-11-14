import React, { useEffect, useState } from 'react';
import {
    AdminAuthError, adminRequest, errorText, formatCost, formatNumber, formatUsd,
    type AdminOverview, type ModelRates, type PricedCalls, type UsageTotals
} from './adminApi';
import { intlLocale, t } from './i18n';

const RATES = ['inputText', 'inputImage', 'outputText', 'outputImage'] as const;

// One line of the price table: a model's rates, in force now or from a later day.
function ratesRow(model: string, rates: ModelRates, from?: string) {
    return (
        <tr key={`${from ?? ''} ${model}`}>
            <th scope="row"><code>{model}</code></th>
            <td>{from ?? t('admin.priceNow')}</td>
            {RATES.map(rate => {
                const value = rates?.[rate];
                return <td key={rate}>{typeof value === 'number' ? value.toLocaleString(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'}</td>;
            })}
        </tr>
    );
}

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
    // Pricing the calls that were recorded without a cost: under way, done, or failed.
    const [pricing, setPricing] = useState(false);
    const [priced, setPriced] = useState<PricedCalls | null>(null);
    const [pricingError, setPricingError] = useState('');

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

    async function priceOldCalls() {
        setPricing(true);
        setPricingError('');
        try {
            const result = await adminRequest<PricedCalls>('/usage/price', { method: 'POST' });
            setOverview(await adminRequest<AdminOverview>('/overview'));
            setPriced(result);
        } catch (failure) {
            if (failure instanceof AdminAuthError) onAuthLost();
            else setPricingError(errorText(failure));
        } finally {
            setPricing(false);
        }
    }

    if (error) return <p role="alert" className="error">{error}</p>;
    if (!overview) return <p role="status">{t('admin.loadingOverview')}</p>;

    const { stories, budget, daily } = overview;
    const maxDailyTokens = Math.max(1, ...daily.map(day => day.tokens.total));
    const models = Object.entries(overview.pricingModels ?? {});

    return (
        <>
            <h1>{t('admin.overview')}</h1>
            {!overview.pricingConfigured && (
                <p className="notice">{t('admin.noPricing')} <code>.data/pricing.json</code> {t('admin.seeReadme')}</p>
            )}
            {priced && (
                <p className="notice" role="status">
                    {t('admin.pricedResult', { count: formatNumber(priced.priced), amount: formatUsd(priced.costUsd) })}
                    {priced.remaining > 0 && ` ${t('admin.pricedRemaining', { count: formatNumber(priced.remaining) })}`}
                </p>
            )}
            {overview.pricingConfigured && !priced && overview.totals.uncostedCalls > 0 && (
                <p className="notice">
                    {t('admin.unpricedCalls', { count: formatNumber(overview.totals.uncostedCalls) })}{' '}
                    <button type="button" onClick={priceOldCalls} disabled={pricing}>{t(pricing ? 'admin.pricing' : 'admin.priceThem')}</button>
                </p>
            )}
            {pricingError && <p role="alert" className="error">{pricingError}</p>}
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

            {overview.pricingConfigured && (
                <section className="card" aria-label={t('admin.prices')}>
                    <h2>{t('admin.prices')}</h2>
                    <table>
                        <thead><tr><th scope="col">{t('admin.model')}</th><th scope="col">{t('admin.priceFrom')}</th><th scope="col">{t('admin.rate.inputText')}</th><th scope="col">{t('admin.rate.inputImage')}</th><th scope="col">{t('admin.rate.outputText')}</th><th scope="col">{t('admin.rate.outputImage')}</th></tr></thead>
                        <tbody>
                            {models.map(([model, rates]) => ratesRow(model, rates))}
                            {(overview.pricingChanges ?? []).flatMap(change =>
                                Object.entries(change.models).map(([model, rates]) => ratesRow(model, rates, change.from)))}
                            {!models.length && <tr><td colSpan={6} className="muted">{t('admin.noPrices')}</td></tr>}
                        </tbody>
                    </table>
                    <p className="muted small">{t('admin.pricesNote')}</p>
                </section>
            )}

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
