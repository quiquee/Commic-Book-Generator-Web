import { GState, type jsPDF } from 'jspdf';
import type { ComicFace } from './types';

export const SITE_URL = 'https://mundoscruzados.com';
// The site opens in the comic's language: 'es-ES' -> https://mundoscruzados.com?lang=es
export function siteUrl(language?: string): string {
    const base = (language ?? '').toLowerCase().split(/[-_]/)[0];
    return /^[a-z]{2}$/.test(base) ? `${SITE_URL}?lang=${base}` : SITE_URL;
}

const SITE_LABEL = 'mundoscruzados.com';
const STRIP_HEIGHT = 22;

// Adds the site link to a PDF page: a small semi-transparent strip with the address on the cover and
// the back cover, and the whole back cover clickable. The pages are full-bleed images, so the link sits
// on top of the art (the address Gemini draws on the cover moves from cover to cover).
export function addSiteLink(doc: jsPDF, type: ComicFace['type'], width: number, height: number, language?: string): void {
    const url = siteUrl(language);
    if (type === 'story') return;
    const top = height - STRIP_HEIGHT;
    doc.setGState(new GState({ opacity: 0.55 }));
    doc.setFillColor(0, 0, 0);
    doc.rect(0, top, width, STRIP_HEIGHT, 'F');
    doc.setGState(new GState({ opacity: 1 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(255, 255, 255);
    const textWidth = doc.getTextWidth(SITE_LABEL);
    const left = (width - textWidth) / 2;
    doc.text(SITE_LABEL, left, top + 15);
    doc.link(left - 6, top, textWidth + 12, STRIP_HEIGHT, { url });
    if (type === 'back_cover') doc.link(0, 0, width, height, { url });
}
