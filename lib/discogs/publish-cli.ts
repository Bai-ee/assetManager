/**
 * Discogs -> X draft publisher (worker side). Thin CLI over lib/discogs/publish-run.ts.
 *
 *   npm run discogs:publish -- <dir> [--release <id> [--group <g-id>]] [--limit N] [--dry-run] [--force]
 *   --release alone also accepts a non-exact-catno plan whose best match is that release (owner override);
 *   --release + --group pins a review group to a release the owner identified by hand.
 *   --release + --video <file name> renders from that NAS video instead of the group's longest one
 *   (capture-time grouping can hand a label photo the NEXT record's video).
 *
 * Record selection: re-scan + group <dir>, then match each group to the saved plans in
 * ~/.discogs-ingest/runs/*-plan.json by group id (content fingerprint, so it survives NAS
 * renames; newest plan wins; shared-image-fingerprint fallback). Confident = best.reasons has
 * 'catno exact' and action add|already-owned. <dir> is READ-ONLY: videos are copied to
 * ~/.discogs-ingest/work/<releaseId>/ and rendered there.
 *
 * Speed: <dir> is scanned through ~/.discogs-ingest/index.json (unchanged files skip the SMB read + probe). The longest
 * video of each record is copied ONCE to ~/.discogs-ingest/src/<fingerprint>.<ext> (streamed, MB/s shown; an older
 * work/<id>/source.* is hard-linked instead) and every later step reads that local copy. While record N renders,
 * record N+1's source is copied in the background (1 copy + 1 render). Analysis is cached by fingerprint.
 *
 * --dry-run does the local steps for the FIRST eligible record only and makes no HITLOOP calls.
 * Options: --x-aspect 1x1|9x16, --clip-mode auto|beginning|break.
 * Env: DISCOGS_TOKEN, HITLOOP_ARCHIVE_CONTROL_URL, HITLOOP_ARCHIVE_WORKER_TOKEN (never logged).
 */
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { DiscogsClient } from './client.ts';
import { scanFolder, groupRecords, DEFAULT_INDEX_PATH } from './media.ts';
import { ASPECT_LIST, type Aspect, type ClipMode } from './video.ts';
import { CostLedger } from './cost.ts';
import { buildDraftBody, selectEligible, type VariantPaths } from './publish.ts';
import { publishPaths, loadPlansNewestFirst, readPublished, fetchSource, publishRecord, hitloop, logRunCost, reportUsage, mb, type LocalSource } from './publish-run.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--') && a !== arg('--release') && a !== arg('--group') && a !== arg('--video') && a !== arg('--limit') && a !== arg('--x-aspect') && a !== arg('--clip-mode'));
  if (!dir) { console.error('usage: discogs:publish <dir> [--release <id> [--group <g-id>]] [--limit N] [--dry-run] [--force] [--x-aspect 1x1|9x16] [--clip-mode auto|beginning|break]'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const releaseArg = arg('--release') ? Number(arg('--release')) : undefined;
  const groupArg = arg('--group') || undefined;
  const videoArg = arg('--video') || undefined;
  if (videoArg && releaseArg === undefined) throw new Error('--video needs --release');
  if (groupArg && releaseArg === undefined) throw new Error('--group needs --release');
  const limit = Number(arg('--limit') ?? Infinity);
  const xAspect = (arg('--x-aspect') ?? '1x1') as Aspect;
  if (!ASPECT_LIST.includes(xAspect)) throw new Error(`--x-aspect must be one of ${ASPECT_LIST.join(', ')}`);
  const clipMode = (arg('--clip-mode') ?? 'auto') as ClipMode;
  if (!['auto', 'beginning', 'break'].includes(clipMode)) throw new Error('--clip-mode must be auto, beginning or break');
  const ledger = new CostLedger();
  const log = (s: string) => console.log(s);

  const client = new DiscogsClient();
  if (!client.configured) throw new Error('DISCOGS_TOKEN missing');
  const paths = publishPaths();
  mkdirSync(paths.work, { recursive: true });

  const published = readPublished(paths);
  const plans = loadPlansNewestFirst(paths.runs);
  const tScan = Date.now();
  const scanned = await scanFolder(dir, { indexPath: DEFAULT_INDEX_PATH });
  const groups = groupRecords(scanned);
  const videoOverride = videoArg ? scanned.find(m => m.kind === 'video' && basename(m.path) === videoArg) : undefined;
  if (videoArg && !videoOverride) throw new Error(`--video ${videoArg} not found in ${dir}`);
  console.log(`scan: ${((Date.now() - tScan) / 1000).toFixed(1)}s (index ${DEFAULT_INDEX_PATH})`);
  const sel = selectEligible(groups, plans, new Set(published.map(p => p.releaseId)), { release: releaseArg, force, group: groupArg });
  if (videoOverride) { // a label-only group becomes renderable once the owner names its video
    const i = sel.noVideo.findIndex(r => r.releaseId === releaseArg);
    if (i >= 0) sel.eligible.push(...sel.noVideo.splice(i, 1));
  }
  console.log(`${groups.length} groups, ${plans.length} saved plan entries. eligible ${sel.eligible.length} | no video ${sel.noVideo.length} | already published ${sel.alreadyPublished.length}`);
  for (const r of sel.noVideo) console.log(`  skipped (no video): release ${r.releaseId} ${r.plan.best!.title}`);
  for (const id of sel.alreadyPublished) console.log(`  skipped (already published): release ${id}`);

  const todo = sel.eligible.slice(0, dryRun ? 1 : limit);
  if (!todo.length) { console.log('Nothing to publish.'); return; }

  const h = dryRun ? null : hitloop();
  const results: string[] = [];
  let ok = 0, failed = 0, createdCount = 0;
  // Prefetch: while record N renders, record N+1's source copies in the background (1 copy + 1 render at a time).
  const sources = new Map<number, Promise<LocalSource>>();
  const fetchAt = (i: number) => {
    if (i >= todo.length) return;
    if (!sources.has(i)) {
      const rec = todo[i];
      const p = fetchSource(rec, videoOverride, {
        paths, log,
        onCopyProgress: (c, t, rate) => process.stdout.write(`\r  [release ${rec.releaseId}] copy ${mb(c)} / ${mb(t)} @ ${rate.toFixed(1)} MB/s   `),
      });
      p.catch(() => {}); // the error is reported when record i is reached
      sources.set(i, p);
    }
  };
  for (const [i, rec] of todo.entries()) {
    const tag = `release ${rec.releaseId}`;
    try {
      fetchAt(i);
      const source = sources.get(i)!;
      fetchAt(i + 1);
      const r = await publishRecord(rec, { paths, client, ledger, clipMode, log, hitloop: h, xAspect, published, videoOverride, source });
      if (dryRun) {
        const p = r.prepared;
        const placeholder: VariantPaths = {
          video: { '9x16': '<from upload-url>', '1x1': '<from upload-url>' },
          image: { '9x16': '<from upload-url>', '1x1': '<from upload-url>' },
        };
        console.log(`  DRY RUN, would send draft payload (no HTTP calls; X aspect ${xAspect}):`);
        console.log(JSON.stringify(buildDraftBody(p.facts, placeholder, xAspect, { files: { images: [p.imageName], videos: [p.videoName] }, clip: p.clip }), null, 2));
        console.log(`  local files: ${[...Object.values(p.clipPaths), ...Object.values(p.imagePaths)].join(', ')}`);
      } else if (r.draft?.created) createdCount++;
      ok++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`${tag}: ${msg}`);
      console.error(`  [${tag}] FAILED: ${msg}`);
    }
  }

  logRunCost(paths, ledger, dir);
  if (!dryRun && ok > 0) await reportUsage(h!, paths, dir, ok, log);

  console.log(`\nSummary: ${ok} ${dryRun ? 'prepared' : 'published'} (${createdCount} new drafts) | ${failed} failed | ${sel.noVideo.length} no video | ${sel.alreadyPublished.length} already published`);
  for (const r of results) console.log(`  ${r}`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
