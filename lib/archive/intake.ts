import * as os from 'os';
import * as path from 'path';
import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { ArchiveDatabase } from './database';
import { ArchiveWorker } from './worker';
import { ControlPlaneClient, type IntakeItem } from './control-plane';
import type { ArchiveSource } from './types';

// Lane 2 (phone/camera-roll upload) worker side. See
// docs/archive/INTAKE_CONTRACT.md (HITLOOP, owns the Firestore doc + routes)
// and ARCHIVE-X-MASTER-PLAN-2026-09-20.md D1/D3/D4. The NAS is never written
// here (D1): downloaded bytes land in a scratch dir under the OS temp
// directory, registered as their own local source ("Cloud intake") so the
// identical hash -> dedupe -> analysis -> Jev -> sync job path Lane 1 uses
// runs unchanged. The scratch file (and the Firebase object) are deleted only
// after that asset's Arweave upload succeeds (see daemon.ts's
// UPLOAD_ASSET_ARWEAVE handling), never before.

export const CLOUD_INTAKE_SOURCE_LABEL = 'Cloud intake';
export const MAX_INTAKE_PER_DRAIN = 3;

/** Never under /Volumes or any NAS mount — always the OS temp dir. */
export function cloudIntakeRoot(): string {
  return path.join(os.tmpdir(), 'hitloop-archive-intake');
}

/** Registers (or reuses) the local "Cloud intake" source and publishes it to
 * HITLOOP like any other source, so it is visible in /archive even before its
 * first drain. Safe to call every daemon start: registerSource upserts by the
 * deterministic id derived from the resolved root path. */
export async function ensureCloudIntakeSource(
  db: ArchiveDatabase,
  control: ControlPlaneClient,
  workerId: string,
  root: string = cloudIntakeRoot(),
): Promise<ArchiveSource> {
  await fs.mkdir(root, { recursive: true });
  const worker = new ArchiveWorker(db);
  const source = await worker.registerSource(CLOUD_INTAKE_SOURCE_LABEL, root);
  try {
    // `kind` lets /archive hide this scratch source from Browse / Process Folder.
    await control.registerSource({ workerId, sourceId: source.id, label: source.label, state: source.state, kind: 'cloud-intake' });
  } catch {
    // Retried on the next daemon start / registration sweep; the local source
    // is already durable and usable regardless of HITLOOP visibility.
  }
  return source;
}

function sanitizeFileName(name: string | null | undefined): string {
  const base = path.basename(String(name || 'upload.bin'));
  const cleaned = base.replace(/[^\w.-]/g, '_');
  return cleaned || 'upload.bin';
}

function intakeTimestamp(item: IntakeItem): number {
  const value = item.createdAt as unknown;
  if (!value) return 0;
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; }
  if (typeof value === 'number') return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    if (typeof v.seconds === 'number') return (v.seconds as number) * 1000;
  }
  return 0;
}

async function downloadToScratch(item: IntakeItem, destDir: string, fetchImpl: typeof fetch): Promise<{ filePath: string; bytesWritten: number }> {
  await fs.mkdir(destDir, { recursive: true });
  const filePath = path.join(destDir, sanitizeFileName(item.fileName));
  const response = await fetchImpl(item.downloadUrl);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
  // Stream straight to disk. response.body is a WHATWG ReadableStream; never
  // buffer it into memory (mirrors the arweave uploader's own streaming rule).
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(filePath));
  const stat = await fs.stat(filePath);
  return { filePath, bytesWritten: stat.size };
}

async function reportFailed(control: ControlPlaneClient, workerId: string, intakeId: string, error: string): Promise<void> {
  try {
    await control.updateIntake({ intakeId, workerId, state: 'FAILED', error });
  } catch (patchError) {
    console.log(`cloud intake ${intakeId}: also failed to report FAILED: ${patchError instanceof Error ? patchError.message : String(patchError)}`);
  }
}

export interface DrainIntakeDeps {
  db: ArchiveDatabase;
  control: ControlPlaneClient;
  workerId: string;
  /** The registered "Cloud intake" source (see ensureCloudIntakeSource). */
  source: ArchiveSource;
  /** Runs the identical hash -> dedupe -> analysis -> Jev -> sync job path a
   * NAS folder uses, scoped to one selected subfolder of the source. */
  runCollectionJob: (sourceId: string, selectedRelativePath: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}

async function drainOne(item: IntakeItem, deps: Required<Pick<DrainIntakeDeps, 'db' | 'control' | 'workerId' | 'source' | 'runCollectionJob' | 'fetchImpl'>>): Promise<void> {
  const { db, control, workerId, source, runCollectionJob, fetchImpl } = deps;
  const destDir = path.join(source.rootPath, item.intakeId);

  try {
    await control.updateIntake({ intakeId: item.intakeId, workerId, state: 'CLAIMED' });
  } catch (error) {
    // Another worker likely claimed it first, or the doc raced to a
    // non-UPLOADED state; leave it for a later drain rather than fighting it.
    console.log(`cloud intake ${item.intakeId}: claim failed, skipping: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  let downloaded: { filePath: string; bytesWritten: number };
  try {
    downloaded = await downloadToScratch(item, destDir, fetchImpl);
  } catch (error) {
    await reportFailed(control, workerId, item.intakeId, `Download failed: ${error instanceof Error ? error.message : String(error)}`);
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  if (item.sizeBytes > 0 && downloaded.bytesWritten !== item.sizeBytes) {
    await reportFailed(control, workerId, item.intakeId, `Downloaded size ${downloaded.bytesWritten} does not match expected ${item.sizeBytes}`);
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  // Same job path Lane 1 (NAS folders) uses: hash, dedupe, TwelveLabs, Jev,
  // sync to HITLOOP. selectedRelativePath scopes it to just this intake's
  // scratch subfolder.
  await runCollectionJob(source.id, item.intakeId);

  const row = db.db.prepare(
    "SELECT content_asset_id AS contentAssetId, state FROM file_locations WHERE source_id=? AND relative_path LIKE ? ORDER BY relative_path LIMIT 1",
  ).get(source.id, `${item.intakeId}/%`) as { contentAssetId: string | null; state: string } | undefined;

  if (!row || !row.contentAssetId) {
    await reportFailed(control, workerId, item.intakeId, 'Hashing did not produce a content asset for this upload');
    return;
  }

  // A ContentAsset's id is its sha256 (see worker.ts insertAsset); duplicate
  // bytes resolve to the same id as an asset already hashed from elsewhere.
  if (row.state === 'DUPLICATE') {
    console.log(`cloud intake ${item.intakeId}: duplicate bytes, resolved to existing asset ${row.contentAssetId}`);
  }

  try {
    await control.updateIntake({ intakeId: item.intakeId, workerId, state: 'HASHED', sha256: row.contentAssetId, contentAssetId: row.contentAssetId });
  } catch (error) {
    console.log(`cloud intake ${item.intakeId}: failed to report HASHED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Drains at most MAX_INTAKE_PER_DRAIN UPLOADED intake docs, oldest first.
 * Never throws: a single item's failure is reported to HITLOOP (or logged)
 * and the drain moves on. */
export async function drainIntake(deps: DrainIntakeDeps): Promise<void> {
  const { db, control, workerId, source } = deps;
  const runCollectionJob = deps.runCollectionJob;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let items: IntakeItem[];
  try {
    items = await control.listIntake(workerId);
  } catch (error) {
    console.log(`cloud intake list failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const ordered = [...items].sort((a, b) => intakeTimestamp(a) - intakeTimestamp(b)).slice(0, MAX_INTAKE_PER_DRAIN);
  for (const item of ordered) {
    try {
      await drainOne(item, { db, control, workerId, source, runCollectionJob, fetchImpl });
    } catch (error) {
      console.log(`cloud intake ${item.intakeId}: drain failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The command's relativePath for a cloud-intake asset is `<intakeId>/<fileName>`. */
export function resolveIntakeIdFromRelativePath(relativePath: string): string {
  return relativePath.split('/')[0];
}

/** REVIEWED is observed, not decided, by the worker: an UPLOAD_ASSET_ARWEAVE
 * command only exists once HITLOOP's human review confirmed the asset (see
 * app/api/archive/review/route.js on the HITLOOP side). Best-effort: never
 * blocks the actual upload. */
export async function markIntakeReviewed(control: ControlPlaneClient, workerId: string, intakeId: string): Promise<void> {
  try {
    await control.updateIntake({ intakeId, workerId, state: 'REVIEWED' });
  } catch (error) {
    console.log(`cloud intake ${intakeId}: failed to mark REVIEWED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Called only after the worker's own Arweave upload command completed. Marks
 * ARCHIVED, purges the Firebase object (the only path that deletes it), then
 * removes the local scratch directory. If either HITLOOP call fails, the
 * scratch file is left in place and NOT deleted — the intake doc is no longer
 * UPLOADED either way, so a later drain (which only lists UPLOADED) will
 * never re-download it. */
export async function archiveAndPurgeIntake(params: { control: ControlPlaneClient; workerId: string; intakeId: string; root: string }): Promise<void> {
  const { control, workerId, intakeId, root } = params;
  try {
    await control.updateIntake({ intakeId, workerId, state: 'ARCHIVED' });
    await control.purgeIntake({ intakeId, workerId });
  } catch (error) {
    console.log(`cloud intake ${intakeId}: purge failed, scratch file retained: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    await fs.rm(path.join(root, intakeId), { recursive: true, force: true });
  } catch (error) {
    console.log(`cloud intake ${intakeId}: failed to remove scratch directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}
