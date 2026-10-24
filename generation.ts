import { GoogleGenAI } from '@google/genai';
import { LANGUAGES, MAX_STORY_PAGES, type Beat, type ComicFace, type Persona } from './types';
import type { StorySettings } from './invitations';

export const MODEL_TEXT_NAME = 'gemini-3.8-flash';
export const MODEL_IMAGE_GEN_NAME = 'gemini-nano-banana-2.1';

export interface StoryContext {
    hero: Persona;
    friend: Persona | null;
    hostName: string;
    guestName: string;
    settings: StorySettings;
    tone: string;
    styleGuide: string;
    title: string;
}

export interface TitleRequest {
    settings: StorySettings;
    tone: string;
    hostName: string;
    guestName: string;
    forbidden: string[];
}

// Asks for several fresh candidates at once; the caller filters out repeats with pickUniqueTitle.
export async function generateTitleCandidates(ai: GoogleGenAI, request: TitleRequest): Promise<string[]> {
    const langName = languageName(request.settings.language);
    const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const forbidden = request.forbidden.slice(-60);
    const prompt = `
You are naming a new comic book issue. ${coreDriver(request.settings, request.tone)}
CAST: protagonist "${request.hostName || 'the hero'}"${request.guestName ? ` and co-star "${request.guestName}"` : ''}.
Invent 5 ORIGINAL titles IN ${langName.toUpperCase()}: 2 to 6 words each, evocative, in the spirit of classic comic mastheads, no quotes, no numbering, no subtitle after a colon, max 50 characters.
Every title must be clearly different from each other AND from this list of already used titles (also avoid trivial variations of them):
${forbidden.length ? forbidden.map(title => `- ${title}`).join('\n') : '- (none yet)'}
Do not use "Infinite Heroes", "Héroes Infinitos" or translations of it. Randomness seed: ${seed}.

OUTPUT STRICT JSON ONLY: { "titles": ["...", "...", "...", "...", "..."] }`;
    const response = await ai.models.generateContent({
        model: MODEL_TEXT_NAME,
        contents: prompt,
        config: { responseMimeType: 'application/json', temperature: 1.3, ...usage('title') }
    });
    const parsed = parseJson(response.text);
    const titles = Array.isArray(parsed.titles) ? parsed.titles : Array.isArray(parsed) ? parsed : [];
    if (!titles.length) throw new Error('Gemini no propuso ningún título.');
    return titles;
}

// Every Gemini call goes through the server proxy, which holds the API key and meters usage per story or draft.
export type UsageScope =
    | { kind: 'story'; storyId: string; token: string }
    | { kind: 'draft'; draftId: string };

export function createAI(scope: UsageScope): GoogleGenAI {
    const headers: Record<string, string> = scope.kind === 'story'
        ? { 'X-Story-Id': scope.storyId, 'X-Story-Token': scope.token }
        : { 'X-Draft-Id': scope.draftId };
    return new GoogleGenAI({
        apiKey: 'proxy',
        httpOptions: { baseUrl: `${window.location.origin}/api/gemini`, apiVersion: 'v1beta', headers }
    });
}

// Labels each call so the usage report can break consumption down by operation and page.
function usage(op: string) {
    return { httpOptions: { headers: { 'X-Usage-Op': op } } };
}

export function isApiKeyError(error: unknown): boolean {
    const message = String(error);
    return message.includes('Requested entity was not found')
        || message.includes('API_KEY_INVALID')
        || message.toLowerCase().includes('permission denied');
}

// The SDK throws ApiError whose message is the raw JSON body; extract the human-readable part.
export function apiErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.error?.message === 'string') return parsed.error.message;
    } catch {
        // Not JSON: keep the original text.
    }
    return raw;
}

// Errors that retrying cannot fix: spending limits and a server without an API key.
export function fatalGenerationMessage(error: unknown): string | null {
    const message = apiErrorMessage(error);
    if (message.includes('LIMITE_DE_CONSUMO')) return message.replace(/^LIMITE_DE_CONSUMO:\s*/, '');
    if (message.includes('GEMINI_API_KEY no configurada')) return message;
    return null;
}

function languageName(code: string): string {
    return LANGUAGES.find(language => language.code === code)?.name || 'Spanish';
}

function inlineJpeg(base64OrDataUrl: string) {
    const data = base64OrDataUrl.includes(',') ? base64OrDataUrl.split(',')[1] : base64OrDataUrl;
    return { inlineData: { mimeType: 'image/jpeg', data } };
}

function parseJson(raw: string | undefined): any {
    return JSON.parse((raw || '{}').replace(/```json/g, '').replace(/```/g, '').trim());
}

function coreDriver(settings: StorySettings, tone: string): string {
    if (settings.genre === 'Custom') {
        return `STORY PREMISE: ${settings.premise || 'A totally unique, unpredictable adventure'}. (Follow this premise strictly over standard genre tropes).`;
    }
    return `GENRE: ${settings.genre}. TONE: ${tone}.`;
}

// Produces a fixed "character bible" so every page prompt describes the same faces, outfits and palette.
export async function generateStyleGuide(ai: GoogleGenAI, context: StoryContext): Promise<string> {
    const contents: any[] = [{ text: 'REFERENCE 1 [HERO]:' }, inlineJpeg(context.hero.base64)];
    if (context.friend) contents.push({ text: 'REFERENCE 2 [CO-STAR]:' }, inlineJpeg(context.friend.base64));
    contents.push({ text: `
You are the art director of a comic book. ${coreDriver(context.settings, context.tone)}
Design the definitive look of the cast so that EVERY page is drawn identically.
Describe each character from the reference photo (face shape, hair, skin tone, build, age impression) and invent ONE fixed costume that fits the genre: garments, colors (give specific color names), accessories, footwear.
${context.friend ? 'Describe the CO-STAR exactly like the HERO, with a complementary but clearly distinct costume.' : 'If there is no CO-STAR reference, describe a sidekick costume concept that could be used later.'}
Also define the world palette and inking style in one sentence.

OUTPUT STRICT JSON ONLY:
{
  "hero_look": "max 70 words, English",
  "costar_look": "max 70 words, English",
  "world_style": "max 40 words, English"
}` });
    const response = await ai.models.generateContent({
        model: MODEL_TEXT_NAME,
        contents,
        config: { responseMimeType: 'application/json', ...usage('style') }
    });
    const parsed = parseJson(response.text);
    const section = (label: string, value: unknown) => typeof value === 'string' && value.trim() ? `${label}: ${value.trim()}` : '';
    const guide = [
        section('HERO LOOK', parsed.hero_look),
        section('CO-STAR LOOK', parsed.costar_look),
        section('WORLD STYLE', parsed.world_style)
    ].filter(Boolean).join('\n');
    if (!guide) throw new Error('No se pudo definir el aspecto de los personajes.');
    return guide.slice(0, 4000);
}

export async function generateBeat(
    ai: GoogleGenAI,
    context: StoryContext,
    faces: ComicFace[],
    pageNum: number,
    isDecisionPage: boolean
): Promise<Beat> {
    const { settings, tone } = context;
    const isFinalPage = pageNum === MAX_STORY_PAGES;
    const langName = languageName(settings.language);

    const relevantHistory = faces
        .filter(face => face.type === 'story' && face.narrative && (face.pageIndex || 0) < pageNum)
        .sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
    const lastPage = relevantHistory[relevantHistory.length - 1];
    const lastFocus = lastPage?.narrative?.focus_char || 'none';

    const historyText = relevantHistory.map(face =>
        `[Page ${face.pageIndex}] [Focus: ${face.narrative?.focus_char}] (Caption: "${face.narrative?.caption || ''}") (Dialogue: "${face.narrative?.dialogue || ''}") (Scene: ${face.narrative?.scene}) ${face.resolvedChoice ? `-> USER CHOICE: "${face.resolvedChoice}"` : ''}`
    ).join('\n');

    let friendInstruction = 'Not yet introduced.';
    if (context.friend) {
        friendInstruction = 'ACTIVE and PRESENT (User Provided).';
        friendInstruction += lastFocus !== 'friend' && Math.random() > 0.4
            ? ' MANDATORY: FOCUS ON THE CO-STAR FOR THIS PANEL.'
            : ' Ensure they are woven into the scene even if not the main focus.';
    }

    const guardrails = `
    NEGATIVE CONSTRAINTS:
    1. UNLESS GENRE IS "Dark Sci-Fi" OR "Superhero Action" OR "Custom": DO NOT use technical jargon like "Quantum", "Timeline", "Portal", "Multiverse", or "Singularity".
    2. IF GENRE IS "Teen Drama" OR "Lighthearted Comedy": The "stakes" must be SOCIAL, EMOTIONAL, or PERSONAL (e.g., a rumor, a competition, a broken promise, being late, embarrassing oneself). Do NOT make it life-or-death. Keep it grounded.
    3. Avoid "The artifact" or "The device" unless established earlier.
    4. CONTINUITY: Characters keep the SAME clothes, hairstyle and accessories described in the CHARACTER BIBLE unless the story explicitly changes them. Locations and time of day must follow logically from the previous page.
    `;

    let instruction = `Continue the story. ALL OUTPUT TEXT (Captions, Dialogue, Choices) MUST BE IN ${langName.toUpperCase()}. ${coreDriver(settings, tone)} ${guardrails}`;
    if (settings.richMode) {
        instruction += ' RICH/NOVEL MODE ENABLED. Prioritize deeper character thoughts, descriptive captions, and meaningful dialogue exchanges over short punchlines.';
    }

    const resolvedDecision = relevantHistory.find(face => face.isDecisionPage && face.resolvedChoice);
    if (lastPage?.isDecisionPage && lastPage.resolvedChoice) {
        instruction += ` THE READERS JUST CHOSE: "${lastPage.resolvedChoice}". This page MUST show the immediate consequence of that choice; do not ignore or reverse it.`;
    }

    if (isFinalPage) {
        instruction += ` FINAL PAGE. KARMIC CLIFFHANGER REQUIRED. You MUST explicitly reference the readers' choice${resolvedDecision ? ` ("${resolvedDecision.resolvedChoice}")` : ''} in the narrative and show how that specific philosophy led to this conclusion. Text must end with 'TO BE CONTINUED...' (or localized equivalent).`;
    } else if (isDecisionPage) {
        instruction += ' End with a PSYCHOLOGICAL choice about VALUES, RELATIONSHIPS, or RISK. (e.g., Truth vs. Safety, Forgive vs. Avenge). The options must NOT be simple physical actions like \'Go Left\'.';
    } else if (pageNum === 1) {
        instruction += ' INCITING INCIDENT. An event disrupts the status quo. Establish the genre\'s intended mood. (If Slice of Life: A social snag/surprise. If Adventure: A call to action).';
    } else if (pageNum <= 4) {
        instruction += ' RISING ACTION. The heroes engage with the new situation. Focus on dialogue, character dynamics, and initial challenges.';
    } else if (pageNum <= 8) {
        instruction += ' COMPLICATION. A twist occurs! A secret is revealed, a misunderstanding deepens, or the path is blocked. (Keep intensity appropriate to Genre - e.g. Social awkwardness for Comedy, Danger for Horror).';
    } else {
        instruction += ' CLIMAX. The confrontation with the main conflict. The truth comes out, the contest ends, or the battle is fought.';
    }

    const capLimit = settings.richMode ? 'max 35 words. Detailed narration or internal monologue' : 'max 15 words';
    const diaLimit = settings.richMode ? 'max 30 words. Rich, character-driven speech' : 'max 12 words';

    const prompt = `
You are writing a comic book script. PAGE ${pageNum} of ${MAX_STORY_PAGES}.
ISSUE TITLE: "${context.title}" (the story should honor this title thematically).
TARGET LANGUAGE FOR TEXT: ${langName} (CRITICAL: CAPTIONS, DIALOGUE, CHOICES MUST BE IN THIS LANGUAGE).
${coreDriver(settings, tone)}

CHARACTERS:
- HERO: Active. Name: ${context.hostName || context.hero.desc}.
- CO-STAR: ${friendInstruction} Name: ${context.guestName || context.friend?.desc || 'Not established yet'}.

CHARACTER BIBLE (visual continuity, keep consistent):
${context.styleGuide || 'Not defined yet. Keep clothing consistent with earlier pages.'}

PREVIOUS PANELS (READ CAREFULLY):
${historyText.length > 0 ? historyText : 'Start the adventure.'}

RULES:
1. NO REPETITION. Do not use the same captions or dialogue from previous pages.
2. IF CO-STAR IS ACTIVE, THEY MUST APPEAR FREQUENTLY.
3. VARIETY. If page ${pageNum - 1} was an action shot, make this one a reaction or wide shot.
4. LANGUAGE: All user-facing text MUST be in ${langName}.
5. Avoid saying "CO-star" and "hero" in the text captions. Use names if established, or generic descriptors.
6. The "scene" must restate the outfits from the CHARACTER BIBLE in a few words so the artist never changes them.

INSTRUCTION: ${instruction}

OUTPUT STRICT JSON ONLY (No markdown formatting):
{
  "caption": "Unique narrator text in ${langName}. (${capLimit}).",
  "dialogue": "Unique speech in ${langName}. (${diaLimit}). Optional.",
  "scene": "Vivid visual description (ALWAYS IN ENGLISH for the artist model). MUST mention 'HERO' or 'CO-STAR' if they are present.",
  "focus_char": "hero" OR "friend" OR "other",
  "choices": ["Option A in ${langName}", "Option B in ${langName}"] (Only if decision page)
}
`;
    const response = await ai.models.generateContent({
        model: MODEL_TEXT_NAME,
        contents: prompt,
        config: { responseMimeType: 'application/json', ...usage(`beat:${pageNum}`) }
    });
    const parsed = parseJson(response.text);
    if (typeof parsed.scene !== 'string' || !parsed.scene.trim()) throw new Error('El guion de la página llegó vacío.');
    if (typeof parsed.dialogue === 'string') parsed.dialogue = parsed.dialogue.replace(/^[\w\s\-]+:\s*/i, '').replace(/["']/g, '').trim().slice(0, 500);
    else delete parsed.dialogue;
    if (typeof parsed.caption === 'string') parsed.caption = parsed.caption.replace(/^[\w\s\-]+:\s*/i, '').trim().slice(0, 500);
    else delete parsed.caption;
    parsed.scene = parsed.scene.trim().slice(0, 2000);
    const choices = Array.isArray(parsed.choices) ? parsed.choices.filter((choice: unknown) => typeof choice === 'string' && choice.trim()).map((choice: string) => choice.trim().slice(0, 200)).slice(0, 4) : [];
    parsed.choices = isDecisionPage && !isFinalPage ? (choices.length >= 2 ? choices : ['Opción A', 'Opción B']) : [];
    if (!['hero', 'friend', 'other'].includes(parsed.focus_char)) parsed.focus_char = 'hero';
    return { caption: parsed.caption, dialogue: parsed.dialogue, scene: parsed.scene, focus_char: parsed.focus_char, choices: parsed.choices };
}

export async function generatePersona(ai: GoogleGenAI, context: StoryContext, desc: string): Promise<Persona> {
    const style = context.settings.genre === 'Custom' ? 'Modern American comic book art' : `${context.settings.genre} comic`;
    const response = await ai.models.generateContent({
        model: MODEL_IMAGE_GEN_NAME,
        contents: { text: `STYLE: Masterpiece ${style} character sheet, detailed ink, neutral background. FULL BODY. Character: ${desc}. ${context.styleGuide ? `Follow this CHARACTER BIBLE for the CO-STAR: ${context.styleGuide}` : ''}` },
        config: { imageConfig: { aspectRatio: '1:1' }, ...usage('persona') }
    });
    const part = response.candidates?.[0]?.content?.parts?.find(candidate => candidate.inlineData);
    if (!part?.inlineData?.data) throw new Error('No se pudo crear el personaje secundario.');
    return { base64: part.inlineData.data, desc };
}

export async function generateImage(
    ai: GoogleGenAI,
    context: StoryContext,
    beat: Beat,
    type: ComicFace['type'],
    previousImage: string | null,
    pageIndex: number
): Promise<string> {
    const contents: any[] = [{ text: 'REFERENCE 1 [HERO] (real face to reproduce):' }, inlineJpeg(context.hero.base64)];
    if (context.friend) contents.push({ text: 'REFERENCE 2 [CO-STAR] (real face to reproduce):' }, inlineJpeg(context.friend.base64));
    if (previousImage) contents.push({ text: 'REFERENCE 3 [PREVIOUS PAGE] (copy the exact art style, costumes, hairstyles, colors and lighting; continue from this moment):' }, inlineJpeg(previousImage));

    const styleEra = context.settings.genre === 'Custom' ? 'Modern American' : context.settings.genre;
    const langName = languageName(context.settings.language);
    let promptText = `STYLE: ${styleEra} comic book art, detailed ink, vibrant colors. ALL PRINTED TEXT MUST BE IN ${langName.toUpperCase()}. `;
    if (context.styleGuide) promptText += `CHARACTER BIBLE (mandatory, identical on every page): ${context.styleGuide} `;
    if (previousImage) promptText += 'CONTINUITY: REFERENCE 3 is the previous page of this same issue. Keep every character looking exactly like there (same outfit, hair, accessories, proportions) and keep the same rendering technique. ';

    if (type === 'cover') {
        promptText += `TYPE: Comic Book Cover. TITLE LOGO (large, bold comic lettering, spelled EXACTLY like this): "${context.title}". Small imprint text in a corner: "INFINITE HEROES". Main visual: Dynamic action shot of [HERO] (Use REFERENCE 1)${context.friend ? ' together with [CO-STAR] (Use REFERENCE 2)' : ''}, wearing the costumes from the CHARACTER BIBLE.`;
    } else if (type === 'back_cover') {
        promptText += `TYPE: Comic Back Cover. FULL PAGE VERTICAL ART. Dramatic teaser for the next issue of "${context.title}". Text: a localized translation of "NEXT ISSUE SOON" in ${langName}, plus the title "${context.title}" in smaller lettering.`;
    } else {
        promptText += `TYPE: Vertical comic panel. SCENE: ${beat.scene}. `;
        promptText += 'INSTRUCTIONS: Maintain strict character likeness. If scene mentions \'HERO\', you MUST use REFERENCE 1. If scene mentions \'CO-STAR\' or \'SIDEKICK\', you MUST use REFERENCE 2.';
        if (beat.caption) promptText += ` INCLUDE CAPTION BOX: "${beat.caption}"`;
        if (beat.dialogue) promptText += ` INCLUDE SPEECH BUBBLE: "${beat.dialogue}"`;
    }
    contents.push({ text: promptText });

    const response = await ai.models.generateContent({
        model: MODEL_IMAGE_GEN_NAME,
        contents,
        config: { imageConfig: { aspectRatio: '2:3' }, ...usage(`image:${pageIndex}`) }
    });
    const part = response.candidates?.[0]?.content?.parts?.find(candidate => candidate.inlineData);
    if (!part?.inlineData?.data) throw new Error('El modelo no devolvió ninguna imagen.');
    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
}
