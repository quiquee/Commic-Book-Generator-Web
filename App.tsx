
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useCallback, useEffect, useState } from 'react';
import { GENRES, TONES, LANGUAGES, Persona } from './types';
import { Setup } from './Setup';
import { Book } from './Book';
import { useApiKey } from './useApiKey';
import { ApiKeyDialog } from './ApiKeyDialog';
import { InvitationPanel } from './InvitationPanel';
import { GuestSetup } from './GuestSetup';
import { StoryLibrary } from './StoryLibrary';
import { StoryView } from './StoryView';
import { errorMessage, fetchServerConfig, photoFromFile, storageKeys, type Invitation, type InvitationResponse } from './invitations';
import { createStory, findOwnerToken, getRoute, loadStoryKeys, navigate, newDraftId, saveStoryKeys, type StoryAuth } from './stories';
import { apiErrorMessage, createAI, fatalGenerationMessage, generateTitleCandidates, isApiKeyError } from './generation';
import { cleanTitle, isTitleTaken, loadTitleHistory, pickUniqueTitle, rememberTitle } from './titles';

interface LinkedInvitation {
  id: string;
  ownerToken: string;
  hostName: string;
  guestName: string;
}

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
  const [selectedGenre, setSelectedGenre] = useState(GENRES[0]);
  const [selectedLanguage, setSelectedLanguage] = useState(LANGUAGES[0].code);
  const [customPremise, setCustomPremise] = useState("");
  const [richMode, setRichMode] = useState(true);
  const [linkedInvitation, setLinkedInvitation] = useState<LinkedInvitation | null>(null);
  const [title, setTitle] = useState('');
  const [titleSource, setTitleSource] = useState<'gemini' | 'manual' | null>(null);
  const [titleStale, setTitleStale] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  const [libraryTitles, setLibraryTitles] = useState<string[]>([]);
  // Groups the calls made before the comic exists (title proposals) so their usage is attributed to it later.
  const [draftId, setDraftId] = useState(newDraftId);
  const [appError, setAppError] = useState('');
  const [route, setRoute] = useState(getRoute);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [setupRevision, setSetupRevision] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKeys.hero);
      if (saved) {
        const persona: unknown = JSON.parse(saved);
        if (!persona || typeof persona !== 'object' || !('base64' in persona) || !('desc' in persona) ||
            typeof persona.base64 !== 'string' || typeof persona.desc !== 'string') {
          throw new Error('La foto guardada no es válida.');
        }
        setHero({ base64: persona.base64, desc: persona.desc });
      }
    } catch (error) {
      setAppError(`No se pudo recuperar tu foto: ${errorMessage(error)}`);
    }
    fetchServerConfig()
      .then(config => {
        if (config.geminiProxy === false) setAppError('El servidor no tiene GEMINI_API_KEY configurada: no se podrán generar títulos ni cómics. Defínela en .env.local y reinicia el servidor.');
      })
      .catch(() => { /* the API is reported by the actions that need it */ });
    const onHashChange = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const resetSetup = useCallback(() => {
    setFriend(null);
    setLinkedInvitation(null);
    setTitle('');
    setTitleSource(null);
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

  // A Gemini title was written for a specific genre/premise/language; changing them makes it stale.
  const changeStorySetting = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    if (titleSource === 'gemini') setTitleStale(true);
  };

  const forbiddenTitles = useCallback(() => [...new Set([...loadTitleHistory(), ...libraryTitles])], [libraryTitles]);

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
    if (!numbered) throw new Error('Gemini no consiguió proponer un título nuevo. Inténtalo de nuevo o escribe uno.');
    return numbered;
  };

  const currentNames = () => ({
    hostName: linkedInvitation?.hostName || localStorage.getItem(storageKeys.hostName) || 'Protagonista',
    guestName: linkedInvitation?.guestName || (friend ? 'Coprotagonista' : '')
  });

  const proposeTitle = async () => {
    if (titleBusy) return;
    if (selectedGenre === 'Custom' && !customPremise.trim()) {
      setAppError('Escribe la premisa de la historia antes de proponer un título.');
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
      else setAppError(`No se pudo proponer un título: ${fatalGenerationMessage(error) ?? apiErrorMessage(error)}`);
    } finally {
      setTitleBusy(false);
    }
  };

  const acceptInvitation = (invitation: Invitation, response: InvitationResponse, ownerToken: string) => {
    setFriend({ ...response.persona, desc: response.name });
    setLinkedInvitation({ id: invitation.id, ownerToken, hostName: invitation.hostName, guestName: invitation.guestName });
    setSelectedGenre(invitation.settings.genre);
    setSelectedLanguage(invitation.settings.language);
    setCustomPremise(invitation.settings.premise);
    setRichMode(invitation.settings.richMode);
  };

  const launchStory = async () => {
    if (isTransitioning) return;
    const hasKey = await validateApiKey();
    if (!hasKey || !hero) return;
    if (selectedGenre === 'Custom' && !customPremise.trim()) {
        setAppError("Escribe la premisa de la historia.");
        return;
    }
    setAppError('');
    const { hostName, guestName } = currentNames();

    // The title is fixed before the comic exists: generate one unless the protagonist wrote her own.
    let finalTitle = cleanTitle(title);
    const needsGeneration = !finalTitle || (titleStale && titleSource === 'gemini');
    try {
      if (needsGeneration) {
        setTitleBusy(true);
        finalTitle = await generateUniqueTitle(selectedGenre, customPremise, selectedLanguage, hostName, guestName);
        setTitle(finalTitle);
        setTitleSource('gemini');
        setTitleStale(false);
      } else if (titleSource === 'manual' && isTitleTaken(finalTitle, forbiddenTitles())) {
        setAppError('Ya tienes un cómic con ese título. Cámbialo o pulsa «Otro título».');
        return;
      }
    } catch (error) {
      if (isApiKeyError(error)) setShowApiKeyDialog(true);
      else setAppError(`No se pudo generar el título: ${fatalGenerationMessage(error) ?? apiErrorMessage(error)}`);
      return;
    } finally {
      setTitleBusy(false);
    }

    setIsTransitioning(true);
    const tone = pickTone(selectedGenre);

    try {
      rememberTitle(finalTitle);
      const created = await createStory({
        title: finalTitle,
        hostName,
        guestName,
        hero,
        friend,
        settings: { genre: selectedGenre, language: selectedLanguage, premise: customPremise, richMode },
        tone,
        invitation: linkedInvitation ? { id: linkedInvitation.id, ownerToken: linkedInvitation.ownerToken } : null,
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
      setAppError(`No se pudo crear el cómic: ${errorMessage(error)}`);
    }
  };

  const handleHeroUpload = async (file: File) => {
       try {
           const persona = await photoFromFile(file);
           localStorage.setItem(storageKeys.hero, JSON.stringify(persona));
           setHero(persona);
           setAppError('');
       } catch (error) { setAppError(`No se pudo guardar la foto del héroe: ${errorMessage(error)}`); }
  };
  const handleFriendUpload = async (file: File) => {
       try { setFriend(await photoFromFile(file)); setLinkedInvitation(null); setAppError(''); }
       catch (error) { setAppError(`No se pudo subir la foto del coprotagonista: ${errorMessage(error)}`); }
  };

  const storyAuth: StoryAuth | null = (() => {
    if (!route.story) return null;
    if (route.join && route.token) return { kind: 'guest', invitationId: route.join, token: route.token };
    const token = findOwnerToken(route.story);
    return token ? { kind: 'owner', token } : null;
  })();

  const openGuestStory = (storyId: string) => navigate({ join: route.join, token: route.token, story: storyId });

  let content: React.ReactNode;
  if (route.story && storyAuth) {
    content = <StoryView key={`${route.story}:${storyAuth.kind}`} storyId={route.story} auth={storyAuth} onExit={returnToMainMenu} onApiKeyError={() => setShowApiKeyDialog(true)} />;
  } else if (route.story) {
    content = (
      <div className="bg-white border-4 border-black p-8 max-w-lg text-center">
        <h1 className="font-comic text-3xl mb-2">Sin acceso a este cómic</h1>
        <p>Este navegador no tiene la clave del cómic. Ábrelo desde el dispositivo de la protagonista o desde el enlace de invitación.</p>
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
          friend={friend}
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
          launchDisabled={titleBusy}
          launchLabel={titleBusy ? 'BUSCANDO TÍTULO...' : undefined}
          titleField={{
            value: title,
            busy: titleBusy,
            stale: titleStale && titleSource === 'gemini',
            onChange: value => { setTitle(value); setTitleSource(value.trim() ? 'manual' : null); setTitleStale(false); },
            onPropose: proposeTitle
          }}
      >
          {!isTransitioning && <>
            <StoryLibrary key={`library-${setupRevision}`} onOpen={storyId => navigate({ story: storyId })} onTitlesLoaded={setLibraryTitles} />
            <InvitationPanel
              key={setupRevision}
              hero={hero}
              settings={{ genre: selectedGenre, language: selectedLanguage, premise: customPremise, richMode }}
              onAccept={acceptInvitation}
            />
          </>}
      </Setup>
      <Book comicFaces={[]} currentSheetIndex={0} isStarted={false} isSetupVisible={!isTransitioning} onSheetClick={() => {}} onChoice={() => {}} onOpenBook={() => {}} onDownload={() => {}} onReset={() => {}} />
    </>;
  }

  return (
    <div className="comic-scene">
      <button type="button" onClick={returnToMainMenu} className="fixed top-2 left-2 z-[500] comic-btn bg-yellow-400 text-black px-3 py-2 text-lg">Menú principal</button>
      {appError && <div role="alert" className="fixed top-16 left-4 right-4 z-[500] border-2 border-red-800 bg-white p-3 text-red-800">
          {appError} <button type="button" className="underline ml-2" onClick={() => setAppError('')}>Cerrar aviso</button>
      </div>}
      {showApiKeyDialog && <ApiKeyDialog onContinue={handleApiKeyDialogContinue} />}
      {content}
    </div>
  );
};

export default App;
