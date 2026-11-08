
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useCallback, useEffect, useState } from 'react';
import { TONES, Persona } from './types';
import { defaultComicLanguage, t } from './i18n';
import { Setup } from './Setup';
import { Book } from './Book';
import { useApiKey } from './useApiKey';
import { ApiKeyDialog } from './ApiKeyDialog';
import { CoStarSection, type ActiveInvitation, type CastMode } from './CoStarSection';
import { GuestSetup } from './GuestSetup';
import { StoryLibrary } from './StoryLibrary';
import { AdminLibrary } from './AdminLibrary';
import { StoryView } from './StoryView';
import { clearDraft, loadDraft, saveDraft } from './draft';
import { MusicPlayer } from './MusicPlayer';
import type { Mood } from './music';
import { ContinueStory } from './ContinueStory';
import { errorMessage, fetchServerConfig, photoFromFile, storageKeys } from './invitations';
import { createStory, findOwnerToken, getRoute, loadStoryKeys, navigate, newDraftId, saveStoryKeys, type StoryAuth, type StoryDocument } from './stories';
import { cleanTitle, isTitleTaken, loadTitleHistory, rememberTitle } from './titles';


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
  // Music mood of the comic being read (null on the setup screens: a random track of any mood).
  const [storyMood, setStoryMood] = useState<Mood | null>(null);
  const { validateApiKey, setShowApiKeyDialog, showApiKeyDialog, handleApiKeyDialogContinue } = useApiKey();

  const [hero, setHero] = useState<Persona | null>(null);
  const [friend, setFriend] = useState<Persona | null>(null);
  // "Mi historia" (own premise) is the default; the ready-made genres are the alternative.
  // What was typed before a reload comes back (see draft.ts).
  const [restored] = useState(loadDraft);
  const [selectedGenre, setSelectedGenre] = useState(restored?.genre ?? 'Custom');
  const [selectedLanguage, setSelectedLanguage] = useState(restored?.language || defaultComicLanguage);
  const [customPremise, setCustomPremise] = useState(restored?.premise ?? "");
  const [richMode, setRichMode] = useState(restored?.richMode ?? true);
  const [castMode, setCastMode] = useState<CastMode>('solo');
  const [activeInvitation, setActiveInvitation] = useState<ActiveInvitation | null>(null);
  const [title, setTitle] = useState(restored?.title ?? '');
  const [libraryTitles, setLibraryTitles] = useState<string[]>([]);
  // Groups the calls made before the comic exists (title proposals) so their usage is attributed to it later.
  const [draftId, setDraftId] = useState(newDraftId);
  const [appError, setAppError] = useState('');
  const [route, setRoute] = useState(getRoute);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [setupRevision, setSetupRevision] = useState(0);
  // Set by «Rehacer»: the comic whose parameters were loaded, its tone and its invitation (if still saved here).
  const [redoSource, setRedoSource] = useState<{ title: string; genre: string; tone: string; invitationId: string | null } | null>(null);

  // Finished comic whose next issue is being planned from the library.
  const [continueSource, setContinueSource] = useState<{ story: StoryDocument; ownerToken: string } | null>(null);

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

  // Keeps the draft up to date while the setup screen is the one in view.
  useEffect(() => {
    if (isTransitioning || route.story || route.join) return;
    saveDraft({ genre: selectedGenre, language: selectedLanguage, premise: customPremise, richMode, title }, defaultComicLanguage);
  }, [selectedGenre, selectedLanguage, customPremise, richMode, title, isTransitioning, route.story, route.join]);

  const resetSetup = useCallback(() => {
    setFriend(null);
    setCastMode('solo');
    setActiveInvitation(null);
    setRedoSource(null);
    setTitle('');
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

  const forbiddenTitles = useCallback(() => [...new Set([...loadTitleHistory(), ...libraryTitles])], [libraryTitles]);

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
    : castMode === 'photo' && !friend ? t('launch.uploadCostar')
    : !cleanTitle(title) ? t('launch.enterTitle') : null;

  // A shared comic uses the settings the guest was shown, so they are loaded (and locked) with the invitation.
  const changeActiveInvitation = (next: ActiveInvitation | null) => {
    if (next && next.invitation.id !== activeInvitation?.invitation.id) {
      const { settings } = next.invitation;
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

    // The title is fixed before the comic exists and is always written by the protagonist.
    const finalTitle = cleanTitle(title);
    if (!finalTitle) {
      setAppError(t('error.titleRequired'));
      return;
    }
    if (isTitleTaken(finalTitle, forbiddenTitles())) {
      setAppError(t('error.titleTaken'));
      return;
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
      clearDraft();
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
    content = <StoryView key={`${route.story}:${storyAuth.kind}`} storyId={route.story} auth={storyAuth} onExit={returnToMainMenu} onMood={setStoryMood} />;
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
          onGenreChange={setSelectedGenre}
          onLanguageChange={setSelectedLanguage}
          onPremiseChange={setCustomPremise}
          onRichModeChange={setRichMode}
          onLaunch={launchStory}
          launchDisabled={!!launchBlocker}
          launchLabel={launchBlocker ?? (coStar && invitation
            ? t('launch.startWith', { name: invitation.invitation.guestName.toUpperCase() }) : undefined)}
          titleField={{ value: title, onChange: setTitle }}
          belowLaunch={!isTransitioning && <>
            <StoryLibrary key={`library-${setupRevision}`} onOpen={storyId => navigate({ story: storyId })} onRedo={redoStory} onContinue={(story, ownerToken) => setContinueSource({ story, ownerToken })} onTitlesLoaded={setLibraryTitles} />
            <AdminLibrary key={`admin-${setupRevision}`} onOpen={storyId => navigate({ story: storyId })} />
          </>}
      />
      <Book comicFaces={[]} currentSheetIndex={0} isStarted={false} isSetupVisible={!isTransitioning} onSheetClick={() => {}} onChoice={() => {}} onOpenBook={() => {}} onDownload={() => {}} onReset={() => {}} />
    </>;
  }

  return (
    <div className="comic-scene">
      <MusicPlayer mood={route.story ? storyMood : null} />
      <button type="button" onClick={returnToMainMenu} className="fixed bottom-2 left-2 z-[500] comic-btn bg-yellow-400/90 text-black px-2 py-1 text-base">{t('nav.mainMenu')}</button>
      {appError && <div role="alert" className="fixed top-16 left-4 right-4 z-[500] border-2 border-red-800 bg-white p-3 text-red-800">
          {appError} <button type="button" className="underline ml-2" onClick={() => setAppError('')}>{t('common.closeNotice')}</button>
      </div>}
      {continueSource && <ContinueStory source={continueSource.story} ownerToken={continueSource.ownerToken} existingTitles={libraryTitles} onCancel={() => setContinueSource(null)} onCreated={() => setContinueSource(null)} />}
      {showApiKeyDialog && <ApiKeyDialog onContinue={handleApiKeyDialogContinue} />}
      {content}
    </div>
  );
};

export default App;
