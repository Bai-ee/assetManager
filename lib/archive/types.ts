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
}

export interface ContentAssetRecord {
  id: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  state: ProcessingState;
}

export interface CollectionJobRecord {
  id: string;
  sourceId: string;
  selectedRelativePath: string;
  state: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  counters: {
    discovered: number;
    hashed: number;
    duplicates: number;
    failed: number;
  };
}
