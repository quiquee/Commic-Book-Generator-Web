// A whole series in one PDF: the finished issues of the branch a comic belongs to, first issue first.
import { createComicPdf, pdfFileName, type ComicPdf } from './comicPdf.ts';
import { t } from './i18n.ts';
import { finishedIssues, seriesName, seriesPosition, type SeriesTree } from './seriesLogic.ts';
import { comicOf, fetchSeries, fetchStory, holdsKey, issueAuth, type StoryAuth, type StoryDocument } from './stories.ts';
import { titleSlug } from './titles.ts';

interface SeriesPdfOptions {
    // The series and the comic being read, when they are already loaded.
    tree?: SeriesTree;
    current?: StoryDocument;
    // Called before each issue is fetched, and once more when all are in.
    onProgress?: (done: number, total: number) => void;
}

// Builds and saves the PDF of the branch the comic `storyId` is on. The issues are fetched one at a time (each is
// a few MB) with the key the reader has for them. Returns how many issues went in.
export async function downloadSeriesPdf(storyId: string, auth: StoryAuth, { tree, current, onProgress }: SeriesPdfOptions = {}): Promise<number> {
    const series = tree ?? await fetchSeries(storyId, auth);
    const position = seriesPosition(series, storyId, holdsKey);
    const issues = position ? finishedIssues(position) : [];
    if (!issues.length) throw new Error(t('series.pdfEmpty'));

    let pdf: ComicPdf | null = null;
    for (const [index, node] of issues.entries()) {
        onProgress?.(index, issues.length);
        const id = comicOf(node);
        const story = current?.id === id ? current : await fetchStory(id, issueAuth(auth, id));
        if (!pdf) {
            const cast = story.guestName ? t('pdf.castPair', { host: story.hostName, guest: story.guestName }) : story.hostName;
            pdf = createComicPdf({ title: series.title, subject: t('pdf.subject', { cast }), author: story.hostName });
        }
        pdf.addIssue({ faces: story.faces, language: story.settings.language, bookmark: `${seriesName(story.title) || story.title} #${node.issue}` });
    }
    onProgress?.(issues.length, issues.length);
    if (!pdf?.pages) throw new Error(t('series.pdfEmpty'));
    pdf.doc.save(pdfFileName(titleSlug(series.title), issues.map(node => node.issue)));
    return issues.length;
}
