import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { META_DIR, isNasSource } from './nas';
import { resolveUnder, type SourceInfo } from './store';

/**
 * User-directed copy/move between NAS folders (D016). Never overwrites; move removes the source only
 * after every transferred file is size-verified. All child processes use argv arrays (no shell).
 */

export const MAX_TOP_LEVEL_ITEMS = 500;
export const MAX_FILES = 2_000_000;
export const FREE_SPACE_MARGIN = 1024 ** 3;
export const PLAN_TTL_MS = 30 * 60 * 1000;
export const MAX_JOBS_KEPT = 20;
export const RETRY_EXIT_CODES = new Set([10, 11, 12, 20, 23, 24, 30, 35]);
export const DEFAULT_BACKOFF_MS = [2000, 5000, 10000, 10000];
export const PARTIAL_DIR = '.rsync-partial';
const HOMEBREW_RSYNC = '/opt/homebrew/bin/rsync';

export class OpsError extends Error { constructor(readonly status: number, message: string) { super(message); } }
class CancelledError extends Error { constructor() { super('cancelled'); } }

export type OpKind = 'copy' | 'move';
export interface PlanItem { from: string; to: string; kind: 'file' | 'dir'; sizeBytes: number; renamed: boolean }
export interface PlanInput { op: OpKind; sourceId: string; paths: string[]; destSourceId: string; destPath: string }
export interface PlanResult { ok: true; planId: string; items: PlanItem[]; totals: { files: number; bytes: number; renamed: number }; sameShare: boolean }

export interface FileEntry { rel: string; size: number }
interface InternalItem extends PlanItem { fromAbs: string; base: string; name: string; files: FileEntry[]; dirs: string[] }
interface StoredPlan { id: string; op: OpKind; destDirAbs: string; destRelDir: string; items: InternalItem[]; sameShare: boolean; expires: number }

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface JobView {
  id: string; op: OpKind; state: JobState; files: number; filesDone: number; bytes: number; bytesDone: number;
  currentFile?: string; attempt?: number; error?: string; startedAt: number; finishedAt?: number;
}
interface Job extends JobView { plan: StoredPlan; child?: ChildProcess; cancelled: boolean }

// ---------- name / path helpers ----------

const HIDDEN_NAMES = new Set(['@eaDir', '#recycle', '.DS_Store']);
const isHiddenName = (n: string) => n.startsWith('.') || HIDDEN_NAMES.has(n);
const toPosix = (p: string) => p.split(path.sep).join('/');
const isMetaRel = (rel: string) => rel === META_DIR || rel.startsWith(`${META_DIR}/`);
const within = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Normalizes a user-supplied relative path; throws 400 on absolute, '..', '.', NUL or empty. */
export function cleanRel(input: unknown, allowEmpty = false): string {
  if (typeof input !== 'string') throw new OpsError(400, 'invalid path');
  const raw = input.replace(/\\/g, '/');
  if (raw.startsWith('/') || raw.includes('\0')) throw new OpsError(400, 'invalid path');
  const segs = raw.split('/').filter(s => s !== '');
  if (segs.some(s => s === '..' || s === '.')) throw new OpsError(400, 'invalid path');
  if (!segs.length && !allowEmpty) throw new OpsError(400, 'invalid path');
  return segs.join('/');
}

/** "name (2).ext" / "name (3).ext"; dirs get no extension handling. */
export function uniqueName(name: string, kind: 'file' | 'dir', taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = kind === 'file' ? path.extname(name) : '';
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!taken(cand)) return cand;
  }
}

const lexists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** Walks a directory (skipping dotfiles/@eaDir/#recycle/symlinks), returning files with sizes and dirs (relative, posix). */
export function walkTree(dirAbs: string, maxFiles = MAX_FILES): { files: FileEntry[]; dirs: string[] } {
  const files: FileEntry[] = [], dirs: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop() as string;
    for (const d of fs.readdirSync(path.join(dirAbs, rel), { withFileTypes: true })) {
      if (isHiddenName(d.name) || d.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { dirs.push(r); stack.push(r); }
      else if (d.isFile()) {
        if (files.length >= maxFiles) throw new OpsError(413, 'too many files');
        files.push({ rel: r, size: fs.statSync(path.join(dirAbs, r)).size });
      }
    }
  }
  return { files, dirs };
}

// ---------- rsync ----------

let rsyncCache: string | null = null;
export function resolveRsync(): string {
  if (rsyncCache) return rsyncCache;
  let bin = HOMEBREW_RSYNC;
  if (!fs.existsSync(bin)) {
    try { bin = execFileSync('/usr/bin/which', ['rsync'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { bin = ''; }
  }
  if (!bin) throw new OpsError(500, 'rsync not found (install with: brew install rsync)');
  let out = '';
  try { out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 }); } catch { throw new OpsError(500, 'rsync not runnable'); }
  const major = Number(/version\s+(\d+)\./.exec(out)?.[1]);
  if (!(major >= 3)) throw new OpsError(500, 'rsync >= 3 required (macOS system rsync is too old; brew install rsync)');
  return (rsyncCache = bin);
}

export interface TransferCtx {
  rsync: string;
  backoffMs?: number[];
  isCancelled?: () => boolean;
  setChild?: (c: ChildProcess | undefined) => void;
  onProgress?: (bytesDone: number) => void;
  onAttempt?: (n: number) => void;
}

const parseProgress = (chunk: string): number | null => {
  let last: number | null = null;
  for (const line of chunk.split(/[\r\n]+/)) {
    const m = /^\s*([\d,]+)\s+\d+%/.exec(line);
    if (m) last = Number(m[1].replace(/,/g, ''));
  }
  return last;
};

function runRsyncOnce(ctx: TransferCtx, args: string[]): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.rsync, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.setChild?.(child);
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { const n = parseProgress(b.toString('utf8')); if (n != null) ctx.onProgress?.(n); });
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString('utf8')).slice(-400); });
    child.on('error', e => { ctx.setChild?.(undefined); reject(e); });
    child.on('close', (code, signal) => { ctx.setChild?.(undefined); resolve({ code, signal, stderr }); });
  });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function buildRsyncArgs(src: string, dest: string, kind: 'file' | 'dir'): string[] {
  return [
    '-a', '--no-owner', '--no-group', '--no-perms', '--no-links',
    '--partial', `--partial-dir=${PARTIAL_DIR}`, '--timeout=120', '--info=progress2', '--no-inc-recursive',
    '--exclude=.*', '--exclude=@eaDir', '--exclude=#recycle',
    ...(kind === 'dir' ? [`${src}/`, `${dest}/`] : [src, dest]),
  ];
}

/** Copies one top-level item to the exact final path `dest` (must not exist), retrying resumable failures. */
export async function copyViaRsync(ctx: TransferCtx, src: string, dest: string, kind: 'file' | 'dir'): Promise<void> {
  const backoff = ctx.backoffMs ?? DEFAULT_BACKOFF_MS;
  const args = buildRsyncArgs(src, dest, kind);
  for (let attempt = 1; ; attempt++) {
    if (ctx.isCancelled?.()) throw new CancelledError();
    ctx.onAttempt?.(attempt);
    const r = await runRsyncOnce(ctx, args);
    if (ctx.isCancelled?.()) throw new CancelledError();
    if (r.code === 0) break;
    const retryable = r.code !== null && RETRY_EXIT_CODES.has(r.code);
    if (!retryable || attempt > backoff.length) {
      const last = r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? '';
      throw new Error(`rsync failed (exit ${r.code ?? r.signal})${last ? `: ${last}` : ''}`);
    }
    await sleep(backoff[attempt - 1]);
  }
  try { fs.rmdirSync(path.join(kind === 'dir' ? dest : path.dirname(dest), PARTIAL_DIR)); } catch { /* absent or not empty */ }
}

const destFor = (destRoot: string, rel: string) => (rel === '.' ? destRoot : path.join(destRoot, ...rel.split('/')));

/** Throws unless every planned file exists at the destination with its planned size. */
export function verifyCopied(destRoot: string, files: FileEntry[]): void {
  for (const f of files) {
    let st: fs.Stats;
    try { st = fs.statSync(destFor(destRoot, f.rel)); } catch { throw new Error('verification failed: missing file at destination'); }
    if (!st.isFile() || st.size !== f.size) throw new Error('verification failed: size mismatch');
  }
}

/**
 * Cross-volume move: rsync copy, verify every planned file size at the destination (and that the source
 * still has that size), and only then unlink the source files and rmdir (never recursive) empty dirs bottom-up.
 * Any failure leaves the source untouched.
 */
export async function moveViaRsync(ctx: TransferCtx, item: { fromAbs: string; kind: 'file' | 'dir'; files: FileEntry[]; dirs: string[] }, destAbs: string): Promise<void> {
  await copyViaRsync(ctx, item.fromAbs, destAbs, item.kind);
  verifyCopied(destAbs, item.files);
  for (const f of item.files) {
    const s = destFor(item.fromAbs, f.rel);
    let st: fs.Stats;
    try { st = fs.statSync(s); } catch { throw new Error('verification failed: source changed during transfer'); }
    if (st.size !== f.size) throw new Error('verification failed: source changed during transfer');
  }
  for (const f of item.files) fs.unlinkSync(destFor(item.fromAbs, f.rel));
  if (item.kind === 'dir') {
    const dirs = [...item.dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const d of dirs) { try { fs.rmdirSync(path.join(item.fromAbs, ...d.split('/'))); } catch { /* not empty (hidden files) */ } }
    try { fs.rmdirSync(item.fromAbs); } catch { /* not empty */ }
  }
}

// ---------- planning ----------

type GetSource = (id: string) => SourceInfo | undefined;

function nasRoot(getSource: GetSource, id: unknown): { src: SourceInfo; realRoot: string } {
  const src = typeof id === 'string' ? getSource(id) : undefined;
  if (!src || !isNasSource(src)) throw new OpsError(404, 'unknown NAS source');
  let realRoot: string;
  try { realRoot = fs.realpathSync(src.rootPath); } catch { throw new OpsError(503, 'source root unreachable'); }
  return { src, realRoot };
}

const sameVolume = (a: string, b: string) => {
  try { if (fs.statSync(a).dev === fs.statSync(b).dev) return true; } catch { /* fall through */ }
  const sa = /^\/Volumes\/([^/]+)/.exec(a)?.[1], sb = /^\/Volumes\/([^/]+)/.exec(b)?.[1];
  return !!sa && sa === sb;
};

export function buildPlan(getSource: GetSource, input: PlanInput): StoredPlan {
  if (!input || (input.op !== 'copy' && input.op !== 'move')) throw new OpsError(400, 'op must be copy or move');
  if (!Array.isArray(input.paths) || !input.paths.length) throw new OpsError(400, 'paths required');
  if (input.paths.length > MAX_TOP_LEVEL_ITEMS) throw new OpsError(413, `too many items (max ${MAX_TOP_LEVEL_ITEMS})`);
  const rels = input.paths.map(p => cleanRel(p));
  const destRel = cleanRel(input.destPath ?? '', true);

  const { realRoot } = nasRoot(getSource, input.sourceId);
  const dst = nasRoot(getSource, input.destSourceId);

  // destination: existing real directory under the destination root, outside the meta dir
  if (isMetaRel(destRel) || destRel.split('/').some(isHiddenName)) throw new OpsError(400, 'destination not allowed');
  const destLex = resolveUnder(dst.src.rootPath, destRel || '.');
  if (!destLex) throw new OpsError(400, 'invalid destination');
  let destReal: string;
  try { destReal = fs.realpathSync(destLex); } catch { throw new OpsError(404, 'destination not found'); }
  if (!within(dst.realRoot, destReal)) throw new OpsError(400, 'destination escapes source root');
  if (!fs.statSync(destReal).isDirectory()) throw new OpsError(400, 'destination is not a directory');

  const uniq = Array.from(new Set(rels));
  const taken = new Set<string>();
  const items: InternalItem[] = [];
  let totalFiles = 0, totalBytes = 0, sameShare = true;
  for (const rel of uniq) {
    if (rel.split('/').some(isHiddenName) || isMetaRel(rel) || META_DIR.startsWith(`${rel}/`)) throw new OpsError(400, 'path not allowed');
    if (uniq.some(o => o !== rel && rel.startsWith(`${o}/`))) throw new OpsError(400, 'selection contains nested paths');
    const lexical = resolveUnder(realRoot, rel);
    if (!lexical) throw new OpsError(400, 'invalid path');
    let st: fs.Stats;
    try { st = fs.lstatSync(lexical); } catch { throw new OpsError(404, 'not found'); }
    if (st.isSymbolicLink()) throw new OpsError(400, 'symlinks are not allowed');
    let real: string;
    try { real = fs.realpathSync(lexical); } catch { throw new OpsError(404, 'not found'); }
    if (real !== lexical || !within(realRoot, real)) throw new OpsError(400, 'path escapes source root');

    const kind: 'file' | 'dir' = st.isDirectory() ? 'dir' : 'file';
    if (kind === 'file' && !st.isFile()) throw new OpsError(400, 'unsupported file type');
    if (kind === 'dir' && within(real, destReal)) throw new OpsError(400, 'destination is inside the source folder');
    if (input.op === 'move' && path.dirname(real) === destReal) throw new OpsError(400, 'item is already in the destination');

    let files: FileEntry[], dirs: string[] = [];
    if (kind === 'dir') {
      ({ files, dirs } = walkTree(real, MAX_FILES - totalFiles));
    } else files = [{ rel: '.', size: st.size }];
    const bytes = files.reduce((n, f) => n + f.size, 0);
    totalFiles += files.length; totalBytes += bytes;
    if (totalFiles > MAX_FILES) throw new OpsError(413, 'too many files');

    const base = path.basename(real);
    const name = uniqueName(base, kind, n => taken.has(n) || lexists(path.join(destReal, n)));
    taken.add(name);
    if (!sameVolume(path.dirname(real), destReal)) sameShare = false;
    items.push({
      from: rel, to: toPosix(path.join(destRel, name)), kind, sizeBytes: bytes, renamed: name !== base,
      fromAbs: real, base, name, files, dirs,
    });
  }

  if (input.op === 'copy' || !sameShare) {
    let free = Infinity;
    try { const s = fs.statfsSync(destReal); free = Number(s.bavail) * Number(s.bsize); } catch { /* unknown: don't block */ }
    if (free < totalBytes + FREE_SPACE_MARGIN) throw new OpsError(507, 'not enough free space at destination');
  }
  return { id: crypto.randomBytes(12).toString('hex'), op: input.op, destDirAbs: destReal, destRelDir: destRel, items, sameShare, expires: Date.now() + PLAN_TTL_MS };
}

// ---------- job manager ----------

export interface OpsManagerOptions { rsyncPath?: string; backoffMs?: number[]; now?: () => number }

export class OpsManager {
  private plans = new Map<string, StoredPlan>();
  private jobs: Job[] = [];
  private running = false;
  constructor(private opts: OpsManagerOptions = {}) {}
  private now() { return (this.opts.now ?? Date.now)(); }

  plan(getSource: GetSource, input: PlanInput): PlanResult {
    this.plans.forEach((p, id) => { if (p.expires < this.now()) this.plans.delete(id); });
    const p = buildPlan(getSource, input);
    p.expires = this.now() + PLAN_TTL_MS;
    this.plans.set(p.id, p);
    const items: PlanItem[] = p.items.map(i => ({ from: i.from, to: i.to, kind: i.kind, sizeBytes: i.sizeBytes, renamed: i.renamed }));
    return {
      ok: true, planId: p.id, items, sameShare: p.sameShare,
      totals: { files: p.items.reduce((n, i) => n + i.files.length, 0), bytes: p.items.reduce((n, i) => n + i.sizeBytes, 0), renamed: p.items.filter(i => i.renamed).length },
    };
  }

  apply(planId: unknown): { ok: true; jobId: string } {
    const p = typeof planId === 'string' ? this.plans.get(planId) : undefined;
    if (!p || p.expires < this.now()) { if (p) this.plans.delete(p.id); throw new OpsError(404, 'unknown or expired plan'); }
    if (!(p.op === 'move' && p.sameShare)) this.rsyncBin(); // fail fast with a clear message before queueing
    this.plans.delete(p.id);
    const job: Job = {
      id: crypto.randomBytes(8).toString('hex'), op: p.op, state: 'queued', files: p.items.reduce((n, i) => n + i.files.length, 0),
      filesDone: 0, bytes: p.items.reduce((n, i) => n + i.sizeBytes, 0), bytesDone: 0, startedAt: this.now(), plan: p, cancelled: false,
    };
    this.jobs.unshift(job);
    const finished = this.jobs.filter(j => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled');
    for (const old of finished.slice(MAX_JOBS_KEPT)) this.jobs.splice(this.jobs.indexOf(old), 1);
    void this.pump();
    return { ok: true, jobId: job.id };
  }

  list(): JobView[] {
    return this.jobs.map(({ plan: _p, child: _c, cancelled: _x, ...view }) => ({ ...view }));
  }

  cancel(jobId: unknown): { ok: true } {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job) throw new OpsError(404, 'unknown job');
    if (job.state === 'queued') { job.cancelled = true; this.finish(job, 'cancelled'); }
    else if (job.state === 'running') { job.cancelled = true; job.child?.kill('SIGTERM'); }
    else throw new OpsError(409, `job already ${job.state}`);
    return { ok: true };
  }

  /** Resolves when the queue is idle (tests). */
  async idle(): Promise<void> { while (this.running || this.jobs.some(j => j.state === 'queued')) await sleep(10); }

  private rsyncBin() { return this.opts.rsyncPath ?? resolveRsync(); }
  private finish(job: Job, state: JobState, error?: string) {
    job.state = state; job.finishedAt = this.now(); job.currentFile = undefined; job.child = undefined;
    if (error) job.error = error;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = [...this.jobs].reverse().find(j => j.state === 'queued');
        if (!job) break;
        await this.run(job);
      }
    } finally { this.running = false; }
  }

  private async run(job: Job): Promise<void> {
    job.state = 'running'; job.startedAt = this.now();
    const p = job.plan;
    try {
      const needsRsync = !(p.op === 'move' && p.sameShare);
      const rsync = needsRsync ? this.rsyncBin() : '';
      for (const item of p.items) {
        if (job.cancelled) throw new CancelledError();
        job.currentFile = item.from;
        const base = job.bytesDone;
        const dest = this.finalTarget(p.destDirAbs, item);
        const ctx: TransferCtx = {
          rsync, backoffMs: this.opts.backoffMs, isCancelled: () => job.cancelled,
          setChild: c => { job.child = c; },
          onProgress: n => { job.bytesDone = base + Math.min(n, item.sizeBytes); },
          onAttempt: n => { job.attempt = n; },
        };
        const srcSt = fs.lstatSync(item.fromAbs);
        if (srcSt.isSymbolicLink()) throw new Error('source became a symlink');
        if (p.op === 'move' && sameVolume(path.dirname(item.fromAbs), p.destDirAbs)) {
          try { fs.renameSync(item.fromAbs, dest); }
          catch (e: any) {
            if (e?.code !== 'EXDEV') throw e;
            await moveViaRsync(ctx, item, dest);
          }
        } else if (p.op === 'move') {
          await moveViaRsync(ctx, item, dest);
        } else {
          await copyViaRsync(ctx, item.fromAbs, dest, item.kind);
          verifyCopied(dest, item.files);
        }
        job.bytesDone = base + item.sizeBytes;
        job.filesDone += item.files.length;
      }
      this.finish(job, 'done');
    } catch (e) {
      if (e instanceof CancelledError || job.cancelled) this.finish(job, 'cancelled');
      else this.finish(job, 'failed', e instanceof Error ? e.message : String(e));
    }
  }

  /** Re-checks the target name at apply time; never returns a path that already exists. */
  private finalTarget(destDir: string, item: InternalItem): string {
    const taken = (n: string) => lexists(path.join(destDir, n));
    return path.join(destDir, taken(item.name) ? uniqueName(item.base, item.kind, taken) : item.name);
  }
}

// ---------- HTTP glue ----------

export interface OpsResponse { status: number; body: Record<string, unknown> }

/** Returns null when the pathname is not an ops route. `body` is the parsed JSON (POST). */
export function handleOpsRoute(mgr: OpsManager, getSource: GetSource, method: string, pathname: string, body: unknown): OpsResponse | null {
  if (!pathname.startsWith('/nas/ops/')) return null;
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  try {
    if (pathname === '/nas/ops/jobs') {
      if (method !== 'GET') return { status: 405, body: { ok: false, error: 'method not allowed' } };
      return { status: 200, body: { jobs: mgr.list() } };
    }
    if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method not allowed' } };
    if (pathname === '/nas/ops/plan') return { status: 200, body: { ...mgr.plan(getSource, obj as PlanInput) } };
    if (pathname === '/nas/ops/apply') return { status: 200, body: { ...mgr.apply(obj.planId) } };
    if (pathname === '/nas/ops/cancel') return { status: 200, body: { ...mgr.cancel(obj.jobId) } };
    return { status: 404, body: { ok: false, error: 'not found' } };
  } catch (e) {
    if (e instanceof OpsError) return { status: e.status, body: { ok: false, error: e.message } };
    return { status: 500, body: { ok: false, error: 'internal error' } };
  }
}
