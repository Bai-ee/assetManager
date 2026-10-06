/** Read-only: npx tsx lib/discogs/scan-cli.ts <dir> — prints record groups as a table. */
import { scanFolder, groupRecords, bestTime } from './media';

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: scan-cli.ts <dir>');
    process.exit(1);
  }
  const files = await scanFolder(dir);
  const groups = groupRecords(files);
  const dups = files.filter((f) => f.duplicateOf).length;
  const withTime = (k: string) => files.filter((f) => f.kind === k && f.capturedAt).length;
  const count = (k: string) => files.filter((f) => f.kind === k).length;
  console.log(`files=${files.length} images=${count('image')} (time ${withTime('image')}) videos=${count('video')} (time ${withTime('video')}) duplicates=${dups} groups=${groups.length}`);
  const rows = groups.map((g) => ({
    id: g.id,
    images: g.images.map((f) => f.name).join(', '),
    videos: g.videos.map((f) => f.name).join(', '),
    by: g.groupedBy,
    time: new Date(Math.min(...[...g.images, ...g.videos].map(bestTime))).toLocaleString('sv'),
  }));
  console.table(rows);
}
main();
