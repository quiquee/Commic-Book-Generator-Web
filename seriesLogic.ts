// Reading a series: where a comic sits among its issues, what comes before and after it, and how the comics of
// «Mis cómics» group into series. See series.mjs for how the server keeps the series.

// One issue of a series as the server lists it. Copies of an issue are the same node (they have the same pages);
// two nodes that continue the same issue are alternative versions of the next one.
export interface SeriesNode {
    originId: string;
    parentOriginId: string | null;
    issue: number;
    // The comic to read this issue from, and every comic that holds it.
    storyId: string;
    stories: string[];
    title: string;
    // What the author chose to happen in it (empty for a first issue).
    direction: string;
    completedPages: number;
    totalPages: number;
    updatedAt: number;
    // The key the tree was asked with owns one of its comics.
    mine: boolean;
}

export interface SeriesTree {
    id: string;
    title: string;
    nodes: SeriesNode[];
}

export interface SeriesPosition {
    node: SeriesNode;
    previous: SeriesNode | null;
    // The issues that continue this one, the reader's own first.
    next: SeriesNode[];
    // This issue and the alternative versions of it (just itself when there is none).
    versions: SeriesNode[];
    // The branch being read, first issue first: up to this issue, then on through the preferred next issues.
    path: SeriesNode[];
    index: number;
    // Pages of the issues before this one, and of the whole branch.
    pagesBefore: number;
    pagesTotal: number;
}

// "Title #2" -> "Title": a series is called like its first issue, without the number.
export function seriesName(title: string): string {
    return title.replace(/\s*#\d+$/, '').trim();
}

// Where the comic `storyId` sits in its series. `isMine` tells the reader's own issues (the keys they hold),
// which are preferred when an issue has several continuations.
export function seriesPosition(tree: SeriesTree, storyId: string, isMine: (node: SeriesNode) => boolean = node => node.mine): SeriesPosition | null {
    const node = tree.nodes.find(item => item.stories.includes(storyId));
    if (!node) return null;
    const byOrigin = new Map(tree.nodes.map(item => [item.originId, item]));
    const preferred = (a: SeriesNode, b: SeriesNode) =>
        Number(isMine(b)) - Number(isMine(a))
        || Number(b.completedPages >= b.totalPages) - Number(a.completedPages >= a.totalPages)
        || a.updatedAt - b.updatedAt
        || a.originId.localeCompare(b.originId);
    const continuations = (of: SeriesNode) => tree.nodes.filter(item => item.parentOriginId === of.originId && item !== of).sort(preferred);

    const path = [node];
    while (path[0].parentOriginId && byOrigin.has(path[0].parentOriginId) && !path.includes(byOrigin.get(path[0].parentOriginId)!)) {
        path.unshift(byOrigin.get(path[0].parentOriginId)!);
    }
    const index = path.length - 1;
    for (let following = continuations(node)[0]; following && !path.includes(following); following = continuations(following)[0]) {
        path.push(following);
    }
    const siblings = tree.nodes.filter(item => item.parentOriginId === node.parentOriginId && item.issue === node.issue);
    return {
        node,
        previous: index > 0 ? path[index - 1] : null,
        next: continuations(node),
        versions: node.parentOriginId ? [node, ...siblings.filter(item => item !== node).sort(preferred)] : [node],
        path,
        index,
        pagesBefore: path.slice(0, index).reduce((sum, item) => sum + item.completedPages, 0),
        pagesTotal: path.reduce((sum, item) => sum + item.completedPages, 0),
    };
}

// The issues of the branch being read that are drawn to the end, first issue first: what a PDF of the series holds.
export function finishedIssues(position: SeriesPosition): SeriesNode[] {
    return position.path.filter(node => node.totalPages > 0 && node.completedPages >= node.totalPages);
}

// What the library needs of each comic.
export interface LibraryComic {
    id: string;
    title: string;
    completedPages: number;
    totalPages: number;
    updatedAt: number;
    series?: { id: string; issue: number };
}

export interface LibrarySeries<T extends LibraryComic> {
    id: string;
    name: string;
    // Own comics of the series, first issue first.
    comics: T[];
    // Different issue numbers among them, and their pages (covers count).
    issues: number;
    pages: number;
    updatedAt: number;
    // The comic to go on from: the latest of the highest issue.
    last: T;
}

// Groups the comics of «Mis cómics» into series, keeping the order in which each series first appears.
export function groupLibrary<T extends LibraryComic>(comics: T[]): LibrarySeries<T>[] {
    const groups = new Map<string, T[]>();
    for (const comic of comics) {
        const id = comic.series?.id ?? comic.id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id)!.push(comic);
    }
    return [...groups.entries()].map(([id, list]) => {
        const sorted = [...list].sort((a, b) => (a.series?.issue ?? 1) - (b.series?.issue ?? 1) || a.updatedAt - b.updatedAt);
        return {
            id,
            name: seriesName(sorted[0].title) || sorted[0].title,
            comics: sorted,
            issues: new Set(sorted.map(comic => comic.series?.issue ?? 1)).size,
            pages: sorted.reduce((sum, comic) => sum + comic.completedPages, 0),
            updatedAt: Math.max(...sorted.map(comic => comic.updatedAt)),
            last: sorted[sorted.length - 1],
        };
    });
}
