import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComicPdf, pdfFileName } from './comicPdf.ts';
import type { ComicFace } from './types.ts';

// A JPEG of one pixel.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const face = (pageIndex: number, extra: Partial<ComicFace> = {}): ComicFace => ({
    id: pageIndex === 0 ? 'cover' : `page-${pageIndex}`, type: pageIndex === 0 ? 'cover' : pageIndex === 3 ? 'back_cover' : 'story',
    imageUrl: JPEG, choices: [], isLoading: false, pageIndex, ...extra,
});

const properties = { title: 'Serie', subject: 'Cómic', author: 'Ana' };

test('an issue becomes one page per drawn face', () => {
    const pdf = createComicPdf(properties);
    assert.equal(pdf.addIssue({ faces: [face(2), face(0), face(3), face(1)] }), 4);
    assert.equal(pdf.pages, 4);
    assert.equal(pdf.doc.getNumberOfPages(), 4);
    // Faces that are not drawn yet are left out.
    const partial = createComicPdf(properties);
    assert.equal(partial.addIssue({ faces: [face(0), face(1, { imageUrl: undefined }), face(2, { isLoading: true })] }), 1);
    assert.equal(partial.doc.getNumberOfPages(), 1);
});

test('several issues follow one another, each with a bookmark on its cover', () => {
    const pdf = createComicPdf(properties);
    pdf.addIssue({ faces: [face(0), face(1), face(2), face(3)], language: 'es-ES', bookmark: 'Serie #1' });
    // An issue with nothing drawn adds neither pages nor a bookmark.
    assert.equal(pdf.addIssue({ faces: [face(0, { imageUrl: undefined })], bookmark: 'Serie #2' }), 0);
    pdf.addIssue({ faces: [face(1), face(0), face(3)], language: 'es-ES', bookmark: 'Serie #3 · «El día después»' });
    assert.equal(pdf.pages, 7);
    assert.equal(pdf.doc.getNumberOfPages(), 7);

    const destination = (page: number) => `/Dest [${pdf.doc.getPageInfo(page).objId} 0 R`;
    const output = pdf.doc.output();
    const first = output.indexOf('/Title (Serie #1)');
    assert.ok(first > 0 && output.indexOf(destination(1), first) > first);
    assert.equal(output.includes('Serie #2'), false);
    assert.equal(output.split('/Title ').length - 1, 3); // the document's title and two bookmarks
    assert.ok(output.includes(destination(5)));
    assert.match(output, /\/Type \/Outlines[\s\S]*?\/Count 2/);
    // Every issue links to the site from its cover (the address) and its back cover (the address and the whole page).
    assert.equal(output.split('mundoscruzados.com?lang=es').length - 1, 2 * (1 + 2));
});

test('the file is named after the comic, with the issues it holds when there are several', () => {
    assert.equal(pdfFileName('aquel-misterio'), 'aquel-misterio.pdf');
    assert.equal(pdfFileName('aquel-misterio', [1]), 'aquel-misterio.pdf');
    assert.equal(pdfFileName('aquel-misterio', [1, 2, 3]), 'aquel-misterio-1-3.pdf');
});
