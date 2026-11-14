/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React from 'react';
import { ComicFace, INITIAL_PAGES, GATE_PAGE } from './types';
import { LoadingFX } from './LoadingFX';
import { t, tFor } from './i18n';

interface PanelProps {
    face?: ComicFace;
    allFaces: ComicFace[]; // Needed for cover "printing" status
    onChoice: (pageIndex: number, choice: string) => void;
    onOpenBook: () => void;
    onDownload: () => void;
    // Downloads every issue of the series in one PDF (only offered when there are several).
    onDownloadSeries?: () => void;
    downloadSeriesLabel?: string;
    onReset: () => void;
    onShare?: () => void;
    onSaveCopy?: () => void;
    // Only for the owner of a finished comic.
    onContinue?: () => void;
    // The series goes on: opens the next issue (or the choice among its versions).
    onNextIssue?: () => void;
    nextIssueLabel?: string;
    // Number of the issue (2 or more for a continuation); 1 when absent.
    issue?: number;
    // Story-themed sound effects for the loading screen.
    soundEffects?: string[];
    // Language of the comic ('es-ES'): the cover button is written in it.
    comicLanguage?: string;
}

export const Panel: React.FC<PanelProps> = ({ face, allFaces, onChoice, onOpenBook, onDownload, onDownloadSeries, downloadSeriesLabel, onReset, onShare, onSaveCopy, onContinue, onNextIssue, nextIssueLabel, issue = 1, soundEffects, comicLanguage }) => {
    if (!face) return <div className="w-full h-full bg-gray-950" />;
    if (face.isLoading && !face.imageUrl) return <LoadingFX sounds={soundEffects} />;
    
    const isFullBleed = face.type === 'cover' || face.type === 'back_cover';

    return (
        <div className={`panel-container relative group ${isFullBleed ? '!p-0 !bg-[#0a0a0a]' : ''}`}>
            <div className="gloss"></div>
            {face.imageUrl && <img src={face.imageUrl} alt={t('panel.alt')} className={`panel-image ${isFullBleed ? '!object-cover' : ''}`} />}

            {/* Share a link to read the comic (the same link from any page) */}
            {face.imageUrl && onShare && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onShare(); }}
                  aria-label={t('panel.shareLink')}
                  className="absolute bottom-3 right-3 z-30 comic-btn bg-white/90 text-black text-sm px-3 py-1 hover:bg-yellow-300">
                    {t('panel.share')}
                </button>
            )}
            
            {/* Decision Buttons */}
            {face.isDecisionPage && face.choices.length > 0 && (
                <div className={`absolute bottom-0 inset-x-0 p-6 pb-12 flex flex-col gap-3 items-center justify-end transition-opacity duration-500 ${face.resolvedChoice ? 'opacity-0 pointer-events-none' : 'opacity-100'} bg-gradient-to-t from-black/90 via-black/50 to-transparent z-20`}>
                    <p className="text-white font-comic text-2xl uppercase tracking-widest animate-pulse">{t('panel.choicePrompt')}</p>
                    {face.choices.map((choice, i) => (
                        <button key={i} onClick={(e) => { e.stopPropagation(); if(face.pageIndex) onChoice(face.pageIndex, choice); }}
                          className={`comic-btn w-full py-3 text-xl font-bold tracking-wider ${i===0?'btn-primary':'btn-blue'}`}>
                            {choice}
                        </button>
                    ))}
                </div>
            )}

            {/* Cover Action */}
            {face.type === 'cover' && (
                 <div className="absolute bottom-20 inset-x-0 flex justify-center z-20">
                     <button onClick={(e) => { e.stopPropagation(); onOpenBook(); }}
                      disabled={!allFaces.find(f => f.pageIndex === GATE_PAGE)?.imageUrl}
                      className="comic-btn btn-primary px-10 py-4 text-3xl font-bold hover:scale-105 animate-bounce disabled:animate-none disabled:cursor-wait">
                         {(!allFaces.find(f => f.pageIndex === GATE_PAGE)?.imageUrl) ? tFor(comicLanguage, 'panel.printing', { done: allFaces.filter(f => f.type==='story' && f.imageUrl && (f.pageIndex||0) <= GATE_PAGE).length, total: INITIAL_PAGES }) : tFor(comicLanguage, 'panel.readIssue', { issue })}
                     </button>
                 </div>
            )}

            {/* Back Cover Actions */}
            {face.type === 'back_cover' && (
                <div className={`absolute inset-x-0 flex flex-col items-center z-20 ${onNextIssue ? 'bottom-28 gap-3' : 'bottom-24 gap-4'}`}>
                    {onNextIssue && <button onClick={(e) => { e.stopPropagation(); onNextIssue(); }} className="comic-btn btn-primary px-8 py-4 text-2xl font-bold hover:scale-105">{nextIssueLabel} {'\u25BA'}</button>}
                    <button onClick={(e) => { e.stopPropagation(); onDownload(); }} className="comic-btn btn-blue px-8 py-3 text-xl font-bold hover:scale-105">{t('panel.download')}</button>
                    {onDownloadSeries && <button onClick={(e) => { e.stopPropagation(); onDownloadSeries(); }} className="comic-btn btn-blue px-8 py-3 text-xl font-bold uppercase hover:scale-105">{downloadSeriesLabel}</button>}
                    {onSaveCopy && <button onClick={(e) => { e.stopPropagation(); onSaveCopy(); }} className="comic-btn btn-blue px-8 py-3 text-xl font-bold hover:scale-105">{t('copy.button')}</button>}
                    {onContinue && <button onClick={(e) => { e.stopPropagation(); onContinue(); }} className="comic-btn btn-primary px-8 py-3 text-xl font-bold hover:scale-105">{t('continue.button')}</button>}
                    <button onClick={(e) => { e.stopPropagation(); onReset(); }} className="comic-btn btn-white px-8 py-4 text-2xl font-bold hover:scale-105">{t('panel.backToMenu')}</button>
                </div>
            )}
        </div>
    );
}
