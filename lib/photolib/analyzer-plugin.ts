/**
 * Photolib plugin for the NAS analyzer daemon: PHOTOLIB_PLAN / APPLY / UNDO / THUMBS / PUSH plus GET /photolib/status.
 * Contract: docs/archive/PHOTOLIB.md. Real implementations are lazy-imported so tests (and daemons that never see a
 * PHOTOLIB_* command) never load better-sqlite3 / exiftool. Boundary: lib/photolib may import lib/archive, never the reverse.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AnalyzerPlugin, PluginContext, PluginRouteRequest } from '../archive/analyzer/plugin';
import type { Cmd } from '../archive/analyzer/control';
import type { SourceInfo } from '../archive/analyzer/store';
import type { LibraryKind, Plan } from './types';
import { libraryKindOf } from './cli';
import type { PushRunResult } from './push';

export const PHOTOLIB_COMMAND_TYPES = ['PHOTOLIB_PLAN', 'PHOTOLIB_APPLY', 'PHOTOLIB_UNDO', 'PHOTOLIB_THUMBS', 'PHOTOLIB_PUSH'];
const PROGRESS_MIN_INTERVAL_MS = 1000;
const MAX_LIMIT = 1_000_000;

export interface Progress { done?: number; total?: number; bytes?: number; phase?: string }

/** Structural view of the manifest the plugin needs (the real class satisfies it; tests pass fakes). */
export interface ManifestLike {
  getRun(runId: string): { sourceId: string } | undefined;
  close(): void;
  [k: string]: unknown;
}

export interface PhotolibDeps {
  openManifest(): ManifestLike | Promise<ManifestLike>;
  buildPlan(o: { libraryPath: string; destRoot: string; sourceId: string; limit?: number; manifest: ManifestLike; onProgress?: (p: Progress) => void; /** Plain-directory source (CLI --folder) instead of a library bundle. */ folder?: boolean; /** Folder source: explicit file list instead of a walk. */ files?: string[]; log?: (msg: string) => void }): Promise<Plan>;
  savePlan(plan: Plan, home: string): unknown;
  loadPlan(planId: string, home: string): Plan | Promise<Plan>;
  applyPlan(plan: Plan, o: { manifest: ManifestLike; limit?: number; isCancelled?: () => boolean; onProgress?: (p: Progress) => void }): Promise<Record<string, unknown> & { cancelled?: boolean }>;
  undoRun(runId: string, o: { manifest: ManifestLike; destRoot: string; limit?: number }): Promise<Record<string, unknown> & { cancelled?: boolean }>;
  runThumbs(o: { manifest: ManifestLike; destRoot: string; cacheDir: string; limit?: number; isCancelled?: () => boolean; onProgress?: (p: Progress) => void }): Promise<Record<string, unknown> & { cancelled?: boolean }>;
  runPush(o: { manifest: ManifestLike; source: { id: string; kind: LibraryKind; label: string; libraryPath: string }; limit?: number; force?: boolean; isCancelled?: () => boolean; onProgress?: (p: Progress) => void }): Promise<PushRunResult>;
  /** Library bundle recorded for a source in the manifest (push needs its kind + share-relative path). */
  getSourceRow(manifest: ManifestLike, sourceId: string): { kind: string; libraryPath: string; label: string | null } | undefined;
  readStatus(manifest: ManifestLike): { assets: number; pushed: number; missingThumbs: number; lastRuns: unknown[] };
  closeExif(): Promise<void>;
}

export interface PhotolibPluginOptions {
  /** PHOTOLIB_HOME (manifest, plans/, thumbs/). Default env PHOTOLIB_HOME or ~/.photolib. */
  home?: string;
  env?: Record<string, string | undefined>;
  deps?: Partial<PhotolibDeps>;
  now?: () => number;
}

export class BadRequest extends Error {}

/** Folder = source root + relativePath. Rejects absolute, '..' segments, NULs, and anything that escapes the root. */
export function resolveLibraryDir(source: SourceInfo | undefined, relativePath: unknown): string {
  if (!source) throw new BadRequest('Unknown source');
  if (typeof relativePath !== 'string' || !relativePath) throw new BadRequest('libraryPath is required');
  if (isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.split(/[\\/]/).includes('..')) throw new BadRequest('Library path is not allowed');
  const root = resolve(source.rootPath);
  const abs = resolve(root, relativePath);
  const back = relative(root, abs);
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new BadRequest('Library is outside the source');
  return abs;
}

function optLimit(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT) throw new BadRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return v;
}

export function defaultDeps(home?: string): PhotolibDeps {
  return {
    openManifest: async () => { const { Manifest } = await import('./manifest'); return new Manifest(home ? join(home, 'photolib.sqlite') : undefined) as unknown as ManifestLike; },
    async buildPlan(o) {
      const [{ buildPlan }, { readLibrary }, { readExifBatch }, { resolveTakenDate }, { canonicalPathFor, normalizeExt }] =
        await Promise.all([import('./plan'), import('./rk-reader'), import('./exif'), import('./dates'), import('./layout')]);
      const readFolderSource = async (root: string, ro: { sourceId: string; log?: (m: string) => void }) =>
        (await import('./folder-reader')).readFolder(root, { sourceId: ro.sourceId, readExifBatch, resolveTakenDate, log: ro.log, files: o.files });
      return buildPlan({
        libraryPath: o.libraryPath, destRoot: o.destRoot, sourceId: o.sourceId, limit: o.limit, onProgress: o.onProgress, log: o.log,
        manifest: o.manifest as never, deps: { readLibrary: o.folder ? readFolderSource : readLibrary, readExifBatch, resolveTakenDate, canonicalPathFor, normalizeExt },
      });
    },
    savePlan: async (plan, home) => (await import('./plan')).savePlan(plan, home),
    loadPlan: async (id, home) => (await import('./plan')).loadPlan(id, home),
    applyPlan: async (plan, o) => (await import('./apply')).applyPlan(plan, o as never) as never,
    undoRun: async (runId, o) => (await import('./apply')).undoRun(runId, o as never) as never,
    runThumbs: async o => (await import('./thumbs')).runThumbs(o as never) as never,
    runPush: async o => {
      const { runPush, LifeClient } = await import('./push');
      const base = process.env.HITLOOP_ARCHIVE_CONTROL_URL, token = process.env.HITLOOP_ARCHIVE_WORKER_TOKEN;
      if (!base || !token) throw new Error('HITLOOP_ARCHIVE_CONTROL_URL and HITLOOP_ARCHIVE_WORKER_TOKEN must be set');
      return runPush({ ...(o as unknown as Parameters<typeof runPush>[0]), client: new LifeClient(base, token) });
    },
    getSourceRow(manifest, id) {
      const db = (manifest as unknown as { db: { prepare(s: string): { get(...a: unknown[]): any } } }).db;
      const r = db.prepare('select kind, library_path, label from sources where id = ?').get(id);
      return r ? { kind: r.kind, libraryPath: r.library_path, label: r.label } : undefined;
    },
    readStatus(manifest) {
      const db = (manifest as unknown as { db: { prepare(s: string): { get(...a: unknown[]): any; all(...a: unknown[]): any[] } } }).db;
      const n = (sql: string) => Number(db.prepare(sql).get().n);
      return {
        assets: n('select count(*) n from assets'),
        pushed: n('select count(*) n from assets where pushed_at is not null'),
        missingThumbs: n('select count(*) n from assets where thumb_s is null or thumb_m is null'),
        lastRuns: db.prepare('select run_id runId, source_id sourceId, command, started_at startedAt, finished_at finishedAt, state from runs order by started_at desc limit 5').all(),
      };
    },
    closeExif: async () => { await (await import('./exif')).closeExif(); },
  };
}

export function photolibPlugin(opts: PhotolibPluginOptions = {}): AnalyzerPlugin {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.PHOTOLIB_HOME ?? join(homedir(), '.photolib');
  const now = opts.now ?? Date.now;
  const deps: PhotolibDeps = { ...defaultDeps(home), ...opts.deps };

  async function run(cmd: Cmd, ctx: PluginContext): Promise<{ result: unknown; cancelled?: boolean }> {
    let lastPush = -Infinity, lastPhase = '';
    const onProgress = (p: Progress) => {
      const t = now();
      const phase = p.phase ?? '';
      if (phase === lastPhase && t - lastPush < PROGRESS_MIN_INTERVAL_MS && (p.done ?? 0) < (p.total ?? Infinity)) return;
      lastPhase = phase; lastPush = t;
      void ctx.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: p } }).catch(() => undefined);
    };
    const isCancelled = () => ctx.isCancelled(cmd.id);
    const limit = optLimit(cmd.limit);
    const manifest = await deps.openManifest();
    try {
      if (cmd.type === 'PHOTOLIB_PLAN') {
        const sourceId = String(cmd.sourceId ?? '');
        const source = ctx.getSource(sourceId);
        const libraryPath = typeof cmd.libraryPath === 'string' ? cmd.libraryPath : '';
        const abs = resolveLibraryDir(source, libraryPath);
        if (!libraryKindOf(abs)) throw new BadRequest('libraryPath is not a recognised photo library bundle');
        const plan = await deps.buildPlan({ libraryPath: abs, destRoot: (source as SourceInfo).rootPath, sourceId, limit, manifest, onProgress });
        await deps.savePlan(plan, home);
        (manifest as { upsertSource?: (s: unknown) => void }).upsertSource?.({
          id: sourceId, kind: libraryKindOf(abs), libraryPath: libraryPath.replace(/[\\/]+$/, ''), label: (source as SourceInfo).label, addedAt: new Date().toISOString(),
        });
        const cancelled = isCancelled();
        return {
          cancelled,
          result: {
            planId: plan.planId, totals: plan.totals, warnings: plan.warnings,
            sample: plan.items.slice(0, 20).map(i => ({ sha256: i.sha256, action: i.action, relativePath: i.item.relativePath, canonicalPath: i.canonicalPath })),
          },
        };
      }
      if (cmd.type === 'PHOTOLIB_APPLY') {
        const plan = await deps.loadPlan(String(cmd.planId ?? ''), home);
        const r = await deps.applyPlan(plan, { manifest, limit, isCancelled, onProgress });
        return { result: r, cancelled: r.cancelled === true };
      }
      if (cmd.type === 'PHOTOLIB_UNDO') {
        const runId = String(cmd.runId ?? '');
        const row = manifest.getRun(runId);
        if (!row) throw new BadRequest('Unknown runId');
        const source = ctx.getSource(typeof cmd.sourceId === 'string' ? cmd.sourceId : row.sourceId);
        if (!source) throw new BadRequest('Unknown source');
        const r = await deps.undoRun(runId, { manifest, destRoot: source.rootPath, limit });
        return { result: r, cancelled: r.cancelled === true };
      }
      if (cmd.type === 'PHOTOLIB_THUMBS') {
        const source = ctx.getSource(String(cmd.sourceId ?? ''));
        if (!source) throw new BadRequest('sourceId is required (thumbnails are read from that source root)');
        const r = await deps.runThumbs({ manifest, destRoot: source.rootPath, cacheDir: join(home, 'thumbs'), limit, isCancelled, onProgress });
        return { result: r, cancelled: r.cancelled === true };
      }
      if (cmd.type === 'PHOTOLIB_PUSH') {
        const sourceId = String(cmd.sourceId ?? '');
        const source = ctx.getSource(sourceId);
        if (!source) throw new BadRequest('sourceId is required');
        const row = deps.getSourceRow(manifest, sourceId);
        let libPath = typeof cmd.libraryPath === 'string' ? cmd.libraryPath : row?.libraryPath;
        if (!libPath) throw new BadRequest('libraryPath is required (no manifest source recorded yet — run PLAN first)');
        if (isAbsolute(libPath)) { // manifest may hold an absolute path: store only the share-relative form
          const rel = relative(resolve(source.rootPath), libPath);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new BadRequest('Library is outside the source');
          libPath = rel;
        }
        const kind = libraryKindOf(libPath) ?? (row?.kind as LibraryKind | undefined);
        if (!kind) throw new BadRequest('Cannot tell the library kind');
        const r = await deps.runPush({
          manifest, limit, force: cmd.force === true, isCancelled, onProgress,
          source: { id: sourceId, kind, label: row?.label || source.label, libraryPath: libPath },
        });
        return { result: r, cancelled: r.cancelled === true };
      }
      throw new Error(`Unsupported command type ${cmd.type}`);
    } finally {
      try { manifest.close(); } catch { /* already closed */ }
      if (cmd.type === 'PHOTOLIB_PLAN') await deps.closeExif().catch(() => undefined);
    }
  }

  return {
    name: 'photolib',
    commandTypes: PHOTOLIB_COMMAND_TYPES,
    run,
    routePrefix: '/photolib/',
    async route(req: PluginRouteRequest) {
      if (req.pathname !== '/photolib/status') return null;
      if (req.method !== 'GET') return { status: 405, body: { ok: false, error: 'Use GET' } };
      const manifest = await deps.openManifest();
      try {
        return { status: 200, body: { ok: true, ...deps.readStatus(manifest) } };
      } catch (e) {
        return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : String(e) } };
      } finally {
        try { manifest.close(); } catch { /* ignore */ }
      }
    },
  };
}
