import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256File } from '../hash';
import { inferMediaType } from '../media-type';
import { BATCH_DISCOUNT, appendLedger, cacheKey, callCostUsd, estimateCallUsd, estimateRun, round6, withinCap } from './cost';
import { withEventDates } from './event-date';
import { DEFAULT_MODEL, PROMPT_VERSION, sanitizeAnalysis } from './schema';
import { resolveUnder, type ReadOnlyStore } from './store';
import { CONTENT_DIR, organizeCopy } from './nas';
import type { PrepareMedia } from './media';
import type { Vision } from './vision';
import { runAnalyzeBatch } from './batch';
import { DoneIndex, type DirListing } from './done-index';
import type { AnalyzerControl, Cmd, ResultItem } from './control';

export const HOME_DIR = process.env.ARCHIVE_ANALYZER_HOME || path.join(os.homedir(), '.archive-analyzer');
const PUSH_BATCH = 10;
const PROGRESS_EVERY = 5;

export interface WalkedFile { relativePath: string; abs: string; kind: 'image' | 'video'; sizeBytes: number; mtimeMs: number }

export interface WalkIndex { dirs: Record<string, DirListing>; setDir: (rel: string, l: DirListing) => void }
type ListingEntry = DirListing['entries'][number];

/**
 * Media-only walk under the source root. Skips dotfiles/AppleDouble, symlinks and paths escaping the root.
 * With `index` (and not `verify`), a directory whose own mtime matches its stored listing is not re-listed and its files
 * are not lstat'ed: one stat per directory instead of one per file. Adding/removing/renaming entries changes a
 * directory's mtime; an in-place edit of a file does not, so `verify` forces the full per-file walk.
 */
export function walkMedia(root: string, paths: string[], opts: { index?: WalkIndex; verify?: boolean } = {}): WalkedFile[] {
  const out = new Map<string, WalkedFile>();
  const relOf = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const addFile = (abs: string, sizeBytes: number, mtimeMs: number): ListingEntry | null => {
    const kind = inferMediaType(path.basename(abs));
    if (kind !== 'image' && kind !== 'video') return null;
    const rel = relOf(abs);
    out.set(rel, { relativePath: rel, abs, kind, sizeBytes, mtimeMs });
    return { name: path.basename(abs), kind: 'file', sizeBytes, mtimeMs };
  };
  const visit = (abs: string): ListingEntry | null => {
    const base = path.basename(abs);
    if (base.startsWith('.')) return null;
    if (relOf(abs) === CONTENT_DIR) return null; // our own organized copies
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return null; }
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) {
      const rel = relOf(abs);
      const known = opts.index && !opts.verify ? opts.index.dirs[rel] : undefined;
      if (known && known.mtimeMs === st.mtimeMs) {
        for (const e of known.entries) {
          if (e.kind === 'dir') visit(path.join(abs, e.name));
          else addFile(path.join(abs, e.name), e.sizeBytes, e.mtimeMs);
        }
      } else {
        const entries: ListingEntry[] = [];
        for (const e of fs.readdirSync(abs).sort()) { const r = visit(path.join(abs, e)); if (r) entries.push(r); }
        opts.index?.setDir(rel, { mtimeMs: st.mtimeMs, entries });
      }
      return { name: base, kind: 'dir' };
    }
    if (!st.isFile()) return null;
    return addFile(abs, st.size, st.mtimeMs);
  };
  for (const p of paths.length ? paths : ['.']) {
    const abs = resolveUnder(root, p);
    if (!abs) throw new Error(`Path escapes source root: ${p}`);
    visit(abs);
  }
  return Array.from(out.values());
}

export interface AnalyzeDeps {
  store: Pick<ReadOnlyStore, 'getSource' | 'knownFile'>;
  control: Pick<AnalyzerControl, 'update' | 'pushResults'>;
  vision: Vision | null;
  prepare: PrepareMedia;
  isCancelled: (commandId: string) => boolean;
  cacheDir?: string;
  thumbDir?: string;
  ledgerPath?: string;
  hashFile?: (p: string) => Promise<string>;
  /** Copy analyzed files into HITLOOP-ARCHIVE/content (default true). */
  organize?: boolean;
  /** Batch mode only: API key + injected fetch, poll interval (default 20s), batches.json location. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  batchesPath?: string;
  /** Mac-local done index (default: next to cacheDir, i.e. ARCHIVE_ANALYZER_HOME/done-index.json). */
  indexPath?: string;
}

type CachedEntry = Omit<ResultItem, 'relativePath' | 'costUsd'>;

export function readCache(dir: string, key: string): CachedEntry | null {
  let entry: CachedEntry;
  try { entry = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as CachedEntry; } catch { return null; }
  // Old cache entries predate the event-date fields: compute them from the stored OCR text (free, no model call).
  const f = entry?.facets as (Parameters<typeof withEventDates>[0] & { eventDateRaw?: unknown }) | undefined;
  if (f && typeof f.ocrText === 'string' && f.eventDateRaw === undefined) entry = { ...entry, facets: withEventDates(f) };
  return entry;
}

/** Everything the cost ledger knows: relativePath -> sha256 (newest line wins) and the real USD of each billed call. Missing/garbled ledger = empty. */
export function readLedger(ledgerPath: string): { shaByPath: Map<string, string>; usd: number[] } {
  const shaByPath = new Map<string, string>(); const usd: number[] = [];
  let text = '';
  try { text = fs.readFileSync(ledgerPath, 'utf8'); } catch { return { shaByPath, usd }; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const l = JSON.parse(line) as { relativePath?: unknown; sha256?: unknown; usd?: unknown };
      if (typeof l.relativePath === 'string' && typeof l.sha256 === 'string') shaByPath.set(l.relativePath, l.sha256);
      if (typeof l.usd === 'number' && !(l as { batch?: unknown }).batch && l.usd > 0 && Number.isFinite(l.usd)) usd.push(l.usd);
    } catch { /* skip a torn line */ }
  }
  return { shaByPath, usd };
}

/** Real average cost per analyzed file once there are enough samples; the rate-card guess before that. */
export const MIN_MEASURED_SAMPLES = 20;
export function perFileUsd(model: string, billed: number[]): { usd: number; basis: 'measured' | 'rate-card'; samples: number } {
  if (billed.length >= MIN_MEASURED_SAMPLES) return { usd: round6(billed.reduce((a, c) => a + c, 0) / billed.length), basis: 'measured', samples: billed.length };
  return { usd: estimateCallUsd(model), basis: 'rate-card', samples: billed.length };
}

/** Known hash only if the worker's recorded size+mtime still match the file on disk. */
function knownSha(deps: AnalyzeDeps, sourceId: string, f: WalkedFile): string | null {
  const k = deps.store.knownFile(sourceId, f.relativePath);
  return k && k.sizeBytes === f.sizeBytes && Math.abs(k.modifiedAtMs - f.mtimeMs) < 1 ? k.sha256 : null;
}

export async function runAnalyze(cmd: Cmd, deps: AnalyzeDeps): Promise<Record<string, unknown>> {
  const cacheDir = deps.cacheDir ?? path.join(HOME_DIR, 'cache');
  const thumbDir = deps.thumbDir ?? path.join(HOME_DIR, 'thumbs');
  const ledgerPath = deps.ledgerPath ?? path.join(HOME_DIR, 'cost.jsonl');
  const hashFile = deps.hashFile ?? sha256File;
  const model = cmd.model || DEFAULT_MODEL;
  const promptVersion = cmd.promptVersion || PROMPT_VERSION;
  const capUsd = typeof cmd.capUsd === 'number' && cmd.capUsd >= 0 ? cmd.capUsd : 5;
  if (!cmd.sourceId) throw new Error('ANALYZE_FACETS requires sourceId');
  const source = deps.store.getSource(cmd.sourceId);
  if (!source) throw new Error(`Unknown source ${cmd.sourceId}`);

  // verify: ignore the done index (full per-file walk, hash/organize/push checks) and refresh it.
  const verify = cmd.verify === true;
  const doneIndex = new DoneIndex(deps.indexPath ?? path.join(path.dirname(cacheDir), 'done-index.json'));
  const walkIndex = { dirs: doneIndex.source(source.id).dirs, setDir: (rel: string, l: DirListing) => doneIndex.setDir(source.id, rel, l) };
  let files: WalkedFile[];
  try { files = walkMedia(source.rootPath, Array.isArray(cmd.paths) ? cmd.paths : [], { index: walkIndex, verify }); }
  finally { doneIndex.save(); }

  if (cmd.dryRun) {
    // A file counts as already analyzed when its hash is known to the worker DB, OR when the cost ledger
    // recorded it by path and its cache entry still exists. Hashing every file over SMB just to estimate is too slow.
    const ledger = readLedger(ledgerPath);
    let cached = 0;
    for (const f of files) {
      const sha = knownSha(deps, source.id, f) ?? ledger.shaByPath.get(f.relativePath) ?? null;
      if (sha && fs.existsSync(path.join(cacheDir, `${cacheKey(sha, promptVersion, model)}.json`))) cached++;
    }
    const base = estimateRun(model, { images: files.filter(f => f.kind === 'image').length, videos: files.filter(f => f.kind === 'video').length, cached });
    // A video is one composed 2x2 frame grid, so it is priced like an image.
    const unit = perFileUsd(model, ledger.usd);
    const billable = Math.max(0, base.files - base.cached);
    if (cmd.batch) return { estimate: { ...base, estUsd: round6(billable * unit.usd * BATCH_DISCOUNT), perFileUsd: round6(unit.usd * BATCH_DISCOUNT), basis: unit.basis, samples: unit.samples, batch: true } };
    return { estimate: { ...base, estUsd: round6(billable * unit.usd), perFileUsd: unit.usd, basis: unit.basis, samples: unit.samples } };
  }
  if (cmd.batch) {
    if (!deps.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(thumbDir, { recursive: true });
    const led = readLedger(ledgerPath);
    const ledger = { shaByPath: led.shaByPath, unit: perFileUsd(model, led.usd).usd * BATCH_DISCOUNT };
    try {
      return await runAnalyzeBatch(cmd, deps, {
        source, files, cacheDir, thumbDir, ledgerPath, hashFile, model, promptVersion, capUsd,
        batchesPath: deps.batchesPath ?? path.join(HOME_DIR, 'batches.json'),
        unitUsd: ledger.unit,
        ledgerShaByPath: ledger.shaByPath,
        readCache, knownSha: f => knownSha(deps, source.id, f),
        pushBatch: PUSH_BATCH,
        doneIndex, verify,
      });
    } finally { doneIndex.save(); }
  }
  if (!deps.vision) throw new Error('ANTHROPIC_API_KEY is not set');

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  let spentUsd = 0, done = 0, cachedCount = 0, pushed = 0;
  let cappedAt: string | undefined;
  let cancelled = false;
  let organizeErrors = 0;
  const errors: Array<{ relativePath: string; error: string }> = [];
  let batch: ResultItem[] = [];

  const flush = async () => {
    if (!batch.length) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await deps.control.pushResults(source.id, batch); pushed += batch.length; batch = []; return; }
      catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
    }
    throw new Error(`Pushing results failed (analysis is cached locally; re-run is free): ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  };
  const progress = () => deps.control.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: { done, total: files.length, spentUsd: round6(spentUsd) } } }).catch(() => undefined);

  for (const f of files) {
    if (deps.isCancelled(cmd.id)) { cancelled = true; break; }
    try {
      const sha = knownSha(deps, source.id, f) ?? await hashFile(f.abs);
      const key = cacheKey(sha, promptVersion, model);
      let entry = readCache(cacheDir, key);
      let costUsd = 0;
      if (entry) {
        cachedCount++;
      } else {
        if (!withinCap(spentUsd, model, capUsd)) { cappedAt = f.relativePath; break; }
        const prepared = await deps.prepare(f.abs, f.kind);
        const { raw, usage } = await deps.vision(prepared.jpeg, f.relativePath, f.kind);
        costUsd = round6(callCostUsd(model, usage));
        spentUsd += costUsd;
        appendLedger(ledgerPath, { at: new Date().toISOString(), sha256: sha, relativePath: f.relativePath, model, promptVersion, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usd: costUsd });
        const s = sanitizeAnalysis(raw, { relativePath: f.relativePath });
        fs.writeFileSync(path.join(thumbDir, `${sha}.jpg`), prepared.thumb);
        entry = {
          sha256: sha, mediaType: f.kind, width: prepared.width, height: prepared.height,
          ...(prepared.durationSec != null ? { durationSec: prepared.durationSec } : {}),
          capturedAt: prepared.capturedAt ?? new Date(f.mtimeMs).toISOString(),
          facets: s.facets, summary: s.summary, activity: s.activity, peopleCount: s.peopleCount, jev: s.jev, model, promptVersion,
        };
        fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(entry));
      }
      let organizedPath: string | undefined;
      if (deps.organize !== false) {
        try { organizedPath = await organizeCopy({ rootPath: source.rootPath, sourceId: source.id, sha256: sha, originalAbs: f.abs, originalRelativePath: f.relativePath, entry: entry as any, thumbDir, hashFile }); }
        catch { organizeErrors++; }
      }
      batch.push({ ...entry, relativePath: f.relativePath, costUsd, ...(organizedPath ? { organizedPath } : {}) });
      if (batch.length >= PUSH_BATCH) await flush();
    } catch (e) {
      errors.push({ relativePath: f.relativePath, error: e instanceof Error ? e.message : String(e) });
    }
    done++;
    if (done % PROGRESS_EVERY === 0) await progress();
  }
  await flush();
  return { done, total: files.length, spentUsd: round6(spentUsd), cached: cachedCount, pushed, errors: errors.slice(0, 50), errorCount: errors.length, organizeErrors, ...(cappedAt ? { cappedAt } : {}), ...(cancelled ? { cancelled: true } : {}) };
}
