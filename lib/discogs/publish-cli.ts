/**
 * Discogs -> X draft publisher (worker side).
 *
 *   npm run discogs:publish -- <dir> [--release <id>] [--limit N] [--dry-run] [--force]
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
 * Per record: longest video -> analyze -> pickClip(60, auto|beginning|break) -> vision framing ->
 * clip-9x16.mp4 + clip-1x1.mp4 (look 'rich'); label1 -> label-9x16.jpg + label-1x1.jpg; facts from
 * Discogs; upload all four to HITLOOP (variant in the upload-url body), create the draft (legacy
 * paths = the --x-aspect variant, default 1x1), record in ~/.discogs-ingest/published.json.
 * --dry-run does the local steps for the FIRST eligible record only and makes no HITLOOP calls.
 * Options: --x-aspect 1x1|9x16, --clip-mode auto|beginning|break.
 * Env: DISCOGS_TOKEN, HITLOOP_ARCHIVE_CONTROL_URL, HITLOOP_ARCHIVE_WORKER_TOKEN (never logged).
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { DiscogsClient } from './client.ts';
import { scanFolder, groupRecords, ensureLocalSource, DEFAULT_INDEX_PATH, type ScannedMedia } from './media.ts';
import { analyzeVideo, pickClip, renderClip, gradeImage, labelToJpeg, frameVideo, frameLabel, probeDuration, DEFAULT_LOOK, ASPECT_LIST, type Aspect, type ClipMode, type FramingDecision } from './video.ts';
import { CostLedger, appendCostLog, readCostLog } from './cost.ts';
import { buildDraftBody, releaseFacts, selectEligible, unreportedCost, type EligibleRecord, type VariantPaths } from './publish.ts';
import type { GroupPlan } from './types.ts';

const HOME = join(homedir(), '.discogs-ingest');
const RUNS = join(HOME, 'runs');
const WORK = join(HOME, 'work');
const SRC_CACHE = join(HOME, 'src');
const PUBLISHED = join(HOME, 'published.json');
const USAGE_REPORTED = join(HOME, 'usage-reported.json');
const COST_LOG = join(HOME, 'costs.jsonl');
const CLIP_SECONDS = 60;
const MAX_CLIP_BYTES = 512 * 1024 * 1024;
const MAX_CLIP_SECONDS = 140;
const LOOK = DEFAULT_LOOK;
const CACHE = join(HOME, 'cache');

interface PublishedEntry { releaseId: number; postId: string; packageId: string; at: string; clip: { start: number; end: number; look: string } }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const readJson = <T>(p: string, fallback: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; } };
const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MB';

function loadPlansNewestFirst(): GroupPlan[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS).filter(f => f.endsWith('-plan.json')).sort().reverse()
    .flatMap(f => readJson<GroupPlan[]>(join(RUNS, f), []));
}

interface Prepared {
  facts: ReturnType<typeof releaseFacts>;
  clipPaths: Record<Aspect, string>;
  imagePaths: Record<Aspect, string>;
  clip: { start: number; end: number; look: string };
  videoName: string; imageName: string;
  clipBytes: Record<Aspect, number>; clipSeconds: number; imageBytes: Record<Aspect, number>; reason: string;
  videoFraming: FramingDecision; imageFraming: FramingDecision;
  timings: Record<string, number>;
}

const framingLine = (f: FramingDecision, a: Aspect) =>
  `${a}: ${f.plans[a].mode} (${f.plans[a].note}) | subject=${f.subject.kind}`;

interface LocalSource { video: ScannedMedia; local: string; fingerprint: string; copySeconds: number }

/** Longest video of the record (duration from the scan index) -> local copy in the source cache. Never re-copies. */
async function fetchSource(rec: EligibleRecord): Promise<LocalSource> {
  const vids = rec.group.videos as ScannedMedia[];
  const dur = (v: ScannedMedia) => v.durationS ?? 0;
  const video = [...vids].sort((a, b) => dur(b) - dur(a) || b.size - a.size)[0];
  const legacyDir = join(WORK, String(rec.releaseId));
  const legacyPaths = existsSync(legacyDir) ? readdirSync(legacyDir).filter(n => n.startsWith('source.')).map(n => join(legacyDir, n)) : [];
  const r = await ensureLocalSource(video, SRC_CACHE, {
    legacyPaths,
    onProgress: (c, t, rate) => process.stdout.write(`\r  [release ${rec.releaseId}] copy ${mb(c)} / ${mb(t)} @ ${rate.toFixed(1)} MB/s   `),
  });
  if (r.via === 'copy') console.log(`\n  [release ${rec.releaseId}] copied ${mb(r.bytes)} from the NAS in ${r.seconds.toFixed(1)}s (${r.mbPerSec.toFixed(1)} MB/s) -> ${r.path}`);
  else console.log(`  [release ${rec.releaseId}] source ${r.via === 'link' ? 'reused from the older work copy' : 'already in the local cache'}: ${r.path}`);
  return { video, local: r.path, fingerprint: video.fingerprint, copySeconds: r.via === 'copy' ? r.seconds : 0 };
}

async function prepare(rec: EligibleRecord, src: LocalSource, client: DiscogsClient, ledger: CostLedger, clipMode: ClipMode): Promise<Prepared> {
  const timings: Record<string, number> = { copy: src.copySeconds };
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try { return await fn(); } finally { timings[name] = (Date.now() - t0) / 1000; }
  };
  const dir = join(WORK, String(rec.releaseId));
  mkdirSync(dir, { recursive: true });
  const { local } = src;
  const clipPaths = { '9x16': join(dir, 'clip-9x16.mp4'), '1x1': join(dir, 'clip-1x1.mp4') };
  const imagePaths = { '9x16': join(dir, 'label-9x16.jpg'), '1x1': join(dir, 'label-1x1.jpg') };

  // Discogs facts + label photo work are independent of the video render: run them alongside it.
  const factsP = client.getRelease(rec.releaseId).then(releaseFacts);
  const labelImg = rec.group.images[0];
  const labelP = (async () => {
    const labelJpg = join(dir, 'label-src.jpg');
    await timed('label-jpeg', () => labelToJpeg(labelImg.path, labelJpg));
    const imageFraming = await timed('label-framing', () => frameLabel(labelJpg, { cacheDir: CACHE, ledger, name: `${rec.releaseId}/label`, workDir: dir }));
    await timed('label-grade', () => Promise.all(ASPECT_LIST.map(a => gradeImage(labelJpg, imagePaths[a], LOOK, imageFraming.plans[a], a))));
    return imageFraming;
  })();

  const analysis = await timed('analysis', () => analyzeVideo(local, { cacheFile: join(CACHE, `analysis-${src.fingerprint}.json`) }));
  const clip = pickClip(analysis, { length: CLIP_SECONDS, mode: clipMode });
  const videoFraming = await timed('framing', () => frameVideo(local, clip, { cacheDir: CACHE, ledger, name: `${rec.releaseId}/video`, workDir: join(dir, 'frames'), fingerprint: src.fingerprint }));
  const rendered = await timed('render', () => renderClip(local, clipPaths, clip, LOOK, videoFraming.plans));
  console.log(`  render: ${rendered.encoder}, ${rendered.chunks} parallel chunk(s)`);
  const [imageFraming, facts] = await Promise.all([labelP, factsP]);

  const clipBytes = { '9x16': statSync(clipPaths['9x16']).size, '1x1': statSync(clipPaths['1x1']).size };
  const clipSeconds = await probeDuration(clipPaths['1x1']);
  for (const a of ASPECT_LIST) {
    if (clipBytes[a] >= MAX_CLIP_BYTES) throw new Error(`clip-${a}.mp4 is ${mb(clipBytes[a])} (limit 512 MB)`);
  }
  if (clipSeconds > MAX_CLIP_SECONDS) throw new Error(`clip is ${clipSeconds.toFixed(1)} s (limit ${MAX_CLIP_SECONDS} s)`);

  return { facts, clipPaths, imagePaths, clip: { start: clip.start, end: clip.end, look: LOOK },
    videoName: src.video.name, imageName: labelImg.name, clipBytes, clipSeconds,
    imageBytes: { '9x16': statSync(imagePaths['9x16']).size, '1x1': statSync(imagePaths['1x1']).size },
    reason: clip.reason, videoFraming, imageFraming, timings };
}

// ---- HITLOOP ----
function hitloop() {
  const base = process.env.HITLOOP_ARCHIVE_CONTROL_URL?.replace(/\/+$/, '');
  const token = process.env.HITLOOP_ARCHIVE_WORKER_TOKEN;
  if (!base || !token) throw new Error('HITLOOP_ARCHIVE_CONTROL_URL and HITLOOP_ARCHIVE_WORKER_TOKEN must be set');
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${base}/api/archive/worker/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HITLOOP ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  return { post };
}

async function uploadFile(h: ReturnType<typeof hitloop>, releaseId: number, kind: 'video' | 'image', variant: Aspect, file: string): Promise<string> {
  const contentType = kind === 'video' ? 'video/mp4' : 'image/jpeg';
  const u = await h.post<{ uploadUrl: string; storagePath: string; headers?: Record<string, string> }>(
    'discogs/upload-url', { releaseId, kind, variant, contentType });
  const size = statSync(file).size;
  const res = await fetch(u.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...(u.headers ?? {}), 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
    // @ts-expect-error Node fetch requires duplex for streamed bodies
    duplex: 'half',
  });
  if (res.status !== 200) throw new Error(`upload PUT (${kind} ${variant}) failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return u.storagePath;
}

async function main() {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--') && a !== arg('--release') && a !== arg('--limit') && a !== arg('--x-aspect') && a !== arg('--clip-mode'));
  if (!dir) { console.error('usage: discogs:publish <dir> [--release <id>] [--limit N] [--dry-run] [--force] [--x-aspect 1x1|9x16] [--clip-mode auto|beginning|break]'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const releaseArg = arg('--release') ? Number(arg('--release')) : undefined;
  const limit = Number(arg('--limit') ?? Infinity);
  const xAspect = (arg('--x-aspect') ?? '1x1') as Aspect;
  if (!ASPECT_LIST.includes(xAspect)) throw new Error(`--x-aspect must be one of ${ASPECT_LIST.join(', ')}`);
  const clipMode = (arg('--clip-mode') ?? 'auto') as ClipMode;
  if (!['auto', 'beginning', 'break'].includes(clipMode)) throw new Error('--clip-mode must be auto, beginning or break');
  const ledger = new CostLedger();

  const client = new DiscogsClient();
  if (!client.configured) throw new Error('DISCOGS_TOKEN missing');
  mkdirSync(WORK, { recursive: true });

  const published = readJson<PublishedEntry[]>(PUBLISHED, []);
  const plans = loadPlansNewestFirst();
  const tScan = Date.now();
  const groups = groupRecords(await scanFolder(dir, { indexPath: DEFAULT_INDEX_PATH }));
  console.log(`scan: ${((Date.now() - tScan) / 1000).toFixed(1)}s (index ${DEFAULT_INDEX_PATH})`);
  const sel = selectEligible(groups, plans, new Set(published.map(p => p.releaseId)), { release: releaseArg, force });
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
      const p = fetchSource(todo[i]);
      p.catch(() => {}); // the error is reported when record i is reached
      sources.set(i, p);
    }
  };
  for (const [i, rec] of todo.entries()) {
    const tag = `release ${rec.releaseId}`;
    try {
      const tRec = Date.now();
      fetchAt(i);
      const src = await sources.get(i)!;
      fetchAt(i + 1);
      const p = await prepare(rec, src, client, ledger, clipMode);
      console.log(`\n[${tag}] ${p.facts.artist} - ${p.facts.title} | ${p.facts.label} ${p.facts.catno}`);
      console.log(`  source video: ${p.videoName}`);
      console.log(`  clip: ${p.clip.start}s-${p.clip.end}s look=${p.clip.look}\n    ${p.reason}`);
      for (const a of ASPECT_LIST) console.log(`  video framing ${framingLine(p.videoFraming, a)}`);
      for (const a of ASPECT_LIST) console.log(`  label framing ${framingLine(p.imageFraming, a)}`);
      console.log(`  clip-9x16.mp4 ${mb(p.clipBytes['9x16'])} | clip-1x1.mp4 ${mb(p.clipBytes['1x1'])} | ${p.clipSeconds.toFixed(1)}s`
        + ` | label-9x16.jpg ${mb(p.imageBytes['9x16'])} | label-1x1.jpg ${mb(p.imageBytes['1x1'])} (${p.imageName})`);
      const total = (Date.now() - tRec) / 1000;
      console.log(`  timings (s): ${Object.entries(p.timings).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' | ')} | total ${total.toFixed(1)} (copy overlaps the previous record's render when prefetched)`);
      const files = { images: [p.imageName], videos: [p.videoName] };
      if (dryRun) {
        const placeholder: VariantPaths = {
          video: { '9x16': '<from upload-url>', '1x1': '<from upload-url>' },
          image: { '9x16': '<from upload-url>', '1x1': '<from upload-url>' },
        };
        console.log(`  DRY RUN, would send draft payload (no HTTP calls; X aspect ${xAspect}):`);
        console.log(JSON.stringify(buildDraftBody(p.facts, placeholder, xAspect, { files, clip: p.clip }), null, 2));
        console.log(`  local files: ${[...Object.values(p.clipPaths), ...Object.values(p.imagePaths)].join(', ')}`);
        ok++;
        continue;
      }
      const variants: VariantPaths = {
        video: { '9x16': '', '1x1': '' },
        image: { '9x16': '', '1x1': '' },
      };
      for (const a of ASPECT_LIST) variants.video[a] = await uploadFile(h!, rec.releaseId, 'video', a, p.clipPaths[a]);
      for (const a of ASPECT_LIST) variants.image[a] = await uploadFile(h!, rec.releaseId, 'image', a, p.imagePaths[a]);
      const draft = await h!.post<{ postId: string; packageId: string; created: boolean; mediaUrl?: string; replyMediaUrl?: string }>(
        'discogs/draft', buildDraftBody(p.facts, variants, xAspect, { files, clip: p.clip }));
      const entry: PublishedEntry = { releaseId: rec.releaseId, postId: draft.postId, packageId: draft.packageId, at: new Date().toISOString(), clip: p.clip };
      const idx = published.findIndex(x => x.releaseId === rec.releaseId);
      if (idx >= 0) published[idx] = entry; else published.push(entry);
      writeFileSync(PUBLISHED, JSON.stringify(published, null, 2));
      if (draft.created) createdCount++;
      console.log(`  draft ${draft.created ? 'created' : 'already existed'}: post ${draft.postId}, package ${draft.packageId}`);
      ok++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`${tag}: ${msg}`);
      console.error(`  [${tag}] FAILED: ${msg}`);
    }
  }

  // Persist this run's framing vision calls (dry runs too: the spend is real and is reported with the next real publish).
  const ls = ledger.summary();
  if (ls.calls) appendCostLog(COST_LOG, { runId: `publish-${new Date().toISOString().replace(/[:.]/g, '-')}`, folder: dir, ...ls });

  // Report vision cost for this folder once per run (only after real publishing).
  if (!dryRun && ok > 0) {
    const reported = new Set(readJson<string[]>(USAGE_REPORTED, []));
    const cost = unreportedCost(readCostLog(COST_LOG), dir, reported);
    if (cost) {
      try {
        await h!.post('usage', {
          module: 'discogs-ingest', action: 'publish-run', provider: 'anthropic', model: 'claude-sonnet-5-5',
          calls: cost.calls, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, costUsd: cost.costUsd,
          runId: cost.runIds[cost.runIds.length - 1], metadata: { records: ok, folder: dir },
        });
        writeFileSync(USAGE_REPORTED, JSON.stringify(Array.from(reported).concat(cost.runIds), null, 2));
        console.log(`\nUsage reported: $${cost.costUsd} (${cost.calls} vision calls)`);
      } catch (e) {
        console.error(`usage report failed (will retry next run): ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log(`\nSummary: ${ok} ${dryRun ? 'prepared' : 'published'} (${createdCount} new drafts) | ${failed} failed | ${sel.noVideo.length} no video | ${sel.alreadyPublished.length} already published`);
  for (const r of results) console.log(`  ${r}`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
