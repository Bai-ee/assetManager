import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ArchiveDatabase } from '../database';
import { collectionMetaDir } from './scheme';

export type MoveReason = 'organize' | 'undo';

export interface MoveJournalEntry {
  ts: string;
  jobId: string;
  sha256: string;
  /** Both relative to the source's rootPath. */
  from: string;
  to: string;
  sizeBytes: number;
  reason: MoveReason;
}

export function journalPath(sourceRootPath: string, collectionId: string): string {
  return path.join(collectionMetaDir(sourceRootPath, collectionId), 'moves.jsonl');
}

/**
 * Appends one line to `<root>/<collectionId>/_meta/moves.jsonl`. Must be
 * called BEFORE the corresponding `fs.rename` (mover.ts) so a crash between
 * the two still leaves a durable record of intent.
 */
export async function appendMoveJournalLine(sourceRootPath: string, collectionId: string, entry: MoveJournalEntry): Promise<void> {
  const dir = collectionMetaDir(sourceRootPath, collectionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(journalPath(sourceRootPath, collectionId), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Reads back the on-disk journal for a collection. Returns `[]` when no
 * moves have ever been applied for it (file doesn't exist yet). This is the
 * human-inspectable / NAS-portable copy; `listOrganizeMovesForJob` (SQLite)
 * is the one undo actually replays from, per the "works even if the `_meta`
 * file is lost" requirement. */
export async function readMoveJournal(sourceRootPath: string, collectionId: string): Promise<MoveJournalEntry[]> {
  try {
    const text = await fs.readFile(journalPath(sourceRootPath, collectionId), 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as MoveJournalEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface OrganizeMoveRow {
  id: string;
  jobId: string;
  sha256: string;
  fromPath: string;
  toPath: string;
  sizeBytes: number;
  reason: MoveReason;
  createdAt: string;
}

/** SQLite mirror of one journal line. Called alongside
 * `appendMoveJournalLine`, before the rename, for the same durability
 * guarantee (and so undo works even without NAS access to the `_meta` file). */
export function recordOrganizeMove(db: ArchiveDatabase, params: { jobId: string; sha256: string; from: string; to: string; sizeBytes: number; reason: MoveReason }): void {
  db.insertOrganizeMove({
    id: randomUUID(),
    jobId: params.jobId,
    sha256: params.sha256,
    fromPath: params.from,
    toPath: params.to,
    sizeBytes: params.sizeBytes,
    reason: params.reason,
    createdAt: new Date().toISOString(),
  });
}

export function listOrganizeMovesForJob(db: ArchiveDatabase, jobId: string): OrganizeMoveRow[] {
  return db.listOrganizeMoves(jobId);
}
