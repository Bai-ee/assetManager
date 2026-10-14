import * as fs from 'fs/promises';
import * as path from 'path';
import type { ArchiveDatabase } from '../database';
import type { ArchiveSource } from '../types';
import { ORGANIZED_ROOT_NAME, organizedCollectionFromRelativePath, collectionTitleFromPath, isUnderOrganizedRoot } from './scheme';
import { appendMoveJournalLine, listOrganizeMovesForJob, recordOrganizeMove } from './journal';
import { writeAssetRecordSidecar, writeCollectionSidecar } from './sidecars';
import type { OrganizePlan, OrganizePlanMove } from './planner';

export interface ApplyOrganizeFailure {
  move: OrganizePlanMove;
  error: string;
}

export interface ApplyOrganizeResult {
  jobId: string;
  moved: OrganizePlanMove[];
  failedAt?: ApplyOrganizeFailure;
}

/**
 * Performs every move in `plan.moves`, one file at a time, in order:
 * assert the target resolves under HITLOOP-ARCHIVE/ (hard fail otherwise) ->
 * mkdir -p -> append journal line (disk + SQLite) -> fs.rename -> fs.stat to
 * verify size. On any failure (including EXDEV) the job stops there; files
 * already moved stay moved (the journal makes them recoverable via undo) —
 * never a copy+delete, never a raw `rm`.
 */
export async function applyOrganizePlan(params: {
  db: ArchiveDatabase;
  source: ArchiveSource;
  /** Identifies this specific apply run — the caller's command id, unique
   * per ORGANIZE_COLLECTION{mode:'apply'} invocation. Journaled with every
   * move and what UNDO_ORGANIZE replays against. */
  jobId: string;
  plan: OrganizePlan;
}): Promise<ApplyOrganizeResult> {
  const { db, source, jobId, plan } = params;
  const sourceRoot = path.resolve(source.rootPath);
  const moved: OrganizePlanMove[] = [];

  const finish = async (failedAt?: ApplyOrganizeFailure): Promise<ApplyOrganizeResult> => {
    // Best-effort sidecars, reflecting whatever succeeded even on a partial
    // failure. Never allowed to turn a successful apply into a failed one.
    try {
      await writeCollectionSidecar({
        sourceRootPath: sourceRoot,
        collectionId: plan.collectionId,
        clientSlug: plan.clientSlug,
        // An items-selection plan has no single path to title itself with;
        // the collectionId (the caller-supplied/HITLOOP-picker id) stands in.
        title: plan.selection ? plan.collectionId : collectionTitleFromPath(plan.selectedRelativePath || '.'),
        sourceRelativePath: plan.selectedRelativePath,
        selection: plan.selection,
        plan,
        moved,
      });
      for (const move of moved) {
        await writeAssetRecordSidecar({ db, sourceRootPath: sourceRoot, collectionId: plan.collectionId, clientSlug: plan.clientSlug, move });
      }
    } catch { /* sidecars are a convenience copy; SQLite remains authoritative */ }
    return { jobId, moved, failedAt };
  };

  for (const move of plan.moves) {
    const fromAbs = path.resolve(sourceRoot, move.from);
    const toAbs = path.resolve(sourceRoot, move.to);

    if (!isUnderOrganizedRoot(sourceRoot, toAbs)) {
      return finish({ move, error: `Organize target escapes ${ORGANIZED_ROOT_NAME}: ${move.to}` });
    }

    const location = db.getLocationByRelativePath(source.id, move.from);
    if (!location) {
      return finish({ move, error: `No file_locations row for ${move.from}` });
    }

    try {
      await fs.mkdir(path.dirname(toAbs), { recursive: true });

      const ts = new Date().toISOString();
      // Journaled BEFORE the rename, on disk and in SQLite, so a crash
      // between the two still leaves durable evidence of intent.
      await appendMoveJournalLine(sourceRoot, plan.collectionId, { ts, jobId, sha256: move.sha256, from: move.from, to: move.to, sizeBytes: move.sizeBytes, reason: 'organize' }, plan.clientSlug);
      recordOrganizeMove(db, { jobId, sha256: move.sha256, from: move.from, to: move.to, sizeBytes: move.sizeBytes, reason: 'organize' });

      await fs.rename(fromAbs, toAbs);
      const stat = await fs.stat(toAbs);
      if (stat.size !== move.sizeBytes) {
        throw new Error(`size mismatch after move: expected ${move.sizeBytes}, got ${stat.size}`);
      }

      db.setLocationOrganized(location.id, move.to, ts);
      moved.push(move);
    } catch (error) {
      return finish({ move, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return finish();
}

export interface UndoOrganizeResult {
  jobId: string;
  /** Original (`from`) relative paths successfully restored. */
  restored: string[];
  errors: Array<{ from: string; to: string; error: string }>;
}

/**
 * Replays one apply job's moves backwards: for each journaled move (newest
 * first), renames `to` back to `from` and verifies size. Reads from the
 * SQLite `organize_moves` mirror (not the NAS `_meta/moves.jsonl` file), so
 * undo still works if that sidecar file is lost. Stops on the first failure,
 * leaving the remainder recoverable from the same table on a later retry.
 */
export async function undoOrganizeJob(params: {
  db: ArchiveDatabase;
  source: ArchiveSource;
  jobId: string;
}): Promise<UndoOrganizeResult> {
  const { db, source, jobId } = params;
  const sourceRoot = path.resolve(source.rootPath);
  const moves = listOrganizeMovesForJob(db, jobId).filter(m => m.reason === 'organize');
  const restored: string[] = [];
  const errors: UndoOrganizeResult['errors'] = [];

  for (const move of [...moves].reverse()) {
    const currentAbs = path.resolve(sourceRoot, move.toPath);
    const restoreAbs = path.resolve(sourceRoot, move.fromPath);
    const collection = organizedCollectionFromRelativePath(move.toPath);

    try {
      await fs.mkdir(path.dirname(restoreAbs), { recursive: true });
      const ts = new Date().toISOString();
      if (collection) {
        await appendMoveJournalLine(sourceRoot, collection.collectionId, { ts, jobId, sha256: move.sha256, from: move.toPath, to: move.fromPath, sizeBytes: move.sizeBytes, reason: 'undo' }, collection.clientSlug);
      }
      recordOrganizeMove(db, { jobId, sha256: move.sha256, from: move.toPath, to: move.fromPath, sizeBytes: move.sizeBytes, reason: 'undo' });

      await fs.rename(currentAbs, restoreAbs);
      const stat = await fs.stat(restoreAbs);
      if (stat.size !== move.sizeBytes) {
        throw new Error(`size mismatch on undo: expected ${move.sizeBytes}, got ${stat.size}`);
      }

      // `relative_path` never changes across an organize/undo cycle — only
      // organized_path/organized_at track current location.
      const location = db.getLocationByRelativePath(source.id, move.fromPath);
      if (location) db.setLocationOrganized(location.id, null, null);
      restored.push(move.fromPath);
    } catch (error) {
      errors.push({ from: move.fromPath, to: move.toPath, error: error instanceof Error ? error.message : String(error) });
      break; // remaining moves stay recoverable via organize_moves on retry
    }
  }

  return { jobId, restored, errors };
}
