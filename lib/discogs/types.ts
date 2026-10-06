/**
 * Shared types for the Discogs ingest POC.
 * Pipeline: scan folder -> dedupe -> group (one group per physical record)
 *   -> read labels (vision) -> match against Discogs -> plan -> (optional) apply.
 * Boundary rule: lib/discogs may import from lib/archive, never the reverse.
 */

export type MediaKind = 'image' | 'video';

export interface MediaFile {
  path: string;            // absolute path on the mount
  name: string;            // basename
  kind: MediaKind;
  size: number;
  fingerprint: string;     // sha256 over size + first/last 4 MB (cheap over SMB)
  capturedAt: string | null; // ISO; embedded capture time if found, else null
  mtime: string;           // ISO file mtime (fallback ordering)
  seq: number | null;      // IMG_0667 -> 667; null for FullSizeRender etc.
  duplicateOf: string | null; // path of the kept file when this is an exact duplicate
}

export interface RecordGroup {
  id: string;              // stable: 'g-' + first image fingerprint (12 chars)
  images: MediaFile[];
  videos: MediaFile[];
  groupedBy: 'capture-time' | 'sequence' | 'single';
}

export type LabelReadStatus = 'readable' | 'partial' | 'unreadable';

export interface LabelRead {
  file: string;            // basename of the image
  status: LabelReadStatus;
  artist: string | null;
  title: string | null;    // release title (EP / single name)
  label: string | null;    // record label name
  catno: string | null;    // catalog number as printed
  year: string | null;
  tracks: string[];        // track / mix names printed on the label
  side: string | null;     // 'A', 'B', 'logo side', ... when printed
  notes: string | null;    // anything else useful (price stickers excluded)
  model: string;
  cached: boolean;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

export interface DiscogsCandidate {
  releaseId: number;
  title: string;           // Discogs "Artist - Title"
  catno: string;
  label: string;
  formats: string[];
  country: string | null;
  year: string | null;
  score: number;           // 0..1
  reasons: string[];       // why it scored (e.g. 'catno exact', 'vinyl', 'label match')
}

export type PlannedAction = 'add' | 'already-owned' | 'review' | 'skip-unreadable';

export interface GroupPlan {
  group: RecordGroup;
  reads: LabelRead[];
  candidates: DiscogsCandidate[]; // sorted desc by score, max 5
  best: DiscogsCandidate | null;
  action: PlannedAction;
  reason: string;
}

export const ADD_THRESHOLD = 0.85;    // >= : auto-add on --apply
export const REVIEW_THRESHOLD = 0.5;  // >= : shown as review; below: no match
