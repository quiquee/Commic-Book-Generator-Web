
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useCallback, useEffect, useState } from 'react';
import { TONES, Persona } from './types';
import { defaultComicLanguage, localizeText, t } from './i18n';
import { Setup } from './Setup';
import { Book } from './Book';
import { useApiKey } from './useApiKey';
import { ApiKeyDialog } from './ApiKeyDialog';
import { CoStarSection, type ActiveInvitation, type CastMode } from './CoStarSection';
import { GuestSetup } from './GuestSetup';
import { StoryLibrary } from './StoryLibrary';
import { AdminLibrary } from './AdminLibrary';
import { StoryView } from './StoryView';
import { errorMessage, fetchServerConfig, photoFromFile, storageKeys } from './invitations';
import { createStory, findOwnerToken, getRoute, loadStoryKeys, navigate, newDraftId, saveStoryKeys, type StoryAuth, type StoryDocument } from './stories';
import { apiErrorMessage, createAI, fatalGenerationMessage, generateTitleCandidates, isApiKeyError } from './generation';
import { cleanTitle, isTitleTaken, loadTitleHistory, pickUniqueTitle, rememberTitle } from './titles';

// Pre-filled title; titles are unique, so once it has been used Gemini proposes one instead.
const DEFAULT_TITLE = t('title.default');

function pickTone(genre: string): string {
  let availableTones = TONES;
  if (genre === "Teen Drama / Slice of Life" || genre === "Lighthearted Comedy") {
      availableTones = TONES.filter(t => t.includes("CASUAL") || t.includes("WHOLESOME") || t.includes("QUIPPY"));
  } else if (genre === "Classic Horror") {
      availableTones = TONES.filter(t => t.includes("INNER-MONOLOGUE") || t.includes("OPERATIC"));
  }
  return availableTones[Math.floor(Math.random() * availableTones.length)];
}

const App: React.FC = () => {
  const { validateApiKey, setShowApiKeyDialog, showApiKeyDialog, handleApiKeyDialogContinue } = useApiKey();

  const [hero, setHero] = useState<Persona | null>(null);
  const [friend, setFriend] = useState<Persona | null>(null);
  // "Mi historia" (own premise) is the default; the ready-made genres are the alternative.
  const [selectedGenre, setSelectedGenre] = useState('Custom');
  const [selectedLanguage, setSelectedLanguage] = useState(defaultComicLanguage);
  const [customPremise, setCustomPremise] = useState("");
  const [richMode, setRichMode] = useState(true);
  const [castMode, setCastMode] = useState<CastMode>('solo');
  const [activeInvitation, setActiveInvitation] = useState<ActiveInvitation | null>(null);
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [titleSource, setTitleSource] = useState<'default' | 'gemini' | 'manual' | null>('default');
  const [titleStale, setTitleStale] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [libraryTitles, setLibraryTitles] = useState<string[]>([]);
  // Groups the calls made before the comic exists (title proposals) so their usage is attributed to it later.
  const [draftId, setDraftId] = useState(newDraftId);
  const [appError, setAppError] = useState('');
  const [route, setRoute] = useState(getRoute);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [setupRevision, setSetupRevision] = useState(0);
  // Set by «Rehacer»: the comic whose parameters were loaded, its tone and its invitation (if still saved here).
  const [redoSource, setRedoSource] = useState<{ title: string; genre: string; tone: string; invitationId: string | null } | null>(null);

  const loadSavedHero = useCallback(() => {
    try {
      const saved = localStorage.getItem(storageKeys.hero);
      if (saved) {
        const persona: unknown = JSON.parse(saved);
        if (!persona || typeof persona !== 'object' || !('base64' in persona) || !('desc' in persona) ||
            typeof persona.base64 !== 'string' || typeof persona.desc !== 'string') {
          throw new Error(t('error.savedPhotoInvalid'));
        }
        setHero({ base64: persona.base64, desc: persona.desc });
      } else {
        setHero(null);
      }
    } catch (error) {
      setAppError(t('error.loadPhoto', { reason: errorMessage(error) }));
    }
  }, []);

  useEffect(() => {
    loadSavedHero();
    fetchServerConfig()
      .then(config => {
        if (config.geminiProxy === false) setAppError(t('error.generationUnavailable'));
      })
      .catch(() => { /* the API is reported by the actions that need it */ });
    const onHashChange = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const resetSetup = useCallback(() => {
    setFriend(null);
    setCastMode('solo');
    setActiveInvitation(null);
    setRedoSource(null);
    setTitle(DEFAULT_TITLE);
    setTitleSource('default');
    setTitleStale(false);
    setTitleBusy(false);
    setIsTransitioning(false);
    setShowApiKeyDialog(false);
    setSetupRevision(revision => revision + 1);
  }, [setShowApiKeyDialog]);

  const returnToMainMenu = useCallback(() => {
    resetSetup();
    // Guests go back to their invitation page; everyone else to the home screen.
    if (route.story && route.join && route.token) navigate({ join: route.join, token: route.token });
    else navigate({});
  }, [resetSetup, route]);

  // Discards a loaded «Rehacer»: back to the saved hero photo and an empty story.
  const startFresh = () => {
    resetSetup();
    loadSavedHero();
    setSelectedGenre('Custom');
    setSelectedLanguage(defaultComicLanguage);
    setCustomPremise('');
    setRichMode(true);
  };

  // Loads every parameter of an existing comic into the setup; the original is kept.
  const redoStory = (story: StoryDocument) => {
    resetSetup();
    let invitationId: string | null = null;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKeys.invitations) || '[]');
      if (story.invitationId && Array.isArray(saved) && saved.some(key => key?.id === story.invitationId)) invitationId = story.invitationId;
    } catch { /* fall back to the co-star photo */ }
    setHero(story.hero);
    setSelectedGenre(story.settings.genre);
    setSelectedLanguage(story.settings.language);
    setCustomPremise(story.settings.premise);
    setRichMode(story.settings.richMode);
    if (invitationId) setCastMode('invite');
    else if (story.friend) { setCastMode('photo'); setFriend(story.friend); }
    setRedoSource({ title: story.title, genre: story.settings.genre, tone: story.tone, invitationId });
    setAppError('');
    document.getElementById('setup-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // A Gemini title was written for a specific genre/premise/language; changing them makes it stale.
  const changeStorySetting = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    if (titleSource === 'gemini') setTitleStale(true);
  };

  const forbiddenTitles = useCallback(() => [...new Set([...loadTitleHistory(), ...libraryTitles])], [libraryTitles]);
  const defaultTitleTaken = titleSource === 'default' && isTitleTaken(title, forbiddenTitles());

  // Up to three rounds of candidates; a numbered variant is accepted only as a last resort.
  const generateUniqueTitle = async (genre: string, premise: string, language: string, hostName: string, guestName: string): Promise<string> => {
    const ai = createAI({ kind: 'draft', draftId });
    const forbidden = forbiddenTitles();
    const request = { settings: { genre, language, premise, richMode }, tone: pickTone(genre), hostName, guestName, forbidden };
    let lastCandidates: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      lastCandidates = await generateTitleCandidates(ai, request);
      const fresh = lastCandidates.map(cleanTitle).find(candidate => candidate && !isTitleTaken(candidate, forbidden));
      if (fresh) return fresh;
    }
    const numbered = pickUniqueTitle(lastCandidates, forbidden);
    if (!numbered) throw new Error(t('error.noNewTitle'));
    return numbered;
  };

  // The invitation only counts while "Invitar" is selected; switching modes keeps it for coming back.
  const invitation = castMode === 'invite' ? activeInvitation : null;
  const coStar: Persona | null = castMode === 'photo' ? friend
    : invitation?.response ? { ...invitation.response.persona, desc: invitation.response.name } : null;

  const currentNames = () => ({
    hostName: invitation?.invitation.hostName || localStorage.getItem(storageKeys.hostName) || t('cast.protagonist'),
    guestName: invitation?.invitation.guestName || (coStar ? t('cast.costar') : '')
  });

  // What still blocks the launch button, as its label.
  const launchBlocker = castMode === 'invite'
    ? !invitation ? t('launch.createInvitationFirst')
      : !invitation.response ? t('launch.waitingFor', { name: invitation.invitation.guestName.toUpperCase() }) : null
    : castMode === 'photo' && !friend ? t('launch.uploadCostar') : null;

  const proposeTitle = async () => {
    if (titleBusy) return;
    if (selectedGenre === 'Custom' && !customPremise.trim()) {
      setAppError(t('error.premiseBeforeTitle'));
      return;
    }
    if (!(await validateApiKey())) return;
    setTitleBusy(true);
    setAppError('');
    try {
      const { hostName, guestName } = currentNames();
      const proposed = await generateUniqueTitle(selectedGenre, customPremise, selectedLanguage, hostName, guestName);
      setTitle(proposed);
      setTitleSource('gemini');
      setTitleStale(false);
    } catch (error) {
      if (isApiKeyError(error)) setShowApiKeyDialog(true);
      else setAppError(t('error.proposeTitle', { reason: localizeText(fatalGenerationMessage(error) ?? apiErrorMessage(error)) }));
    } finally {
      setTitleBusy(false);
    }
  };

  // A shared comic uses the settings the guest was shown, so they are loaded (and locked) with the invitation.
  const changeActiveInvitation = (next: ActiveInvitation | null) => {
    if (next && next.invitation.id !== activeInvitation?.invitation.id) {
      const { settings } = next.invitation;
      if (titleSource === 'gemini' && (settings.genre !== selectedGenre || settings.premise !== customPremise
        || settings.language !== selectedLanguage)) setTitleStale(true);
      setSelectedGenre(settings.genre);
      setSelectedLanguage(settings.language);
      setCustomPremise(settings.premise);
      setRichMode(settings.richMode);
    }
    setActiveInvitation(next);
  };

  const launchStory = async () => {
    if (isTransitioning || launchBlocker) return;
    const hasKey = await validateApiKey();
    if (!hasKey || !hero) return;
    if (selectedGenre === 'Custom' && !customPremise.trim()) {
        setAppError(t('error.premiseMissing'));
        return;
    }
    setAppError('');
    const { hostName, guestName } = currentNames();

    // The title is fixed before the comic exists: generate one unless the protagonist wrote her own.
    let finalTitle = cleanTitle(title);
    const needsGeneration = !finalTitle || (titleStale && titleSource === 'gemini') || defaultTitleTaken;
    try {
      if (needsGeneration) {
        setTitleBusy(true);
        finalTitle = await generateUniqueTitle(selectedGenre, customPremise, selectedLanguage, hostName, guestName);
        setTitle(finalTitle);
        setTitleSource('gemini');
        setTitleStale(false);
      } else if (titleSource === 'manual' && isTitleTaken(finalTitle, forbiddenTitles())) {
        setAppError(t('error.titleTaken'));
        return;
      }
    } catch (error) {
      if (isApiKeyError(error)) setShowApiKeyDialog(true);
      else setAppError(t('error.generateTitle', { reason: localizeText(fatalGenerationMessage(error) ?? apiErrorMessage(error)) }));
      return;
    } finally {
      setTitleBusy(false);
    }

    setIsTransitioning(true);
    // A redone comic keeps its narrative tone unless the genre was changed.
    const tone = redoSource?.genre === selectedGenre ? redoSource.tone : pickTone(selectedGenre);

    try {
      rememberTitle(finalTitle);
      const created = await createStory({
        title: finalTitle,
        hostName,
        guestName,
        hero,
        friend: coStar,
        settings: { genre: selectedGenre, language: selectedLanguage, premise: customPremise, richMode },
        tone,
        invitation: invitation?.response ? {
          id: invitation.invitation.id, ownerToken: invitation.ownerToken, responseId: invitation.response.id
        } : null,
        draftId
      });
      saveStoryKeys([...loadStoryKeys(), created]);
      setDraftId(newDraftId());
      setTimeout(() => {
        resetSetup();
        navigate({ story: created.id });
      }, 1100);
    } catch (error) {
      setIsTransitioning(false);
      setAppError(t('error.createComic', { reason: errorMessage(error) }));
    }
  };

  const handleHeroUpload = async (file: File) => {
       try {
           const persona = await photoFromFile(file);
           localStorage.setItem(storageKeys.hero, JSON.stringify(persona));
           setHero(persona);
           setAppError('');
       } catch (error) { setAppError(t('error.saveHeroPhoto', { reason: errorMessage(error) })); }
  };
  const handleFriendUpload = async (file: File) => {
       try { setFriend(await photoFromFile(file)); setAppError(''); }
       catch (error) { setAppError(`No se pudo subir la foto del coprotagonista: ${errorMessage(error)}`); }
  };

  const storyAuth: StoryAuth | null = (() => {
    if (!route.story) return null;
    if (route.join && route.token) return { kind: 'guest', invitationId: route.join, token: route.token };
    const token = findOwnerToken(route.story);
    if (token) return { kind: 'owner', token };
    return route.read ? { kind: 'reader', token: route.read } : null;
  })();

  const openGuestStory = (storyId: string) => navigate({ join: route.join, token: route.token, story: storyId });

  let content: React.ReactNode;
  if (route.story && storyAuth) {
    content = <StoryView key={`${route.story}:${storyAuth.kind}`} storyId={route.story} auth={storyAuth} onExit={returnToMainMenu} />;
  } else if (route.story) {
    content = (
      <div className="bg-white border-4 border-black p-8 max-w-lg text-center">
        <h1 className="font-comic text-3xl mb-2">{t('noAccess.title')}</h1>
        <p>{t('noAccess.body')}</p>
      </div>
    );
  } else if (route.join && route.token) {
    content = <GuestSetup key={`${route.join}:${route.token}`} credentials={{ id: route.join, token: route.token }} onOpenStory={openGuestStory} />;
  } else {
    content = <>
      <Setup
          show
          isTransitioning={isTransitioning}
          hero={hero}
          friend={coStar}
          coStarSlot={
            <CoStarSection
              key={setupRevision}
              initialActiveId={redoSource?.invitationId}
              mode={castMode}
              onModeChange={setCastMode}
              hero={hero}
              friend={friend}
              onFriendUpload={handleFriendUpload}
              settings={{ genre: selectedGenre, language: selectedLanguage, premise: customPremise, richMode }}
              onActiveChange={changeActiveInvitation}
            />
          }
          banner={redoSource && (
            <div role="status" className="text-left border-2 border-black bg-yellow-100 p-2 mb-3 flex flex-wrap items-center gap-2">
              <p className="flex-1 text-sm">🔁 {t('redo.banner', { title: redoSource.title })}</p>
              <button type="button" onClick={startFresh} className="underline text-sm">{t('redo.startFresh')}</button>
            </div>
          )}
          storyLockedReason={invitation ? t('story.locked', { name: invitation.invitation.guestName }) : undefined}
          selectedGenre={selectedGenre}
          selectedLanguage={selectedLanguage}
          customPremise={customPremise}
          richMode={richMode}
          onHeroUpload={handleHeroUpload}
          onFriendUpload={handleFriendUpload}
          onGenreChange={changeStorySetting(setSelectedGenre)}
          onLanguageChange={changeStorySetting(setSelectedLanguage)}
          onPremiseChange={changeStorySetting(setCustomPremise)}
          onRichModeChange={setRichMode}
          onLaunch={launchStory}
          launchDisabled={titleBusy || !!launchBlocker}
          launchLabel={titleBusy ? t('launch.searchingTitle') : launchBlocker ?? (coStar && invitation
            ? t('launch.startWith', { name: invitation.invitation.guestName.toUpperCase() }) : undefined)}
          titleField={{
            value: title,
            busy: titleBusy,
            stale: titleStale && titleSource === 'gemini',
            note: defaultTitleTaken ? t('title.defaultTaken', { title: DEFAULT_TITLE })
              : titleSource === 'default' ? t('title.defaultHint') : undefined,
            onChange: value => { setTitle(value); setTitleSource(value.trim() ? 'manual' : null); setTitleStale(false); },
            onPropose: proposeTitle
          }}
      >
          {!isTransitioning && <>
            <StoryLibrary key={`library-${setupRevision}`} onOpen={storyId => navigate({ story: storyId })} onRedo={redoStory} onTitlesLoaded={setLibraryTitles} />
            <AdminLibrary key={`admin-${setupRevision}`} onOpen={storyId => navigate({ story: storyId })} />
          </>}
      </Setup>
      <Book comicFaces={[]} currentSheetIndex={0} isStarted={false} isSetupVisible={!isTransitioning} onSheetClick={() => {}} onChoice={() => {}} onOpenBook={() => {}} onDownload={() => {}} onReset={() => {}} />
    </>;
  }

  return (
    <div className="comic-scene">
      <button type="button" onClick={returnToMainMenu} className="fixed top-2 left-2 z-[500] comic-btn bg-yellow-400 text-black px-3 py-2 text-lg">{t('nav.mainMenu')}</button>
      {appError && <div role="alert" className="fixed top-16 left-4 right-4 z-[500] border-2 border-red-800 bg-white p-3 text-red-800">
          {appError} <button type="button" className="underline ml-2" onClick={() => setAppError('')}>{t('common.closeNotice')}</button>
      </div>}
      {showApiKeyDialog && <ApiKeyDialog onContinue={handleApiKeyDialogContinue} />}
      {content}
    </div>
  );
};

export default App;
