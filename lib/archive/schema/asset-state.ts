export type EvidenceSource = 'filesystem' | 'metadata' | 'twelvelabs' | 'human';

export interface ArchiveEvidence {
  source: EvidenceSource;
  field: string;
  value: unknown;
  confidence?: number;
  observationId?: string;
}

export interface AssetState {
  assetId: string;
  sha256: string;
  mediaType: 'video' | 'image' | 'audio' | 'document' | 'other';
  sourcePaths: string[];
  evidence: ArchiveEvidence[];
  observations: Array<{
    provider: string;
    kind: string;
    status: string;
    summary?: string;
    payload?: unknown;
  }>;
}

/**
 * Compact decision input. Raw media never belongs here.
 * Jev receives normalized evidence produced by perception/extraction layers.
 */
export function buildAssetState(input: {
  assetId:string; sha256:string; mediaType:AssetState['mediaType'];
  sourcePaths:string[]; evidence?:ArchiveEvidence[]; observations?:AssetState['observations'];
}):AssetState {
  return {assetId:input.assetId,sha256:input.sha256,mediaType:input.mediaType,sourcePaths:input.sourcePaths,evidence:input.evidence||[],observations:input.observations||[]};
}
