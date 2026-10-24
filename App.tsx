
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useCallback, useEffect, useState } from 'react';
import { GENRES, TONES, LANGUAGES, Persona } from './types';
import { Setup, GENRE_LABELS } from './Setup';
import { Book } from './Book';
import { useApiKey } from './useApiKey';
import { ApiKeyDialog } from './ApiKeyDialog';
import { InvitationPanel } from './InvitationPanel';
import { GuestSetup } from './GuestSetup';
import { StoryLibrary } from './StoryLibrary';
import { StoryView } from './StoryView';
import { errorMessage, photoFromFile, storageKeys, type Invitation, type InvitationResponse } from './invitations';
import { createStory, findOwnerToken, getRoute, loadStoryKeys, navigate, saveStoryKeys, storyTitle, type StoryAuth } from './stories';

interface LinkedInvitation {
  id: string;
  ownerToken: string;
  hostName: string;
  guestName: string;
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
    const onHashChange = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const resetSetup = useCallback(() => {
    setFriend(null);
    setLinkedInvitation(null);
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
    setIsTransitioning(true);

    let availableTones = TONES;
    if (selectedGenre === "Teen Drama / Slice of Life" || selectedGenre === "Lighthearted Comedy") {
        availableTones = TONES.filter(t => t.includes("CASUAL") || t.includes("WHOLESOME") || t.includes("QUIPPY"));
    } else if (selectedGenre === "Classic Horror") {
        availableTones = TONES.filter(t => t.includes("INNER-MONOLOGUE") || t.includes("OPERATIC"));
    }
    const tone = availableTones[Math.floor(Math.random() * availableTones.length)];
    const hostName = linkedInvitation?.hostName || localStorage.getItem(storageKeys.hostName) || 'Protagonista';
    const guestName = linkedInvitation?.guestName || (friend ? 'Coprotagonista' : '');

    try {
      const created = await createStory({
        title: storyTitle(hostName, guestName, GENRE_LABELS[selectedGenre] ?? selectedGenre),
        hostName,
        guestName,
        hero,
        friend,
        settings: { genre: selectedGenre, language: selectedLanguage, premise: customPremise, richMode },
        tone,
        invitation: linkedInvitation ? { id: linkedInvitation.id, ownerToken: linkedInvitation.ownerToken } : null
      });
      saveStoryKeys([...loadStoryKeys(), created]);
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
          onGenreChange={setSelectedGenre}
          onLanguageChange={setSelectedLanguage}
          onPremiseChange={setCustomPremise}
          onRichModeChange={setRichMode}
          onLaunch={launchStory}
      >
          {!isTransitioning && <>
            <StoryLibrary key={`library-${setupRevision}`} onOpen={storyId => navigate({ story: storyId })} />
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
