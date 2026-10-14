export type ProcessingState =
  | 'DISCOVERED' | 'STABLE' | 'HASHING' | 'HASHED' | 'DUPLICATE' | 'QUEUED'
  | 'EXTRACTED' | 'ANALYZING' | 'ANALYZED' | 'JEV_PENDING' | 'JEV_CLASSIFIED'
  | 'REVIEW_PENDING' | 'APPROVED' | 'ARWEAVE_QUOTED' | 'UPLOAD_PENDING'
  | 'UPLOADING' | 'UPLOADED' | 'VERIFIED' | 'RETRYABLE_FAILED' | 'TERMINAL_FAILED';

export interface ArchiveSource {
  id: string;
  label: string;
  rootPath: string;
  state: 'ONLINE' | 'OFFLINE';
  createdAt: string;
  lastSeenAt: string;
}

export interface FileLocationRecord {
  id: string;
  sourceId: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  discoveredAt: string;
  lastSeenAt: string;
  state: ProcessingState;
  contentAssetId?: string;
  error?: string;
  /** Set by the organizer (`lib/archive/organize/mover.ts`) once this
   * location's bytes have been moved into `<rootPath>/HITLOOP-ARCHIVE/…`.
   * `organizedPath` is relative to the source rootPath, same convention as
   * `relativePath`. Absent/undefined means not yet organized. */
  organizedPath?: string;
  organizedAt?: string;
}

export interface ContentAssetRecord {
  id: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  state: ProcessingState;
}

/** One entry in a `PROCESS_SELECTION`/`ORGANIZE_COLLECTION{items}` picker
 * selection — either an explicit file or a folder (walked recursively).
 * `relativePath` is always relative to the source's rootPath. */
export interface SelectionItem {
  relativePath: string;
  kind: 'file' | 'folder';
}

export interface CollectionJobRecord {
  id: string;
  sourceId: string;
  selectedRelativePath: string;
  /** `CANCELLED` is a terminal state, distinct from `PAUSED` (offline/error,
   * resumable) and `FAILED` (the owning command didn't complete): the owner
   * explicitly stopped the job via `CANCEL_JOB`. Never resumable —
   * `ArchiveWorker.resume`/`listResumableJobs` both exclude it. */
  state: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  updatedAt: string;
  counters: {
    discovered: number;
    hashed: number;
    duplicates: number;
    failed: number;
  };
  /** Present only for a `PROCESS_SELECTION` job (see `worker.ts` `createJob`):
   * an explicit set of file/folder items to discover, in place of walking
   * `selectedRelativePath`. Absent for an ordinary `PROCESS_COLLECTION` job. */
  selection?: SelectionItem[];
  /** Present only for a `PROCESS_SELECTION` job: the caller-supplied
   * collection id this selection belongs to. */
  collectionId?: string;
  /** When true, discovery only yields files whose extension passes
   * `organize/scheme.ts` `isMovableExtension` (video + image); everything
   * else is skipped before stat/hash (see `worker.ts` `run()`). Persisted so
   * a resumed job keeps the same policy it started with. Absent/false =
   * unchanged prior behavior (every file is hashed). */
  mediaOnly?: boolean;
  /** In-memory only — never persisted to SQLite, never present on a job read
   * back via `getJob()`. Attached by `ArchiveWorker.run()` to the record it
   * returns when a `mediaOnly` job reaches COMPLETE, so the daemon can log a
   * one-line skip count on the command result without a counters-schema
   * migration. */
  skippedNonMedia?: number;
}
