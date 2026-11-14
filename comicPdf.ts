// The PDF of a comic: one full-bleed page per drawn face, for a single issue or for several issues one after another.
import { jsPDF } from 'jspdf';
import { addSiteLink } from './pdfBranding.ts';
import type { ComicFace } from './types.ts';

const WIDTH = 480;
const HEIGHT = 720;

export interface PdfIssue {
    faces: ComicFace[];
    // The comic's language, for the site link on its covers.
    language?: string;
    // Shown in the PDF reader's list of contents, pointing at the issue's cover.
    bookmark?: string;
}

export interface ComicPdf {
    doc: jsPDF;
    // Pages added so far.
    readonly pages: number;
    // Adds the drawn faces of an issue in reading order and returns how many there were.
    addIssue: (issue: PdfIssue) => number;
}

export function createComicPdf(properties: { title: string; subject: string; author: string }): ComicPdf {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [WIDTH, HEIGHT] });
    doc.setProperties({ ...properties, creator: 'Mundos Cruzados' });
    let pages = 0;
    return {
        doc,
        get pages() { return pages; },
        addIssue({ faces, language, bookmark }) {
            const drawn = faces.filter(face => face.imageUrl && !face.isLoading).sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
            drawn.forEach((face, index) => {
                // A new document already has its first page.
                if (pages > 0) doc.addPage([WIDTH, HEIGHT], 'portrait');
                pages += 1;
                doc.addImage(face.imageUrl!, 'JPEG', 0, 0, WIDTH, HEIGHT);
                addSiteLink(doc, face.type, WIDTH, HEIGHT, language);
                if (index === 0 && bookmark) doc.outline.add(null, bookmark, { pageNumber: pages });
            });
            return drawn.length;
        },
    };
}

// "serie-1-3.pdf" for issues 1 to 3 of a series, "serie.pdf" for a single comic.
export function pdfFileName(slug: string, issues: number[] = []): string {
    return issues.length > 1 ? `${slug}-${Math.min(...issues)}-${Math.max(...issues)}.pdf` : `${slug}.pdf`;
}
