/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

export const MAX_STORY_PAGES = 10;
export const BACK_COVER_PAGE = 11;
export const TOTAL_PAGES = 11;
export const INITIAL_PAGES = 2;
export const GATE_PAGE = 2;
export const BATCH_SIZE = 6;
export const DECISION_PAGES = [3];
// A location is drawn on at most this many consecutive pages before the story moves on.
export const MAX_SCENE_PAGES = 2;

export const GENRES = ["Classic Horror", "Superhero Action", "Dark Sci-Fi", "High Fantasy", "Neon Noir Detective", "Wasteland Apocalypse", "Lighthearted Comedy", "Teen Drama / Slice of Life", "Custom"];
export const TONES = [
    "ACTION-HEAVY (Short, punchy dialogue. Focus on kinetics.)",
    "INNER-MONOLOGUE (Heavy captions revealing thoughts.)",
    "QUIPPY (Characters use humor as a defense mechanism.)",
    "OPERATIC (Grand, dramatic declarations and high stakes.)",
    "CASUAL (Natural dialogue, focus on relationships/gossip.)",
    "WHOLESOME (Warm, gentle, optimistic.)"
];

// Labels are each language's own name, so they read the same whatever the interface language.
export const LANGUAGES = [
    { code: 'es-ES', name: 'Spanish (Spain)', label: 'Español' },
    { code: 'en-US', name: 'English (US)', label: 'English' },
    { code: 'fr-FR', name: 'French (France)', label: 'Français' },
    { code: 'gl-ES', name: 'Galician (Spain)', label: 'Galego' },
    { code: 'de-DE', name: 'German (Germany)', label: 'Deutsch' }
];

export interface ComicFace {
  id: string;
  type: 'cover' | 'story' | 'back_cover';
  imageUrl?: string;
  narrative?: Beat;
  choices: string[];
  resolvedChoice?: string;
  isLoading: boolean;
  pageIndex?: number;
  isDecisionPage?: boolean;
  version?: number;
}

export interface Beat {
  caption?: string;
  dialogue?: string;
  scene: string;
  choices: string[];
  focus_char: 'hero' | 'friend' | 'other';
  // false when the page stays in the location of the previous one; absent in comics made before this existed.
  new_scene?: boolean;
  // Fixed physical description of the location (English), repeated while the scene lasts.
  setting?: string;
}

export interface Persona {
  base64: string;
  desc: string;
}