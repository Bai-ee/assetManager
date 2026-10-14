import * as fs from 'fs/promises';
import * as path from 'path';
import type { ArchiveDatabase } from '../database';
import { inferMediaType } from '../media-type';
import { collectionMetaDir } from './scheme';
import type { OrganizePlan, OrganizePlanMove } from './planner';
import type { SelectionItem } from '../types';

const SIDECAR_SCHEMA = 'hitloop-archive-sidecar/0' as const;

export interface CollectionSidecar {
  schema: typeof SIDECAR_SCHEMA;
  collectionId: string;
  title: string;
  /** Present for a single-selected-folder apply. Mutually exclusive with
   * `selection`. */
  sourceRelativePath?: string;
  /** Present for an explicit-items (`PROCESS_SELECTION`/
   * `ORGANIZE_COLLECTION{items}`) apply. Mutually exclusive with
   * `sourceRelativePath`. */
  selection?: SelectionItem[];
  organizedAt: string;
  assets: Array<{ sha256: string; from: string; to: string; pillar: string; confidence: number | null }>;
  skipped: Array<{ path: string; reason: string }>;
}

/** `_meta/collection.json` — a latest-state summary of the most recent apply
 * for this collection (moved assets + everything skipped and why). Not an
 * accumulating history across multiple applies; `moves.jsonl` is the
 * append-only history for that. Records `selection` in place of
 * `sourceRelativePath` when the apply was planned from an explicit item
 * selection. */
export async function writeCollectionSidecar(params: {
  sourceRootPath: string;
  collectionId: string;
  title: string;
  sourceRelativePath?: string;
  selection?: SelectionItem[];
  plan: OrganizePlan;
  moved: OrganizePlanMove[];
}): Promise<string> {
  const dir = collectionMetaDir(params.sourceRootPath, params.collectionId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'collection.json');
  const sidecar: CollectionSidecar = {
    schema: SIDECAR_SCHEMA,
    collectionId: params.collectionId,
    title: params.title,
    ...(params.selection ? { selection: params.selection } : { sourceRelativePath: params.sourceRelativePath ?? '.' }),
    organizedAt: new Date().toISOString(),
    assets: params.moved.map(m => ({ sha256: m.sha256, from: m.from, to: m.to, pillar: m.pillar, confidence: m.confidence })),
    skipped: params.plan.skipped,
  };
  await fs.writeFile(filePath, JSON.stringify(sidecar, null, 2), 'utf8');
  return filePath;
}

export interface AssetRecordSidecar {
  schema: typeof SIDECAR_SCHEMA;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  originalRelativePath: string;
  organizedRelativePath: string;
  decisions: unknown[];
  observationsSummary: Array<{ provider: string; kind: string; status: string; summary?: string }>;
}

/** `_meta/<sha12>.record.json` — one per moved asset, carrying every Jev
 * decision (not just pillar) and an observation summary, so the sidecar is a
 * self-contained provenance record independent of HITLOOP/SQLite. */
export async function writeAssetRecordSidecar(params: {
  db: ArchiveDatabase;
  sourceRootPath: string;
  collectionId: string;
  move: OrganizePlanMove;
}): Promise<string> {
  const { db, sourceRootPath, collectionId, move } = params;
  const dir = collectionMetaDir(sourceRootPath, collectionId);
  await fs.mkdir(dir, { recursive: true });
  const sha12 = move.sha256.slice(0, 12);
  const filePath = path.join(dir, `${sha12}.record.json`);
  // content_asset_id === sha256 (see worker.ts insertAsset), so this is the
  // same lookup key `db.listJevDecisions`/`db.listObservations` expect.
  const decisions = db.listJevDecisions(move.sha256);
  const observations = db.listObservations(move.sha256).map(o => ({ provider: o.provider, kind: o.kind, status: o.status, summary: o.summary }));
  const record: AssetRecordSidecar = {
    schema: SIDECAR_SCHEMA,
    sha256: move.sha256,
    sizeBytes: move.sizeBytes,
    mediaType: inferMediaType(move.from),
    originalRelativePath: move.from,
    organizedRelativePath: move.to,
    decisions,
    observationsSummary: observations,
  };
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
  return filePath;
}
