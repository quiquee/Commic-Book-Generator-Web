import React, { useEffect, useState } from 'react';
import { claimStory, loadStoryKeys, saveStoryKeys } from './stories';
import { errorMessage } from './invitations';
import { t } from './i18n';

interface ClaimStoryProps {
    storyId: string;
    claim: string;
    // Called with the comic's id once it is in the visitor's list.
    onClaimed: (storyId: string) => void;
    onExit: () => void;
}

// Opens a transfer link: the copy the admin made becomes the visitor's own comic.
export function ClaimStory({ storyId, claim, onClaimed, onExit }: ClaimStoryProps) {
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        claimStory(storyId, claim)
            .then(key => {
                if (cancelled) return;
                let keys: ReturnType<typeof loadStoryKeys> = [];
                try { keys = loadStoryKeys(); } catch { /* start a new list */ }
                saveStoryKeys([...keys.filter(item => item.id !== key.id), key]);
                onClaimed(key.id);
            })
            .catch(failure => { if (!cancelled) setError(errorMessage(failure)); });
        return () => { cancelled = true; };
    }, [storyId, claim, onClaimed]);

    return (
        <div className="bg-white border-4 border-black p-8 max-w-lg text-center">
            {error ? (
                <>
                    <h1 className="font-comic text-3xl mb-2">{t('claim.failedTitle')}</h1>
                    <p role="alert" className="mb-4">{t('claim.failed', { reason: error })}</p>
                    <button type="button" onClick={onExit} className="comic-btn bg-green-500 px-4 py-2">{t('panel.backToMenu')}</button>
                </>
            ) : <p role="status" className="font-comic text-3xl">{t('claim.saving')}</p>}
        </div>
    );
}
