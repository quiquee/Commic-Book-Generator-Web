import { createHash } from 'node:crypto';

// A series is a tree of issues. Every comic record carries `series`:
//   id              the series it belongs to (the id of the first comic the series started with)
//   issue           its number in the series (1, 2, 3...)
//   originId        the comic whose pages these are: its own id, or the original's id when it is a copy.
//                   All copies of one issue share it, so they are the same place in the tree.
//   parentOriginId  the originId of the issue it continues (null for #1). Two issues with the same parent
//                   are alternative continuations.
// The ids are kept even when the comic they name is deleted, so the tree survives deletions.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validSeries(value) {
  return !!value && typeof value === 'object' && UUID.test(value.id) && UUID.test(value.originId)
    && Number.isInteger(value.issue) && value.issue >= 1
    && (value.parentOriginId === null || UUID.test(value.parentOriginId));
}

// What the series index keeps of a comic record (the pages stay on disk).
export function seriesEntry(record) {
  const faces = Array.isArray(record.faces) ? record.faces : [];
  const cover = faces.find((face) => face.id === 'cover')?.imageUrl;
  const fromId = record.continuation?.fromId;
  const issue = record.continuation?.issue;
  return {
    id: record.id,
    stored: validSeries(record.series)
      ? { id: record.series.id, issue: record.series.issue, originId: record.series.originId, parentOriginId: record.series.parentOriginId }
      : null,
    fromId: typeof fromId === 'string' && UUID.test(fromId) ? fromId : null,
    issueHint: Number.isInteger(issue) && issue >= 1 ? issue : 1,
    direction: typeof record.continuation?.direction === 'string' ? record.continuation.direction : '',
    coverHash: typeof cover === 'string' && cover ? createHash('sha256').update(cover).digest('hex') : null,
    title: typeof record.title === 'string' ? record.title : '',
    ownerToken: typeof record.ownerToken === 'string' ? record.ownerToken : '',
    // What else opens the comic: its reading link and the invitation of its co-star.
    readToken: typeof record.readToken === 'string' ? record.readToken : null,
    invitationId: typeof record.invitationId === 'string' ? record.invitationId : null,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    completedPages: faces.filter((face) => face.imageUrl && !face.isLoading).length,
  };
}

// A series is called like its first issue, without the number ("Title #2" -> "Title").
export function seriesTitle(title) {
  return String(title ?? '').replace(/\s*#\d+$/, '').trim();
}

const oldestFirst = (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

// Works out the series data of every comic: the stored one, or for comics made before series existed, what their
// continuation link and their cover say (a copy has the very same cover image as its original).
// Returns Map<comic id, { id, issue, originId, parentOriginId }>.
export function planSeries(entries) {
  const byCover = new Map();
  for (const entry of entries) {
    if (!entry.coverHash) continue;
    if (!byCover.has(entry.coverHash)) byCover.set(entry.coverHash, []);
    byCover.get(entry.coverHash).push(entry);
  }
  const origin = new Map();
  for (const entry of entries) {
    if (entry.stored) { origin.set(entry.id, entry.stored.originId); continue; }
    const twins = [...(byCover.get(entry.coverHash) ?? [entry])].sort(oldestFirst);
    origin.set(entry.id, twins.find((twin) => twin.stored)?.stored.originId ?? twins[0].id);
  }

  // One node per originId: what its comics say about it (stored data first, then the original, then the oldest copy).
  const members = new Map();
  for (const entry of entries) {
    const key = origin.get(entry.id);
    if (!members.has(key)) members.set(key, []);
    members.get(key).push(entry);
  }
  const nodes = new Map();
  for (const [originId, list] of members) {
    list.sort(oldestFirst);
    const stored = list.find((entry) => entry.stored)?.stored;
    if (stored) { nodes.set(originId, { issue: stored.issue, parentOriginId: stored.parentOriginId, seriesId: stored.id }); continue; }
    const lead = list.find((entry) => entry.id === originId) ?? list[0];
    const parentOriginId = lead.fromId ? origin.get(lead.fromId) ?? lead.fromId : null;
    nodes.set(originId, { issue: lead.issueHint, parentOriginId: parentOriginId === originId ? null : parentOriginId, seriesId: null });
  }

  // The series is named after the top of the chain: the first issue or, if that one is gone, the id it had.
  const seriesIdOf = (originId) => {
    const visited = new Set();
    let current = originId;
    for (;;) {
      const node = nodes.get(current);
      if (!node) return current;
      if (node.seriesId) return node.seriesId;
      if (!node.parentOriginId || visited.has(current)) return current;
      visited.add(current);
      current = node.parentOriginId;
    }
  };
  for (const [originId, node] of nodes) if (!node.seriesId) node.resolvedSeriesId = seriesIdOf(originId);

  const plan = new Map();
  for (const entry of entries) {
    if (entry.stored) { plan.set(entry.id, entry.stored); continue; }
    const originId = origin.get(entry.id);
    const node = nodes.get(originId);
    plan.set(entry.id, { id: node.seriesId ?? node.resolvedSeriesId, issue: node.issue, originId, parentOriginId: node.parentOriginId });
  }
  return plan;
}

// Groups planned comics into series: [{ id, title, issues, comics, pages, nodes: [{ originId, parentOriginId, issue, depth, missingParent, comics }] }].
// Nodes come in reading order (each issue followed by the issues that continue it).
export function groupSeries(entries, plan = planSeries(entries)) {
  const series = new Map();
  for (const entry of entries) {
    const data = plan.get(entry.id);
    if (!series.has(data.id)) series.set(data.id, new Map());
    const nodes = series.get(data.id);
    if (!nodes.has(data.originId)) nodes.set(data.originId, { originId: data.originId, parentOriginId: data.parentOriginId, issue: data.issue, comics: [] });
    nodes.get(data.originId).comics.push(entry);
  }
  const result = [];
  for (const [id, nodes] of series) {
    for (const node of nodes.values()) node.comics.sort(oldestFirst);
    const byIssue = (a, b) => a.issue - b.issue || oldestFirst(a.comics[0], b.comics[0]);
    const ordered = [];
    const visit = (node, depth) => {
      if (ordered.includes(node)) return;
      node.depth = depth;
      ordered.push(node);
      for (const child of [...nodes.values()].filter((item) => item.parentOriginId === node.originId).sort(byIssue)) visit(child, depth + 1);
    };
    for (const root of [...nodes.values()].filter((node) => !node.parentOriginId || !nodes.has(node.parentOriginId)).sort(byIssue)) {
      root.missingParent = !!root.parentOriginId;
      visit(root, 0);
    }
    for (const node of [...nodes.values()].sort(byIssue)) visit(node, 0);
    const all = ordered.flatMap((node) => node.comics);
    result.push({
      id,
      title: ordered[0].comics[0].title,
      issues: new Set(ordered.map((node) => node.issue)).size,
      comics: all.length,
      pages: all.reduce((sum, entry) => sum + entry.completedPages, 0),
      createdAt: Math.min(...all.map((entry) => entry.createdAt)),
      nodes: ordered,
    });
  }
  return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// Plain-text report of what the migration would write, for a person to check before applying it.
export function seriesReport(entries, { alias = () => '' } = {}) {
  const plan = planSeries(entries);
  const groups = groupSeries(entries, plan);
  const pending = entries.filter((entry) => !entry.stored);
  const date = (time) => new Date(time).toISOString().slice(0, 10);
  const line = (entry, label) => `${label.padEnd(14)}${(entry.title || '(no title)').slice(0, 44).padEnd(46)}${String(entry.completedPages).padStart(2)}/12  ${date(entry.createdAt)}  ${alias(entry.ownerToken).padEnd(22)}${entry.id.slice(0, 8)}${entry.stored ? '' : '  *'}`;
  const out = [];
  out.push(`${entries.length} comics · ${entries.length - pending.length} already carry series data · ${pending.length} would get it (marked *)`);
  const multi = groups.filter((group) => group.comics > 1);
  const single = groups.filter((group) => group.comics === 1);
  out.push(`${groups.length} series: ${multi.length} with several issues or copies, ${single.length} with a single comic`);
  out.push('');
  for (const group of multi) {
    const branches = group.nodes.length - group.issues;
    out.push(`■ ${group.title} — ${group.issues} issue${group.issues === 1 ? '' : 's'}, ${group.comics} comics, ${group.pages} pages${branches > 0 ? `, ${branches} alternative continuation${branches === 1 ? '' : 's'}` : ''}`);
    for (const node of group.nodes) {
      const indent = '  '.repeat(node.depth);
      node.comics.forEach((entry, index) => out.push(`  ${line(entry, `${indent}${index === 0 ? `#${node.issue}` : '  copy'}`)}`));
      if (node.missingParent) out.push(`  ${indent}  ↑ the issue it continues no longer exists`);
    }
    out.push('');
  }
  if (single.length) {
    out.push('Single comics (no other issue, no copy):');
    for (const group of single) {
      const node = group.nodes[0];
      out.push(`  ${line(node.comics[0], `#${node.issue}`)}${node.missingParent ? '  (the issue it continues no longer exists)' : ''}`);
    }
  }
  return out.join('\n');
}
