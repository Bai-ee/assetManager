/**
 * npm run photolib -- <plan|apply|undo|thumbs|push|status> (--library <abs bundle> | --folder <abs dir>) [--dest-root /Volumes/bryan] [--source-id id]
 *   [--limit N] [--plan <planId>] [--run <runId>] [--force] [--json]
 *   plan/apply with --folder also: [--files <txt of absolute paths>] (plan only those files). A --folder outside --dest-root
 *   (an attached drive) is allowed in copy mode; its paths are recorded as "ext:<path below /Volumes>".
 *   apply also: [--mode copy|move] [--photos-db <Photos.sqlite>]  — full metadata (exiftool dump + XMP sidecars + optional
 *   Photos-library record) is always captured to timeline/_meta before a file is copied, moved or a raw duplicate deleted.
 * Pure helpers are exported for tests; main() only runs when this file is executed directly.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LibraryKind } from './types';

export const COMMANDS = ['plan', 'apply', 'undo', 'thumbs', 'push', 'status'] as const;
export type CliCommand = (typeof COMMANDS)[number];
export const DEFAULT_DEST_ROOT = '/Volumes/bryan';

export interface CliArgs {
  command: CliCommand;
  library?: string;
  folder?: string;
  destRoot: string;
  sourceId?: string;
  limit?: number;
  plan?: string;
  run?: string;
  force: boolean;
  json: boolean;
  /** apply: 'move' renames folder-source files into the timeline and deletes verified raw duplicates. */
  mode: 'copy' | 'move';
  /** apply: Photos.sqlite of the library the folder was downloaded from (copied to a temp dir before reading). */
  photosDb?: string;
  /** plan/apply --folder: text file of absolute paths to plan instead of walking the folder. */
  files?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) throw new Error(`Usage: photolib <${COMMANDS.join('|')}> [options] (got ${command ?? 'nothing'})`);
  const out: CliArgs = { command: command as CliCommand, destRoot: DEFAULT_DEST_ROOT, force: false, json: false, mode: 'copy' };
  const value = (i: number, flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--library': out.library = value(i, a); i++; break;
      case '--folder': out.folder = value(i, a); i++; break;
      case '--dest-root': out.destRoot = value(i, a); i++; break;
      case '--source-id': out.sourceId = value(i, a); i++; break;
      case '--plan': out.plan = value(i, a); i++; break;
      case '--run': out.run = value(i, a); i++; break;
      case '--limit': {
        const n = Number(value(i, a)); i++;
        if (!Number.isInteger(n) || n < 1) throw new Error('--limit must be a positive whole number');
        out.limit = n; break;
      }
      case '--mode': {
        const m = value(i, a); i++;
        if (m !== 'copy' && m !== 'move') throw new Error('--mode must be copy or move');
        out.mode = m; break;
      }
      case '--photos-db': out.photosDb = value(i, a); i++; break;
      case '--files': out.files = value(i, a); i++; break;
      case '--force': out.force = true; break;
      case '--json': out.json = true; break;
      default: throw new Error(`Unknown argument ${a}`);
    }
  }
  if (out.library && out.folder) throw new Error('--library and --folder are mutually exclusive');
  if ((out.mode === 'move' || out.photosDb) && out.command !== 'apply') throw new Error('--mode / --photos-db only apply to the apply command');
  if (out.photosDb && !isAbsolute(out.photosDb)) throw new Error('--photos-db must be an absolute path');
  if (out.files && !out.folder) throw new Error('--files needs --folder (the root the listed files sit under)');
  return out;
}

const stripSlash = (p: string) => p.replace(/[\\/]+$/, '');

/** Recognised bundle by name, else null. */
export function libraryKindOf(libraryPath: string): LibraryKind | null {
  const name = basename(stripSlash(libraryPath));
  if (/\.(photoslibrary|migratedphotolibrary)$/i.test(name)) return 'photos';
  if (/\.photolibrary$/i.test(name) || name === 'iPhoto Library') return 'iphoto';
  return null;
}

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'library';
}

/** photos-<slug of bundle parent folder>; iphoto-<slug of the grandparent of 'iPhoto Library' (bundle parent for *.photolibrary)>. */
export function deriveSourceId(libraryPath: string): string {
  const abs = stripSlash(resolve(libraryPath));
  const kind = libraryKindOf(abs);
  if (!kind) throw new Error('Not a recognised library bundle (.photoslibrary, .migratedphotolibrary, .photolibrary, iPhoto Library)');
  const parent = dirname(abs);
  if (kind === 'photos') return `photos-${slug(basename(parent))}`;
  return `iphoto-${slug(basename(basename(abs) === 'iPhoto Library' ? dirname(parent) : parent))}`;
}

/** Folder source id: folder-<slug of the share-relative path>, or ext-<slug of the path below /Volumes> for an attached drive. */
export function deriveFolderSourceId(folderPath: string, destRoot: string): string {
  const rel = shareRelative(destRoot, folderPath);
  if (rel === null) return `ext-${slug(resolve(folderPath).replace(/^\/Volumes\//, '').split(sep).join(' '))}`;
  return `folder-${slug(rel.split('/').join(' '))}`;
}

/** Stored library path: share-relative, or "ext:<path below /Volumes>" for a folder on an attached drive (copy mode only). */
export function storedFolderPath(destRoot: string, folderPath: string): string {
  return shareRelative(destRoot, folderPath) ?? 'ext:' + resolve(folderPath).replace(/^\/Volumes\//, '').split(sep).join('/');
}

/** Throws unless the path is an absolute directory path (not a library bundle — use --library for those). */
export function assertFolder(folderPath: string | undefined): string {
  if (!folderPath) throw new Error('--folder <absolute path> is required');
  if (!isAbsolute(folderPath)) throw new Error('--folder must be an absolute path');
  if (libraryKindOf(folderPath)) throw new Error('--folder is a photo library bundle; use --library for those');
  return stripSlash(resolve(folderPath));
}

/** Throws unless the path is an absolute, recognised library bundle. */
export function assertLibrary(libraryPath: string | undefined): string {
  if (!libraryPath) throw new Error('--library <absolute path> is required');
  if (!isAbsolute(libraryPath)) throw new Error('--library must be an absolute path');
  if (!libraryKindOf(libraryPath)) throw new Error('--library is not a recognised bundle (.photoslibrary, .migratedphotolibrary, .photolibrary, iPhoto Library)');
  return stripSlash(resolve(libraryPath));
}

/** The dest root must never be the library bundle or inside it (the bundle is read-only). */
export function assertDestRootSafe(destRoot: string, libraryPath: string): string {
  const d = stripSlash(resolve(destRoot)), l = stripSlash(resolve(libraryPath));
  if (d === l || d.startsWith(l + sep)) throw new Error('--dest-root must not be inside the library bundle');
  return d;
}

/** Library path relative to the share root (what manifest/push store); null when outside it. */
export function shareRelative(destRoot: string, libraryPath: string): string | null {
  const r = relative(resolve(destRoot), resolve(libraryPath));
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null;
}

function line(args: CliArgs, text: string) { if (!args.json) console.log(text); }

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const { defaultDeps } = await import('./analyzer-plugin');
  const home = process.env.PHOTOLIB_HOME || join(process.env.HOME || '.', '.photolib');
  const deps = defaultDeps(home);
  let cancelled = false;
  const onSig = () => { cancelled = true; console.error('\ncancelling after the current item…'); };
  process.on('SIGINT', onSig);
  const isCancelled = () => cancelled;
  let last = 0;
  const onProgress = (p: { done?: number; total?: number; bytes?: number; phase?: string }) => {
    const t = Date.now();
    if (args.json || (t - last < 1000 && (p.done ?? 0) < (p.total ?? Infinity))) return;
    last = t;
    console.log(`  ${p.phase ? p.phase + ' ' : ''}${p.done ?? 0}/${p.total ?? '?'}${p.bytes != null ? ` ${Math.round(p.bytes / 1e6)} MB` : ''}`);
  };

  const manifest = await deps.openManifest();
  let result: unknown;
  try {
    const isFolder = args.folder !== undefined;
    /** The source path for this run: a library bundle (--library) or a plain directory (--folder). */
    const needLibrary = () => (isFolder ? assertFolder(args.folder) : assertLibrary(args.library));
    const sourceIdFor = (library: string, destRoot: string) =>
      args.sourceId ?? (isFolder ? deriveFolderSourceId(library, destRoot) : deriveSourceId(library));
    const planNow = async () => {
      const library = needLibrary();
      const destRoot = assertDestRootSafe(args.destRoot, library);
      const sourceId = sourceIdFor(library, destRoot);
      const rel = isFolder ? storedFolderPath(destRoot, library) : shareRelative(destRoot, library);
      if (rel === null) throw new Error('--library must be inside --dest-root (paths are stored share-relative)');
      const files = args.files ? readFileSync(args.files, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : undefined;
      (manifest as { upsertSource?: (s: unknown) => void }).upsertSource?.({ id: sourceId, kind: isFolder ? 'folder' : libraryKindOf(library), libraryPath: rel, label: isFolder ? rel : basename(dirname(library)), addedAt: new Date().toISOString() });
      line(args, `plan ${sourceId} ← ${library}`);
      const plan = await deps.buildPlan({ libraryPath: library, destRoot, sourceId, limit: args.limit, manifest, onProgress, folder: isFolder, files, log: args.json ? undefined : (m: string) => console.error(m) });
      await deps.savePlan(plan, home);
      line(args, `planId ${plan.planId}  ${JSON.stringify(plan.totals)}  warnings ${plan.warnings.length}`);
      return plan;
    };
    switch (args.command) {
      case 'plan': result = await planNow(); break;
      case 'apply': {
        let plan;
        if (args.plan) {
          if (args.library) assertDestRootSafe(args.destRoot, needLibrary());
          plan = await deps.loadPlan(args.plan, home);
        } else plan = await planNow();
        if (cancelled) { result = { cancelled: true }; break; }
        const [{ captureMetadata, openLibraryRecordIndex, copyPhotosDb }, { readFullExif }, os] = await Promise.all([import('./metadata'), import('./exif'), import('node:os')]);
        const library = args.photosDb ? openLibraryRecordIndex(copyPhotosDb(args.photosDb, os.tmpdir())) : null;
        try {
          const destRoot = resolve(plan.destRoot);
          const captureMeta = (f: Parameters<typeof captureMetadata>[1]) => captureMetadata(destRoot, f, { readFullExif, library, sourceId: plan.sourceId });
          result = await deps.applyPlan(plan, { manifest, limit: args.limit, isCancelled, onProgress, mode: args.mode, captureMeta } as never);
        } finally { library?.close(); }
        line(args, `apply ${JSON.stringify(result)}`);
        break;
      }
      case 'undo': {
        if (!args.run) throw new Error('--run <runId> is required');
        if (args.library) assertDestRootSafe(args.destRoot, needLibrary());
        result = await deps.undoRun(args.run, { manifest, destRoot: resolve(args.destRoot), limit: args.limit });
        line(args, `undo ${JSON.stringify(result)}`);
        break;
      }
      case 'thumbs': {
        if (args.library) assertDestRootSafe(args.destRoot, needLibrary());
        result = await deps.runThumbs({ manifest, destRoot: resolve(args.destRoot), cacheDir: join(home, 'thumbs'), limit: args.limit, isCancelled, onProgress });
        line(args, `thumbs ${JSON.stringify(result)}`);
        break;
      }
      case 'push': {
        const library = needLibrary();
        const destRoot = assertDestRootSafe(args.destRoot, library);
        const rel = isFolder ? storedFolderPath(destRoot, library) : shareRelative(destRoot, library);
        if (rel === null) throw new Error('--library must be inside --dest-root (paths are pushed share-relative)');
        const sourceId = sourceIdFor(library, destRoot);
        result = await deps.runPush({
          manifest, limit: args.limit, force: args.force, isCancelled, onProgress,
          source: { id: sourceId, kind: (isFolder ? 'folder' : libraryKindOf(library)) as LibraryKind, label: isFolder ? rel : basename(dirname(library)), libraryPath: rel },
        });
        line(args, `push ${JSON.stringify(result)}`);
        break;
      }
      case 'status': {
        result = deps.readStatus(manifest);
        line(args, JSON.stringify(result, null, 2));
        break;
      }
    }
    if (args.json) console.log(JSON.stringify(result));
    return cancelled ? 130 : 0;
  } finally {
    process.off('SIGINT', onSig);
    try { manifest.close(); } catch { /* ignore */ }
    await deps.closeExif().catch(() => undefined);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
