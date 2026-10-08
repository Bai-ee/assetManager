import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { sha256File } from '../hash';
import { inferMediaType } from '../media-type';
import { resolveUnder, type ReadOnlyStore } from './store';
import { organizedFor } from './nas';
import type { AnalyzerControl, Cmd } from './control';

export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
};

export interface StageDeps {
  store: Pick<ReadOnlyStore, 'getSource' | 'knownFile'>;
  control: Pick<AnalyzerControl, 'uploadUrl'>;
  fetchImpl?: typeof fetch;
  hashFile?: (p: string) => Promise<string>;
}

/** Reads the original (never writes to the NAS), PUTs it to the signed URL, returns the COMPLETE result. */
export async function runStage(cmd: Cmd, deps: StageDeps): Promise<{ storagePath: string; contentType: string; sizeBytes: number }> {
  const { packageId, sha256, relativePath, sourceId } = cmd;
  if (!packageId || !sha256 || !relativePath || !sourceId) throw new Error('STAGE_FOR_PUBLISH requires packageId, sha256, relativePath, sourceId');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid sha256');
  const source = deps.store.getSource(sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}`);
  const original = resolveUnder(source.rootPath, relativePath);
  if (!original) throw new Error('relativePath escapes source root');
  const abs = organizedFor(source.rootPath, sha256) ?? original;
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`File not found on source: ${relativePath}`);
  const kind = inferMediaType(relativePath);
  if (kind !== 'image' && kind !== 'video') throw new Error('Only images and videos can be staged');
  if (kind === 'video' && st.size > MAX_VIDEO_BYTES) throw new Error(`Video is ${(st.size / 1048576).toFixed(0)}MB; staging limit is 512MB`);

  const known = deps.store.knownFile(sourceId, relativePath);
  const matches = known && known.sha256 === sha256 && known.sizeBytes === st.size && Math.abs(known.modifiedAtMs - st.mtimeMs) < 1;
  if (!matches && (await (deps.hashFile ?? sha256File)(abs)) !== sha256) throw new Error('File content does not match expected sha256');

  const contentType = CONTENT_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream';
  const target = await deps.control.uploadUrl({ packageId, sha256, contentType, sizeBytes: st.size });
  const f = deps.fetchImpl ?? fetch;
  const res = await f(target.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'content-length': String(st.size), ...target.headers },
    body: Readable.toWeb(fs.createReadStream(abs)) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) throw new Error(`Upload PUT failed: ${res.status}`);
  return { storagePath: target.storagePath, contentType, sizeBytes: st.size };
}
