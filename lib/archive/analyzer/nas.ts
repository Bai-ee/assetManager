import { execFile, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sha256File } from '../hash';
import { inferMediaType } from '../media-type';
import { resolveUnder, type SourceInfo } from './store';

export const FALLBACK_SMB_URL = 'smb://GUEST@192.168.1.6/bryan';
export const FALLBACK_MOUNT_POINT = '/Volumes/bryan';
export const CLOUD_INTAKE_SOURCE_ID = 'd3971a850e975bfd21fe2a89';
export const CONTENT_DIR = 'HITLOOP-ARCHIVE/content';
export const META_DIR = `${CONTENT_DIR}/_meta`;
export const BROWSE_LIMIT = 2000;
export const CHILD_COUNT_CAP = 1000;

// ---------- mount / status ----------

export interface SmbMount { smbUrl: string; mountPoint: string; host: string }

/** Parses `mount` output lines like `//GUEST:@192.168.1.6/bryan on /Volumes/bryan (smbfs, ...)`. */
export function parseSmbMounts(text: string): SmbMount[] {
  const out: SmbMount[] = [];
  for (const line of text.split('\n')) {
    const m = /^\/\/(?:([^@/]*)@)?([^/\s]+)\/(\S+) on (.+?) \(smbfs/.exec(line.trim());
    if (!m) continue;
    const user = (m[1] || '').replace(/:.*$/, '') || 'GUEST';
    out.push({ smbUrl: `smb://${user}@${m[2]}/${m[3]}`, mountPoint: m[4], host: m[2] });
  }
  return out;
}

export function readMountText(): string {
  try { return execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000 }); } catch { return ''; }
}

/** Cloud intake is not a NAS: exclude by id, label, or a root that is not an absolute local/volume path. */
export function isNasSource(s: SourceInfo): boolean {
  if (s.id === CLOUD_INTAKE_SOURCE_ID) return false;
  if (/cloud[\s-]*intake/i.test(s.label)) return false;
  return path.isAbsolute(s.rootPath);
}

export interface NasStatus {
  mounted: boolean; mountPoint: string; smbUrl: string;
  /** smb:// URLs of shares that back a NAS source under /Volumes but are not mounted right now. */
  missing: string[];
  sources: Array<{ id: string; label: string; root: string; reachable: boolean }>;
}

export function nasStatus(sources: SourceInfo[], mountText: string = readMountText()): NasStatus {
  const nas = sources.filter(isNasSource);
  const mounts = parseSmbMounts(mountText);
  const hit = mounts.find(m => nas.some(s => s.rootPath === m.mountPoint || s.rootPath.startsWith(m.mountPoint + '/')))
    ?? mounts.find(m => m.smbUrl === FALLBACK_SMB_URL);
  const mount = hit ?? { smbUrl: FALLBACK_SMB_URL, mountPoint: FALLBACK_MOUNT_POINT, host: '' };
  // A NAS source can live on a different share than the first one (e.g. /Volumes/Public/Bryan).
  const host = mounts[0]?.host || FALLBACK_SMB_URL.replace(/^smb:\/\/[^@]*@/, '').split('/')[0];
  const missing = Array.from(new Set(nas.flatMap(s => {
    const share = s.rootPath.match(/^\/Volumes\/([^/]+)/)?.[1];
    return share && !fs.existsSync(s.rootPath) ? [`smb://GUEST@${host}/${share}`] : [];
  })));
  return {
    mounted: !!hit && fs.existsSync(mount.mountPoint) && missing.length === 0,
    mountPoint: mount.mountPoint,
    smbUrl: mount.smbUrl,
    missing,
    sources: nas.map(s => ({ id: s.id, label: s.label, root: s.rootPath, reachable: fs.existsSync(s.rootPath) })),
  };
}

/** Mounts (guest) when not already mounted. Never unmounts. */
export function mountSmb(smbUrl: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', `mount volume "${smbUrl.replace(/["\\]/g, '')}"`], { timeout: timeoutMs }, err => (err ? reject(err) : resolve()));
  });
}

// ---------- browse ----------

export interface BrowseEntry { name: string; relativePath: string; kind: 'dir' | 'file'; mediaType?: 'image' | 'video'; sizeBytes?: number; childCount?: number }
export interface BrowseResult { ok: true; path: string; parent: string | null; entries: BrowseEntry[]; truncated?: true }

const HIDDEN_NAMES = new Set(['@eaDir', '#recycle', '.DS_Store']);
const isHiddenName = (n: string) => n.startsWith('.') || HIDDEN_NAMES.has(n);
const isMetaPath = (rel: string) => rel === META_DIR || rel.startsWith(`${META_DIR}/`);
const toPosix = (p: string) => p.split(path.sep).join('/');

export class BrowseError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function browse(rootPath: string, relPath: string): BrowseResult {
  const rel0 = (relPath || '').replace(/\\/g, '/').replace(/^\.\/?$/, '');
  if (rel0.split('/').includes('..')) throw new BrowseError(400, 'invalid path');
  const lexical = resolveUnder(rootPath, rel0 || '.');
  if (!lexical) throw new BrowseError(400, 'invalid path');
  let realRoot: string, real: string;
  try { realRoot = fs.realpathSync(rootPath); } catch { throw new BrowseError(503, 'source root unreachable'); }
  try { real = fs.realpathSync(lexical); } catch { throw new BrowseError(404, 'not found'); }
  const back = path.relative(realRoot, real);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new BrowseError(400, 'path escapes source root');
  const rel = toPosix(path.relative(path.resolve(rootPath), lexical));
  if (isMetaPath(rel) || rel.split('/').some(isHiddenName)) throw new BrowseError(404, 'not found');
  if (!fs.statSync(real).isDirectory()) throw new BrowseError(400, 'not a directory');

  const dirents = fs.readdirSync(real, { withFileTypes: true }).filter(d => !isHiddenName(d.name) && !d.isSymbolicLink());
  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    const relativePath = rel ? `${rel}/${d.name}` : d.name;
    if (isMetaPath(relativePath)) continue;
    if (d.isDirectory()) {
      let childCount = 0;
      try { for (const n of fs.readdirSync(path.join(real, d.name))) { if (!isHiddenName(n) && ++childCount >= CHILD_COUNT_CAP) break; } } catch { /* unreadable dir */ }
      entries.push({ name: d.name, relativePath, kind: 'dir', childCount });
    } else if (d.isFile()) {
      const mt = inferMediaType(d.name);
      let sizeBytes: number | undefined;
      try { sizeBytes = fs.statSync(path.join(real, d.name)).size; } catch { /* vanished */ }
      entries.push({ name: d.name, relativePath, kind: 'file', ...(mt === 'image' || mt === 'video' ? { mediaType: mt } : {}), ...(sizeBytes != null ? { sizeBytes } : {}) });
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  const truncated = entries.length > BROWSE_LIMIT;
  const parent = rel ? (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '') : null;
  return { ok: true, path: rel, parent, entries: truncated ? entries.slice(0, BROWSE_LIMIT) : entries, ...(truncated ? { truncated: true as const } : {}) };
}

// ---------- organize (copy-only) ----------

export interface OrganizeInput {
  rootPath: string; sourceId: string; sha256: string; originalAbs: string; originalRelativePath: string;
  entry: { facets?: any; capturedAt?: string } & Record<string, unknown>;
  thumbDir?: string; hashFile?: (p: string) => Promise<string>; now?: () => Date;
}

const safeName = (n: string) => n.replace(/[\\/\0]/g, '_');
const atomicWrite = (dest: string, data: string | Buffer) => {
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, dest); } finally { fs.rmSync(tmp, { force: true }); }
};

/** Organized copy for a sha on a given source root, via its sidecar (null if absent/missing). */
export function organizedFor(rootPath: string, sha256: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(rootPath, META_DIR, `${sha256}.json`), 'utf8')) as { organizedRelativePath?: string };
    if (!meta.organizedRelativePath) return null;
    const abs = resolveUnder(rootPath, meta.organizedRelativePath);
    return abs && fs.existsSync(abs) ? abs : null;
  } catch { return null; }
}

/** Copies (never moves) the original to HITLOOP-ARCHIVE/content/<kind>/<year|unknown>/<name>. Returns the source-root-relative path. */
export async function organizeCopy(i: OrganizeInput): Promise<string> {
  const contentRoot = path.join(i.rootPath, CONTENT_DIR);
  if (i.originalRelativePath === CONTENT_DIR || i.originalRelativePath.startsWith(`${CONTENT_DIR}/`)) return i.originalRelativePath;
  const hashFile = i.hashFile ?? sha256File;
  const srcSize = fs.statSync(i.originalAbs).size;

  const existing = organizedFor(i.rootPath, i.sha256);
  if (existing && fs.statSync(existing).size === srcSize) return toPosix(path.relative(i.rootPath, existing));

  const kind = String(i.entry.facets?.vibe?.kind || 'other').replace(/[^a-z0-9-]/gi, '') || 'other';
  // Year folders come only from a year read off the flyer itself (printed or inferred from its weekday). File dates (capturedAt/mtime) are
  // unreliable for downloaded archives, and eraYear is a visual guess, so neither is used. Everything else goes to 'unknown'.
  const yr = Number(i.entry.facets?.eventYear);
  const year = Number.isInteger(yr) && yr >= 1900 && yr <= 2100 ? String(yr) : 'unknown';
  const dir = path.join(contentRoot, kind, year);
  if (!resolveUnder(contentRoot, path.relative(contentRoot, dir))) throw new Error('organize path escapes content root');
  fs.mkdirSync(dir, { recursive: true });

  const name = safeName(path.basename(i.originalAbs));
  const ext = path.extname(name);
  const candidates = [name, `${name.slice(0, name.length - ext.length)}-${i.sha256.slice(0, 8)}${ext}`];
  let dest: string | null = null, already = false;
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (!fs.existsSync(p)) { dest = p; break; }
    if (fs.statSync(p).size === srcSize && (await hashFile(p)) === i.sha256) { dest = p; already = true; break; }
  }
  if (!dest) throw new Error('organize collision unresolved');

  if (!already) {
    const tmp = path.join(dir, `.${path.basename(dest)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.promises.copyFile(i.originalAbs, tmp);
      if (fs.statSync(tmp).size !== srcSize) throw new Error('copy size mismatch');
      fs.renameSync(tmp, dest);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  const organizedRelativePath = toPosix(path.relative(i.rootPath, dest));
  const metaDir = path.join(i.rootPath, META_DIR);
  fs.mkdirSync(path.join(metaDir, 'thumbs'), { recursive: true });
  const thumb = i.thumbDir ? path.join(i.thumbDir, `${i.sha256}.jpg`) : null;
  if (thumb && fs.existsSync(thumb)) atomicWrite(path.join(metaDir, 'thumbs', `${i.sha256}.jpg`), fs.readFileSync(thumb));
  atomicWrite(path.join(metaDir, `${i.sha256}.json`), JSON.stringify({
    ...i.entry, sha256: i.sha256, sourceId: i.sourceId, originalRelativePath: i.originalRelativePath, organizedRelativePath,
    analyzedAt: (i.now ?? (() => new Date()))().toISOString(),
  }, null, 2));
  return organizedRelativePath;
}
