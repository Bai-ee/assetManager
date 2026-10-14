/**
 * Discogs plugin for the NAS analyzer daemon: DISCOGS_PLAN / DISCOGS_APPLY / DISCOGS_UNDO
 * commands plus the free live routes GET /discogs/status and POST /discogs/estimate.
 * Boundary rule: lib/discogs may import lib/archive, never the reverse.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AnalyzerPlugin, PluginContext, PluginRouteRequest } from '../archive/analyzer/plugin';
import type { Cmd } from '../archive/analyzer/control';
import type { SourceInfo } from '../archive/analyzer/store';
import { DiscogsClient } from './client';
import { DEFAULT_INDEX_PATH } from './media';
import { planFolder, estimateFolder, applyPlan, undoApply } from './run';
import type { ProgressInfo, RunDeps } from './run';

export const DISCOGS_COMMAND_TYPES = ['DISCOGS_PLAN', 'DISCOGS_APPLY', 'DISCOGS_UNDO'];
const DEFAULT_DISCOGS_DIR = '/Volumes/bryan/MacTransfer/discogs';
const IDENTITY_TTL_MS = 10 * 60_000;
const PROGRESS_MIN_INTERVAL_MS = 1000;
const MAX_LIMIT = 300;
const MAX_CAP_USD = 20;
const DEFAULT_CAP_USD = 2;
const MAX_APPLY_ITEMS = 100;

export interface DiscogsPluginOptions {
  /** Where cache/ runs/ index.json costs.jsonl live (default ~/.discogs-ingest). */
  home?: string;
  env?: Record<string, string | undefined>;
  /** Client factory (tests). Default: a new DiscogsClient from DISCOGS_TOKEN. */
  makeClient?: () => DiscogsClient;
  /** Overrides for the run deps (tests inject fake readers/scanners). */
  runDeps?: Partial<RunDeps>;
  now?: () => number;
}

class BadRequest extends Error {}

/** Folder = source root + relativePath. Rejects absolute, '..' segments, NULs, and anything that escapes the root. */
export function resolveFolder(source: SourceInfo | undefined, relativePath: unknown): string {
  if (!source) throw new BadRequest('Unknown source');
  const rel = relativePath == null ? '' : relativePath;
  if (typeof rel !== 'string') throw new BadRequest('relativePath must be a string');
  if (isAbsolute(rel) || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) throw new BadRequest('Folder path is not allowed');
  const root = resolve(source.rootPath);
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (back.startsWith('..') || isAbsolute(back)) throw new BadRequest('Folder is outside the source');
  return abs;
}

function intIn(v: unknown, min: number, max: number, def: number, name: string): number {
  if (v == null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BadRequest(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}

function capFrom(v: unknown): number {
  if (v == null) return DEFAULT_CAP_USD;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_CAP_USD) throw new BadRequest(`capUsd must be above 0 and at most ${MAX_CAP_USD}`);
  return v;
}

export function discogsPlugin(opts: DiscogsPluginOptions = {}): AnalyzerPlugin {
  const env = opts.env ?? process.env;
  const home = opts.home ?? join(homedir(), '.discogs-ingest');
  const now = opts.now ?? Date.now;
  const makeClient = opts.makeClient ?? (() => new DiscogsClient(env.DISCOGS_TOKEN));
  const base = (): RunDeps => ({
    client: makeClient(),
    cacheDir: join(home, 'cache'),
    runsDir: join(home, 'runs'),
    indexPath: opts.home ? join(home, 'index.json') : DEFAULT_INDEX_PATH,
    costLogPath: join(home, 'costs.jsonl'),
    ...opts.runDeps,
  });
  const configured = (c: DiscogsClient) => { if (!c.configured) throw new Error('Discogs is not configured: DISCOGS_TOKEN is missing'); };

  let identity: { at: number; username: string | null; count: number | null } | null = null;

  async function run(cmd: Cmd, ctx: PluginContext): Promise<{ result: unknown; cancelled?: boolean }> {
    let lastPush = 0, lastPhase = '';
    const onProgress = (p: ProgressInfo) => {
      const t = now();
      if (p.phase === lastPhase && t - lastPush < PROGRESS_MIN_INTERVAL_MS && p.done < p.total) return;
      lastPhase = p.phase; lastPush = t;
      void ctx.update({ commandId: cmd.id, state: 'RUNNING', result: { progress: p } }).catch(() => undefined);
    };
    const isCancelled = () => ctx.isCancelled(cmd.id);
    const deps = { ...base(), onProgress, isCancelled };
    configured(deps.client);

    if (cmd.type === 'DISCOGS_PLAN') {
      const sourceId = String(cmd.sourceId ?? '');
      const relativePath = typeof cmd.relativePath === 'string' ? cmd.relativePath : '';
      const dir = resolveFolder(ctx.getSource(sourceId), relativePath);
      const limit = intIn(cmd.limit, 1, MAX_LIMIT, MAX_LIMIT, 'limit');
      const capUsd = capFrom(cmd.capUsd);
      const r = await planFolder({ dir, limit }, { ...deps, capUsd });
      return {
        cancelled: r.cancelled,
        result: {
          planId: r.planId, sourceId, relativePath, summary: r.summary, rows: r.rows, spentUsd: r.spentUsd,
          cost: { billedCalls: r.cost.billedCalls, cachedCalls: r.cost.cachedCalls },
          capReached: r.capReached, remaining: r.remaining,
        },
      };
    }
    if (cmd.type === 'DISCOGS_APPLY') {
      const items = cmd.items;
      if (!Array.isArray(items) || !items.length || items.length > MAX_APPLY_ITEMS) throw new BadRequest(`items must list 1 to ${MAX_APPLY_ITEMS} records`);
      const clean = items.map(i => {
        const it = i as { groupId?: unknown; releaseId?: unknown };
        if (typeof it?.groupId !== 'string' || !Number.isInteger(it.releaseId) || (it.releaseId as number) <= 0) throw new BadRequest('Each item needs groupId and a positive releaseId');
        return { groupId: it.groupId, releaseId: it.releaseId as number };
      });
      const r = await applyPlan({ planId: String(cmd.planId ?? ''), items: clean, notes: cmd.notes === true, folderId: intIn(cmd.folderId, 0, 1_000_000, 1, 'folderId') }, deps);
      return { result: r, cancelled: r.cancelled === true };
    }
    if (cmd.type === 'DISCOGS_UNDO') {
      const r = await undoApply({ journal: String(cmd.journal ?? '') }, deps);
      return { result: r, cancelled: r.cancelled === true };
    }
    throw new Error(`Unsupported command type ${cmd.type}`);
  }

  async function status(sources: SourceInfo[]) {
    const configuredFlags = { discogsToken: Boolean(env.DISCOGS_TOKEN), anthropicKey: Boolean(env.ANTHROPIC_API_KEY) };
    if (configuredFlags.discogsToken && (!identity || now() - identity.at > IDENTITY_TTL_MS)) {
      try {
        const c = makeClient();
        const me = await c.identity();
        const all = (await c.folders(me.username)).find(f => f.id === 0);
        identity = { at: now(), username: me.username, count: all?.count ?? null };
      } catch {
        identity = { at: now() - IDENTITY_TTL_MS + 30_000, username: null, count: null }; // retry soon
      }
    }
    const defaultDir = resolve(env.DISCOGS_DEFAULT_DIR || DEFAULT_DISCOGS_DIR);
    let defaultSourceId: string | null = null, defaultPath: string | null = null;
    for (const s of sources) {
      const rel = relative(resolve(s.rootPath), defaultDir);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      if (defaultSourceId === null || rel.split(sep).length < (defaultPath ?? '').split(sep).length) { defaultSourceId = s.id; defaultPath = rel; }
    }
    return {
      ok: true, configured: configuredFlags,
      username: configuredFlags.discogsToken ? identity?.username ?? null : null,
      collectionCount: configuredFlags.discogsToken ? identity?.count ?? null : null,
      defaultSourceId, defaultPath,
    };
  }

  return {
    name: 'discogs',
    commandTypes: DISCOGS_COMMAND_TYPES,
    run,
    routePrefix: '/discogs/',
    async route(req: PluginRouteRequest, ctx) {
      if (req.pathname === '/discogs/status') {
        if (req.method !== 'GET') return { status: 405, body: { ok: false, error: 'Use GET' } };
        return { status: 200, body: await status(ctx.listSources()) };
      }
      if (req.pathname === '/discogs/estimate') {
        if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'Use POST' } };
        try {
          const b = (req.body ?? {}) as { sourceId?: unknown; relativePath?: unknown; limit?: unknown };
          const dir = resolveFolder(ctx.getSource(String(b.sourceId ?? '')), b.relativePath);
          const limit = intIn(b.limit, 1, MAX_LIMIT, MAX_LIMIT, 'limit');
          return { status: 200, body: { ok: true, ...(await estimateFolder({ dir, limit }, base())) } };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { status: e instanceof BadRequest ? 400 : 500, body: { ok: false, error: msg } };
        }
      }
      return null;
    },
  };
}
