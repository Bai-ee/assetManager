/**
 * npm run photolib -- <plan|apply|undo|thumbs|push|status> --library <abs> [--dest-root /Volumes/bryan] [--source-id id]
 *   [--limit N] [--plan <planId>] [--run <runId>] [--force] [--json]
 * Pure helpers are exported for tests; main() only runs when this file is executed directly.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LibraryKind } from './types';

export const COMMANDS = ['plan', 'apply', 'undo', 'thumbs', 'push', 'status'] as const;
export type CliCommand = (typeof COMMANDS)[number];
export const DEFAULT_DEST_ROOT = '/Volumes/bryan';

export interface CliArgs {
  command: CliCommand;
  library?: string;
  destRoot: string;
  sourceId?: string;
  limit?: number;
  plan?: string;
  run?: string;
  force: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) throw new Error(`Usage: photolib <${COMMANDS.join('|')}> [options] (got ${command ?? 'nothing'})`);
  const out: CliArgs = { command: command as CliCommand, destRoot: DEFAULT_DEST_ROOT, force: false, json: false };
  const value = (i: number, flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--library': out.library = value(i, a); i++; break;
      case '--dest-root': out.destRoot = value(i, a); i++; break;
      case '--source-id': out.sourceId = value(i, a); i++; break;
      case '--plan': out.plan = value(i, a); i++; break;
      case '--run': out.run = value(i, a); i++; break;
      case '--limit': {
        const n = Number(value(i, a)); i++;
        if (!Number.isInteger(n) || n < 1) throw new Error('--limit must be a positive whole number');
        out.limit = n; break;
      }
      case '--force': out.force = true; break;
      case '--json': out.json = true; break;
      default: throw new Error(`Unknown argument ${a}`);
    }
  }
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
    const needLibrary = () => assertLibrary(args.library);
    const planNow = async () => {
      const library = needLibrary();
      const destRoot = assertDestRootSafe(args.destRoot, library);
      const sourceId = args.sourceId ?? deriveSourceId(library);
      const rel = shareRelative(destRoot, library);
      if (rel === null) throw new Error('--library must be inside --dest-root (paths are stored share-relative)');
      (manifest as { upsertSource?: (s: unknown) => void }).upsertSource?.({ id: sourceId, kind: libraryKindOf(library), libraryPath: rel, label: basename(dirname(library)), addedAt: new Date().toISOString() });
      line(args, `plan ${sourceId} ← ${library}`);
      const plan = await deps.buildPlan({ libraryPath: library, destRoot, sourceId, limit: args.limit, manifest, onProgress });
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
        result = await deps.applyPlan(plan, { manifest, limit: args.limit, isCancelled, onProgress });
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
        const rel = shareRelative(destRoot, library);
        if (rel === null) throw new Error('--library must be inside --dest-root (paths are pushed share-relative)');
        const sourceId = args.sourceId ?? deriveSourceId(library);
        result = await deps.runPush({
          manifest, limit: args.limit, force: args.force, isCancelled, onProgress,
          source: { id: sourceId, kind: libraryKindOf(library) as LibraryKind, label: basename(dirname(library)), libraryPath: rel },
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
