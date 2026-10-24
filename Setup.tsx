
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect } from 'react';
import { GENRES, LANGUAGES, Persona } from './types';

export const GENRE_LABELS: Record<string, string> = {
    'Classic Horror': 'Terror clásico',
    'Superhero Action': 'Acción de superhéroes',
    'Dark Sci-Fi': 'Ciencia ficción oscura',
    'High Fantasy': 'Fantasía épica',
    'Neon Noir Detective': 'Detectives noir y neón',
    'Wasteland Apocalypse': 'Apocalipsis posapocalíptico',
    'Lighthearted Comedy': 'Comedia ligera',
    'Teen Drama / Slice of Life': 'Drama juvenil / Vida cotidiana',
    Custom: 'Personalizado'
};

interface SetupProps {
    show: boolean;
    isTransitioning: boolean;
    hero: Persona | null;
    friend: Persona | null;
    selectedGenre: string;
    selectedLanguage: string;
    customPremise: string;
    richMode: boolean;
    onHeroUpload: (file: File) => void;
    onFriendUpload: (file: File) => void;
    onGenreChange: (val: string) => void;
    onLanguageChange: (val: string) => void;
    onPremiseChange: (val: string) => void;
    onRichModeChange: (val: boolean) => void;
    onLaunch: () => void;
    guestMode?: boolean;
    hostName?: string;
    guestName?: string;
    launchDisabled?: boolean;
    launchLabel?: string;
    friendPhotoLocked?: boolean;
    children?: React.ReactNode;
    titleField?: {
        value: string;
        busy: boolean;
        stale: boolean;
        onChange: (value: string) => void;
        onPropose: () => void;
    };
}

const Footer = () => {
  const [remixIndex, setRemixIndex] = useState(0);
  const remixes = [
    "Añade sonidos a las viñetas",
    "Anima las viñetas con Veo 3",
    "Traduce a klingon",
    "Añade un generador de villanos",
    "Imprime copias físicas",
    "Añade narración de voz",
    "Crea un universo compartido"
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setRemixIndex(prev => (prev + 1) % remixes.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-black text-white py-3 px-6 flex flex-col md:flex-row justify-between items-center z-[300] border-t-4 border-yellow-400 font-comic">
        <div className="flex items-center gap-2 text-lg md:text-xl">
            <span className="text-yellow-400 font-bold">IDEA PARA MEJORAR:</span>
            <span className="animate-pulse">{remixes[remixIndex]}</span>
        </div>
        <div className="flex items-center gap-4 mt-2 md:mt-0">
            <span className="text-gray-500 text-sm hidden md:inline">Creado con Gemini</span>
            <a href="https://x.com/quiquee" target="_blank" rel="noopener noreferrer" className="text-white hover:text-yellow-400 transition-colors text-xl">Creado por @quiquee</a>
        </div>
    </div>
  );
};

export const Setup: React.FC<SetupProps> = (props) => {
    if (!props.show && !props.isTransitioning) return null;

    return (
        <>
        <style>{`
             @keyframes knockout-exit {
                0% { transform: scale(1) rotate(1deg); }
                15% { transform: scale(1.1) rotate(-5deg); }
                100% { transform: translateY(-200vh) rotate(1080deg) scale(0.5); opacity: 1; }
             }
             @keyframes pow-enter {
                 0% { transform: translate(-50%, -50%) scale(0) rotate(-45deg); opacity: 0; }
                 30% { transform: translate(-50%, -50%) scale(1.5) rotate(10deg); opacity: 1; }
                 100% { transform: translate(-50%, -50%) scale(1.8) rotate(0deg); opacity: 0; }
             }
          `}</style>
        {props.isTransitioning && (
            <div className="fixed top-1/2 left-1/2 z-[210] pointer-events-none" style={{ animation: 'pow-enter 1s forwards ease-out' }}>
                <svg viewBox="0 0 200 150" className="w-[500px] h-[400px] drop-shadow-[0_10px_0_rgba(0,0,0,0.5)]">
                    <path d="M95.7,12.8 L110.2,48.5 L148.5,45.2 L125.6,74.3 L156.8,96.8 L119.4,105.5 L122.7,143.8 L92.5,118.6 L60.3,139.7 L72.1,103.2 L34.5,108.8 L59.9,79.9 L24.7,57.3 L62.5,54.4 L61.2,16.5 z" fill="#FFD700" stroke="black" strokeWidth="4"/>
                    <text x="100" y="95" textAnchor="middle" fontFamily="'Bangers', cursive" fontSize="70" fill="#DC2626" stroke="black" strokeWidth="2" transform="rotate(-5 100 75)">POW!</text>
                </svg>
            </div>
        )}
        
        <div className={`fixed inset-0 z-[200] overflow-y-auto`}
             style={{
                 background: props.isTransitioning ? 'transparent' : 'rgba(0,0,0,0.85)', 
                 backdropFilter: props.isTransitioning ? 'none' : 'blur(6px)',
                 animation: props.isTransitioning ? 'knockout-exit 1s forwards cubic-bezier(.6,-0.28,.74,.05)' : 'none',
                 pointerEvents: props.isTransitioning ? 'none' : 'auto'
             }}>
          <div className="min-h-full flex items-center justify-center p-4 pt-16 pb-32 md:pb-24">
            {/* Compacted width and internal spacing */}
            <div className="max-w-[900px] w-full bg-white p-4 md:p-5 rotate-1 border-[6px] border-black shadow-[12px_12px_0px_rgba(0,0,0,0.6)] text-center relative">
                
                <h1 className="font-comic text-5xl text-red-600 leading-none mb-1 tracking-wide inline-block mr-3" style={{textShadow: '2px 2px 0px black'}}>HÉROES</h1>
                <h1 className="font-comic text-5xl text-yellow-400 leading-none mb-4 tracking-wide inline-block" style={{textShadow: '2px 2px 0px black'}}>INFINITOS</h1>
                
                <div className="flex flex-col md:flex-row gap-4 mb-4 text-left">
                    
                    {/* Left Column: Cast */}
                    <div className="flex-1 flex flex-col gap-2">
                        <div className="font-comic text-xl text-black border-b-4 border-black mb-1">1. LOS PERSONAJES</div>
                        
                        {/* HERO UPLOAD */}
                        <div className={`p-3 border-4 border-dashed ${props.hero ? 'border-green-500 bg-green-50' : 'border-blue-300 bg-blue-50'} transition-colors relative group`}>
                            <div className="flex justify-between items-center mb-1">
                                <p className="font-comic text-lg uppercase font-bold text-blue-900">{props.guestMode ? `TE INVITA ${props.hostName}` : 'HÉROE (OBLIGATORIO)'}</p>
                                {props.hero && <span className="text-green-600 font-bold font-comic text-sm animate-pulse">✓ LISTO</span>}
                            </div>
                            
                            {props.hero ? (
                                <div className="flex gap-3 items-center mt-1">
                                     <img src={`data:image/jpeg;base64,${props.hero.base64}`} alt="Vista previa del héroe" className="w-20 h-20 object-cover border-2 border-black shadow-[2px_2px_0px_rgba(0,0,0,0.2)] bg-white rotate-[-2deg]" />
                                     {!props.guestMode && <label className="cursor-pointer comic-btn bg-yellow-400 text-black text-sm px-3 py-1 hover:bg-yellow-300 transition-transform active:scale-95 uppercase">
                                         REEMPLAZAR
                                         <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && props.onHeroUpload(e.target.files[0])} />
                                     </label>}
                                </div>
                            ) : (
                                <label className="comic-btn bg-blue-500 text-white text-lg px-3 py-3 block w-full hover:bg-blue-400 cursor-pointer text-center">
                                    SUBIR HÉROE
                                    <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && props.onHeroUpload(e.target.files[0])} />
                                </label>
                            )}
                        </div>

                        {/* CO-STAR UPLOAD */}
                        <div className={`p-3 border-4 border-dashed ${props.friend ? 'border-green-500 bg-green-50' : 'border-purple-300 bg-purple-50'} transition-colors`}>
                            <div className="flex justify-between items-center mb-1">
                                <p className="font-comic text-lg uppercase font-bold text-purple-900">{props.guestMode ? `TU FOTO, ${props.guestName} (OBLIGATORIA)` : 'COPROTAGONISTA (OPCIONAL)'}</p>
                                {props.friend && <span className="text-green-600 font-bold font-comic text-sm animate-pulse">✓ LISTO</span>}
                            </div>

                            {props.friend ? (
                                <div className="flex gap-3 items-center mt-1">
                                    <img src={`data:image/jpeg;base64,${props.friend.base64}`} alt="Vista previa del coprotagonista" className="w-20 h-20 object-cover border-2 border-black shadow-[2px_2px_0px_rgba(0,0,0,0.2)] bg-white rotate-[2deg]" />
                                    {!props.friendPhotoLocked && <label className="cursor-pointer comic-btn bg-yellow-400 text-black text-sm px-3 py-1 hover:bg-yellow-300 transition-transform active:scale-95 uppercase">
                                        REEMPLAZAR
                                        <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && props.onFriendUpload(e.target.files[0])} />
                                    </label>}
                                </div>
                            ) : (
                                <label className="comic-btn bg-purple-500 text-white text-lg px-3 py-3 block w-full hover:bg-purple-400 cursor-pointer text-center">
                                    SUBIR COPROTAGONISTA
                                    <input type="file" accept="image/*" disabled={props.friendPhotoLocked} className="hidden" onChange={(e) => e.target.files?.[0] && props.onFriendUpload(e.target.files[0])} />
                                </label>
                            )}
                        </div>
                        
                        {/* Privacy Policy Text */}
                        <p className="text-[10px] text-gray-500 leading-tight mt-1 px-1">
                            Se aplica la Política de uso prohibido. No generes contenido que vulnere el derecho a la privacidad de otras personas.
                        </p>
                    </div>

                    {/* Right Column: Settings */}
                    <fieldset disabled={props.guestMode} className="flex-1 flex flex-col gap-2 min-w-0">
                        <div className="font-comic text-xl text-black border-b-4 border-black mb-1">2. LA HISTORIA</div>
                        
                        <div className="bg-yellow-50 p-3 border-4 border-black h-full flex flex-col justify-between">
                            <div>
                                <div className="mb-2">
                                    <p className="font-comic text-base mb-1 font-bold text-gray-800">GÉNERO</p>
                                    <select value={props.selectedGenre} onChange={(e) => props.onGenreChange(e.target.value)} className="w-full font-comic text-lg p-1 border-2 border-black uppercase bg-white text-black cursor-pointer shadow-[3px_3px_0px_rgba(0,0,0,0.2)] focus:outline-none focus:translate-x-[1px] focus:translate-y-[1px] focus:shadow-none transition-all">
                                        {GENRES.map(g => <option key={g} value={g} className="text-black">{GENRE_LABELS[g] ?? g}</option>)}
                                    </select>
                                </div>

                                <div className="mb-2">
                                    <p className="font-comic text-base mb-1 font-bold text-gray-800">IDIOMA</p>
                                    <select value={props.selectedLanguage} onChange={(e) => props.onLanguageChange(e.target.value)} className="w-full font-comic text-lg p-1 border-2 border-black uppercase bg-white text-black cursor-pointer shadow-[3px_3px_0px_rgba(0,0,0,0.2)]">
                                        {LANGUAGES.map(l => <option key={l.code} value={l.code} className="text-black">{l.label}</option>)}
                                    </select>
                                </div>

                                {props.selectedGenre === 'Custom' && (
                                    <div className="mb-2">
                                        <p className="font-comic text-base mb-1 font-bold text-gray-800">PREMISA</p>
                                        <textarea value={props.customPremise} onChange={(e) => props.onPremiseChange(e.target.value)} placeholder="Escribe la premisa de tu historia..." className="w-full p-1 border-2 border-black font-comic text-lg h-16 resize-none shadow-[3px_3px_0px_rgba(0,0,0,0.2)]" />
                                    </div>
                                )}

                                {props.titleField && !props.guestMode && (
                                    <div className="mb-2">
                                        <p className="font-comic text-base mb-1 font-bold text-gray-800">TÍTULO DEL CÓMIC</p>
                                        <div className="flex gap-2">
                                            <input aria-label="Título del cómic" maxLength={60} value={props.titleField.value} onChange={(e) => props.titleField!.onChange(e.target.value)} placeholder="Se propondrá uno al empezar" className="flex-1 min-w-0 p-1 border-2 border-black font-comic text-lg bg-white shadow-[3px_3px_0px_rgba(0,0,0,0.2)]" />
                                            <button type="button" onClick={props.titleField.onPropose} disabled={props.titleField.busy || props.isTransitioning} className="comic-btn bg-purple-600 text-white text-sm px-3 py-1 whitespace-nowrap disabled:bg-gray-400">
                                                {props.titleField.busy ? 'Buscando...' : props.titleField.value ? 'Otro título' : 'Proponer título'}
                                            </button>
                                        </div>
                                        <p className="text-xs text-gray-700 mt-1">
                                            {props.titleField.stale ? 'Has cambiado la historia: se propondrá un título nuevo al empezar, salvo que escribas uno.' : 'Gemini propone un título distinto para cada cómic; puedes editarlo.'}
                                        </p>
                                    </div>
                                )}
                            </div>
                            
                            <label className="flex items-center gap-2 font-comic text-base cursor-pointer text-black mt-1 p-1 hover:bg-yellow-100 rounded border-2 border-transparent hover:border-yellow-300 transition-colors">
                                <input type="checkbox" checked={props.richMode} onChange={(e) => props.onRichModeChange(e.target.checked)} className="w-4 h-4 accent-black" />
                                <span className="text-black">MODO NOVELA (Diálogos elaborados)</span>
                            </label>
                        </div>
                    </fieldset>
                </div>

                {props.children}
                <button onClick={props.onLaunch} disabled={!props.hero || props.isTransitioning || props.launchDisabled} className="comic-btn bg-red-600 text-white text-3xl px-6 py-3 w-full hover:bg-red-500 disabled:bg-gray-400 disabled:cursor-not-allowed uppercase tracking-wider">
                    {props.launchLabel || (props.isTransitioning ? '¡EN MARCHA!...' : '¡EMPEZAR AVENTURA!')}
                </button>
            </div>
          </div>
        </div>

        {/* Footer is only visible when setup is active */}
        <Footer />
        </>
    );
}
