// Gives the comics made before series existed their series data (see series.mjs).
//   node migrateSeries.mjs [stories folder]            shows what it would do and changes nothing
//   node migrateSeries.mjs [stories folder] --apply    writes it
// Only the `series` field is added: pages, dates and version stay as they are. Apply it while no comic is being drawn.
import { randomBytes } from 'node:crypto';
import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ownerAlias } from './alias.ts';
import { planSeries, seriesEntry, seriesReport } from './series.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const folder = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(process.cwd(), '.data', 'stories'));
const isStoryFile = (name) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name);

const files = (await readdir(folder)).filter(isStoryFile);
const entries = [];
const stamps = new Map();
for (const name of files) {
  const path = join(folder, name);
  const before = await stat(path);
  const record = JSON.parse(await readFile(path, 'utf8'));
  if (record?.id !== name.slice(0, -5)) { console.error(`Skipped ${name}: its id does not match the file name.`); continue; }
  entries.push(seriesEntry(record));
  stamps.set(record.id, before.mtimeMs);
}

console.log(`Stories folder: ${folder}`);
console.log(seriesReport(entries, { alias: (token) => (token ? ownerAlias(token) : '') }));

if (!apply) {
  console.log('\nNothing was changed. Run again with --apply to write the series data.');
} else {
  const plan = planSeries(entries);
  let written = 0;
  for (const entry of entries.filter((item) => !item.stored)) {
    const path = join(folder, `${entry.id}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.series = plan.get(entry.id);
    const temporary = join(folder, `.${entry.id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      // The server may have saved a new page meanwhile: leave that comic for the next run rather than overwrite it.
      if ((await stat(path)).mtimeMs !== stamps.get(entry.id)) {
        console.error(`Skipped ${entry.id}: it changed while migrating. Run again.`);
        await rm(temporary, { force: true });
        continue;
      }
      await rename(temporary, path);
      written += 1;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  console.log(`\nSeries data written to ${written} comics.`);
}
