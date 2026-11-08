// Background music (all CC0, see public/music/CREDITS.md). Files live in public/music/<mood>/<name>.mp3.
export const MUSIC: Record<string, string[]> = {
    menu: ["epic-main-menu-theme-loop", "adventure-intro-title-cinematic-epic"],
    horror: ["ps2-horror-mystery-ambient-theme", "a-lurking-evil-horror-ambience", "horror-music"],
    heroic: ["it-takes-a-hero", "righteous-and-reckless", "determined-pursuit-epic-orchestra-loop"],
    scifi: ["echoes-of-a-space-age-slow-sci-fi-music", "pondering-the-cosmos", "space-synth-wave"],
    fantasy: ["fantasy-orchestral-theme", "fantasy-grasslands"],
    noir: ["spy-loop", "jazz-saxaphone", "chill-jazz"],
    wasteland: ["wasteland-caravan", "lone-scavenger", "desert-settlement"],
    comedy: ["silly-theme-song", "goofy-attitude", "wacky-workings"],
    slice: ["lofi-hip-hop-loop", "happy-lofi-day", "chill-lofi-inspired"],
    calm: ["peaceful-theme", "happy-lullaby-song17", "peaceful-forest"],
    epic: ["epic-combat", "a-legend-will-rise-orchestral", "epic-trial"],
    reflective: ["emotional-piano-loop", "emotional-orchestra"],
};

export type Mood = keyof typeof MUSIC;

// Mood of a story: the genre decides; for «Mi historia» (Custom) the narrative tone does.
const GENRE_MOOD: Record<string, Mood> = {
    'Classic Horror': 'horror',
    'Superhero Action': 'heroic',
    'Dark Sci-Fi': 'scifi',
    'High Fantasy': 'fantasy',
    'Neon Noir Detective': 'noir',
    'Wasteland Apocalypse': 'wasteland',
    'Lighthearted Comedy': 'comedy',
    'Teen Drama / Slice of Life': 'slice'
};
const TONE_MOOD: [string, Mood][] = [
    ['ACTION-HEAVY', 'heroic'], ['INNER-MONOLOGUE', 'reflective'], ['QUIPPY', 'comedy'],
    ['OPERATIC', 'epic'], ['CASUAL', 'slice'], ['WHOLESOME', 'calm']
];

export function moodFor(genre: string, tone: string): Mood {
    if (GENRE_MOOD[genre]) return GENRE_MOOD[genre];
    return TONE_MOOD.find(([key]) => tone.includes(key))?.[1] ?? 'epic';
}

export const trackUrl = (mood: Mood, name: string) => `/music/${mood}/${name}.mp3`;

// A random track of the mood (any mood when null), avoiding `except` when there is a choice.
export function randomTrack(mood: Mood | null, except?: string): string {
    const pool = (mood ? MUSIC[mood].map(name => trackUrl(mood, name))
        : Object.entries(MUSIC).flatMap(([m, names]) => names.map(name => trackUrl(m, name))));
    const choices = pool.length > 1 ? pool.filter(url => url !== except) : pool;
    return choices[Math.floor(Math.random() * choices.length)];
}
