import React, { useEffect, useRef, useState } from 'react';
import { apiErrorMessage, createAI, fatalGenerationMessage, generateRecap } from './generation';
import { errorMessage } from './invitations';
import { localizeText, t } from './i18n';
import { createStory, loadStoryKeys, navigate, saveStoryKeys, type StoryDocument } from './stories';
import { cleanTitle, isTitleTaken, loadTitleHistory, rememberTitle } from './titles';

interface ContinueStoryProps {
    // The finished comic, with its pages, opened by its owner.
    source: StoryDocument;
    ownerToken: string;
    // Titles already in the library, so the new issue gets a unique one.
    existingTitles: string[];
    onCancel: () => void;
}

const CUSTOM = -1;

// "Title #2" for the next issue, replacing the number of the issue it continues.
function nextIssueTitle(title: string, issue: number): string {
    const base = title.replace(/\s*#\d+$/, '');
    const numbered = `${base} #${issue}`;
    return numbered.length <= 60 ? numbered : `${base.slice(0, 60 - ` #${issue}`.length).trim()} #${issue}`;
}

export function ContinueStory({ source, ownerToken, existingTitles, onCancel }: ContinueStoryProps) {
    const issue = (source.continuation?.issue ?? 1) + 1;
    const [recap, setRecap] = useState('');
    const [options, setOptions] = useState<string[]>([]);
    const [choice, setChoice] = useState<number | null>(null);
    const [custom, setCustom] = useState('');
    const [title, setTitle] = useState(() => nextIssueTitle(source.title, issue));
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const attempt = useRef(0);

    const load = async () => {
        const current = ++attempt.current;
        setLoading(true);
        setError('');
        try {
            const ai = createAI({ kind: 'story', storyId: source.id, token: ownerToken });
            const result = await generateRecap(ai, {
                hero: source.hero, friend: source.friend, hostName: source.hostName, guestName: source.guestName,
                settings: source.settings, tone: source.tone, styleGuide: source.styleGuide, title: source.title,
                continuation: source.continuation ?? null
            }, source.faces);
            if (current !== attempt.current) return;
            setRecap(result.recap);
            setOptions(result.options);
            setChoice(0);
        } catch (failure) {
            if (current !== attempt.current) return;
            setError(t('continue.recapFailed', { reason: localizeText(fatalGenerationMessage(failure) ?? apiErrorMessage(failure)) }));
        } finally {
            if (current === attempt.current) setLoading(false);
        }
    };

    useEffect(() => { load(); return () => { attempt.current++; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const direction = choice === CUSTOM ? custom.trim() : choice === null ? '' : options[choice] ?? '';
    const finalTitle = cleanTitle(title);
    const titleTaken = !!finalTitle && isTitleTaken(finalTitle, [...loadTitleHistory(), ...existingTitles]);
    const canStart = !loading && !creating && !!recap && !!direction && !!finalTitle && !titleTaken;

    const start = async () => {
        if (!canStart) return;
        setCreating(true);
        setError('');
        try {
            rememberTitle(finalTitle);
            const created = await createStory({
                title: finalTitle, hostName: source.hostName, guestName: source.guestName,
                hero: source.hero, friend: source.friend, settings: source.settings, tone: source.tone,
                invitation: null,
                continuation: { fromId: source.id, token: ownerToken, recap, direction }
            });
            saveStoryKeys([...loadStoryKeys(), created]);
            navigate({ story: created.id });
        } catch (failure) {
            setCreating(false);
            setError(t('continue.createFailed', { reason: errorMessage(failure) }));
        }
    };

    return (
        <div role="dialog" aria-modal="true" aria-labelledby="continue-title" className="fixed inset-0 z-[700] bg-black/70 overflow-y-auto flex items-start justify-center p-4">
            <div className="bg-white border-4 border-black p-4 w-full max-w-xl flex flex-col gap-3 my-8 text-left">
                <h2 id="continue-title" className="font-comic text-2xl">{t('continue.title', { issue })}</h2>
                {loading && <p role="status" className="font-comic text-lg animate-pulse">{t('continue.loading')}</p>}
                {error && <p role="alert" className="text-red-700 font-bold">{error}</p>}
                {!loading && error && !recap && <button type="button" onClick={load} className="comic-btn bg-yellow-400 px-3 py-2 self-start">{t('view.retry')}</button>}
                {recap && <>
                    <section>
                        <h3 className="font-comic text-lg">{t('continue.recap')}</h3>
                        <p className="text-sm border-2 border-black bg-yellow-50 p-2">{recap}</p>
                    </section>
                    <fieldset className="flex flex-col gap-2">
                        <legend className="font-comic text-lg">{t('continue.direction')}</legend>
                        {options.map((option, index) => (
                            <label key={index} className="flex items-start gap-2 border-2 border-black p-2 cursor-pointer has-[:checked]:bg-yellow-100">
                                <input type="radio" name="direction" checked={choice === index} onChange={() => setChoice(index)} className="mt-1" />
                                <span>{option}</span>
                            </label>
                        ))}
                        <label className="flex items-start gap-2 border-2 border-black p-2 cursor-pointer has-[:checked]:bg-yellow-100">
                            <input type="radio" name="direction" checked={choice === CUSTOM} onChange={() => setChoice(CUSTOM)} className="mt-1" />
                            <span className="flex-1">
                                {t('continue.custom')}
                                <input aria-label={t('continue.custom')} value={custom} maxLength={300} onFocus={() => setChoice(CUSTOM)} onChange={event => setCustom(event.target.value)}
                                    placeholder={t('continue.customPlaceholder')} className="block w-full border-2 border-black p-1 mt-1" />
                            </span>
                        </label>
                    </fieldset>
                    <label className="flex flex-col gap-1">
                        <span className="font-comic text-lg">{t('title.heading')}</span>
                        <input value={title} maxLength={60} onChange={event => setTitle(event.target.value)} className="border-2 border-black p-1 font-comic text-lg" />
                        {titleTaken && <span role="alert" className="text-sm text-red-700">{t('continue.titleTaken')}</span>}
                    </label>
                </>}
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onCancel} disabled={creating} className="comic-btn bg-gray-200 px-3 py-2">{t('common.cancel')}</button>
                    <button type="button" onClick={start} disabled={!canStart} className="comic-btn bg-red-600 text-white px-3 py-2 disabled:bg-gray-400">{creating ? t('launch.going') : t('continue.start', { issue })}</button>
                </div>
            </div>
        </div>
    );
}
