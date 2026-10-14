import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { ArchiveSource, CollectionJobRecord, ContentAssetRecord, FileLocationRecord } from './types';

const DEFAULT_DB = path.join(process.cwd(), '.moleboard', 'archive.sqlite');

export class ArchiveDatabase {
  readonly db: Database.Database;

  constructor(filePath = DEFAULT_DB) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.recoverInterruptedJobs();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection_jobs (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, selected_relative_path TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        discovered INTEGER NOT NULL DEFAULT 0, hashed INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(source_id) REFERENCES sources(id)
      );
      CREATE TABLE IF NOT EXISTS content_assets (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_locations (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
        discovered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, state TEXT NOT NULL,
        content_asset_id TEXT, error TEXT,
        UNIQUE(source_id, relative_path),
        FOREIGN KEY(source_id) REFERENCES sources(id),
        FOREIGN KEY(content_asset_id) REFERENCES content_assets(id)
      );
      CREATE INDEX IF NOT EXISTS idx_locations_asset ON file_locations(content_asset_id);
      CREATE INDEX IF NOT EXISTS idx_locations_state ON file_locations(state);
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON collection_jobs(state);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, content_asset_id TEXT NOT NULL, provider TEXT NOT NULL,
        provider_asset_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
        summary TEXT, payload_json TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(content_asset_id) REFERENCES content_assets(id)
      );
      CREATE INDEX IF NOT EXISTS idx_observations_asset ON observations(content_asset_id);
      CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(status);
      CREATE TABLE IF NOT EXISTS jev_decisions (
        id TEXT PRIMARY KEY, content_asset_id TEXT NOT NULL, question TEXT NOT NULL,
        choices_json TEXT NOT NULL, selected_value TEXT, confidence REAL,
        status TEXT NOT NULL, evidence_json TEXT, human_value TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(content_asset_id) REFERENCES content_assets(id)
      );
      CREATE INDEX IF NOT EXISTS idx_jev_asset ON jev_decisions(content_asset_id);
      CREATE INDEX IF NOT EXISTS idx_jev_status ON jev_decisions(status);
    `);

    // Organizer support (W-B, docs/plans/ARCHIVE-NAS-STAGING-MASTER-PLAN-2026-09-20.md
    // §3b): where a canonical location was moved to inside
    // `<rootPath>/HITLOOP-ARCHIVE/…`, plus a SQLite mirror of the append-only
    // move journal so UNDO_ORGANIZE works even if the NAS `_meta` sidecar file
    // is lost. Guarded ALTER so migrate() stays idempotent on an existing DB
    // (SQLite has no `ADD COLUMN IF NOT EXISTS`).
    const fileLocationColumns = this.db.prepare("PRAGMA table_info(file_locations)").all() as Array<{ name: string }>;
    if (!fileLocationColumns.some(c => c.name === 'organized_path')) {
      this.db.exec('ALTER TABLE file_locations ADD COLUMN organized_path TEXT');
      this.db.exec('ALTER TABLE file_locations ADD COLUMN organized_at TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS organize_moves (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, sha256 TEXT NOT NULL,
        from_path TEXT NOT NULL, to_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_organize_moves_job ON organize_moves(job_id);
      CREATE INDEX IF NOT EXISTS idx_organize_moves_to ON organize_moves(to_path);
    `);

    // Selection jobs (PROCESS_SELECTION — docs/archive/ORGANIZER.md
    // "Selections"): a job may carry an explicit file/folder item list
    // instead of (or in addition to labeling) a single `selected_relative_path`.
    // Guarded ALTER so migrate() stays idempotent on an existing DB.
    const collectionJobColumns = this.db.prepare("PRAGMA table_info(collection_jobs)").all() as Array<{ name: string }>;
    if (!collectionJobColumns.some(c => c.name === 'selection_json')) {
      this.db.exec('ALTER TABLE collection_jobs ADD COLUMN selection_json TEXT');
      this.db.exec('ALTER TABLE collection_jobs ADD COLUMN collection_id TEXT');
    }

    // Media-only hashing (CANCEL_JOB + media-only workstream,
    // docs/plans/ARCHIVE-NAS-STAGING-MASTER-PLAN-2026-09-20.md): persisted so
    // a resumed PAUSED/FAILED job re-applies the same discovery filter it
    // started with. Guarded ALTER so migrate() stays idempotent.
    if (!collectionJobColumns.some(c => c.name === 'media_only')) {
      this.db.exec('ALTER TABLE collection_jobs ADD COLUMN media_only INTEGER NOT NULL DEFAULT 0');
    }
  }

  close() { this.db.close(); }

  listResumableJobs(): CollectionJobRecord[] {
    return [...this.listJobsByState('PAUSED'), ...this.listJobsByState('FAILED')];
  }

  listJobsByState(state: CollectionJobRecord['state']): CollectionJobRecord[] {
    return (this.db.prepare('SELECT id FROM collection_jobs WHERE state=?').all(state) as Array<{id:string}>)
      .map(r => this.getJob(r.id)!)
      .filter(Boolean);
  }

  recoverInterruptedJobs() {
    this.db.prepare("UPDATE collection_jobs SET state='PAUSED', updated_at=? WHERE state='RUNNING'")
      .run(new Date().toISOString());
    this.db.prepare("UPDATE file_locations SET state='RETRYABLE_FAILED', error=COALESCE(error, 'Worker interrupted') WHERE state IN ('HASHING','ANALYZING','UPLOADING')")
      .run();
  }

  upsertSource(s: ArchiveSource) {
    this.db.prepare(`INSERT INTO sources VALUES (@id,@label,@rootPath,@state,@createdAt,@lastSeenAt)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, root_path=excluded.root_path, state=excluded.state, last_seen_at=excluded.last_seen_at`).run(s);
  }

  listSources(): ArchiveSource[] {
    const rows:any[] = this.db.prepare('SELECT * FROM sources ORDER BY label').all();
    return rows.map(r => ({id:r.id,label:r.label,rootPath:r.root_path,state:r.state,createdAt:r.created_at,lastSeenAt:r.last_seen_at}));
  }

  getSource(id: string): ArchiveSource | undefined {
    const r:any=this.db.prepare('SELECT * FROM sources WHERE id=?').get(id); if(!r)return;
    return {id:r.id,label:r.label,rootPath:r.root_path,state:r.state,createdAt:r.created_at,lastSeenAt:r.last_seen_at};
  }

  insertJob(j: CollectionJobRecord) {
    this.db.prepare(`INSERT INTO collection_jobs
      (id,source_id,selected_relative_path,state,created_at,updated_at,discovered,hashed,duplicates,failed,selection_json,collection_id,media_only)
      VALUES (@id,@sourceId,@selectedRelativePath,@state,@createdAt,@updatedAt,@discovered,@hashed,@duplicates,@failed,@selectionJson,@collectionId,@mediaOnly)`)
      .run({
        id: j.id, sourceId: j.sourceId, selectedRelativePath: j.selectedRelativePath, state: j.state,
        createdAt: j.createdAt, updatedAt: j.updatedAt,
        discovered: j.counters.discovered, hashed: j.counters.hashed, duplicates: j.counters.duplicates, failed: j.counters.failed,
        selectionJson: j.selection ? JSON.stringify(j.selection) : null,
        collectionId: j.collectionId ?? null,
        mediaOnly: j.mediaOnly ? 1 : 0,
      });
  }

  getJob(id:string):CollectionJobRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM collection_jobs WHERE id=?').get(id); if(!r)return;
    return {
      id:r.id,sourceId:r.source_id,selectedRelativePath:r.selected_relative_path,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at,
      counters:{discovered:r.discovered,hashed:r.hashed,duplicates:r.duplicates,failed:r.failed},
      ...(r.selection_json ? { selection: JSON.parse(r.selection_json) } : {}),
      ...(r.collection_id ? { collectionId: r.collection_id } : {}),
      ...(r.media_only ? { mediaOnly: true } : {}),
    };
  }

  setJobState(id:string,state:CollectionJobRecord['state']) {
    this.db.prepare('UPDATE collection_jobs SET state=?, updated_at=? WHERE id=?').run(state,new Date().toISOString(),id);
  }

  bumpJob(id:string, field:'discovered'|'hashed'|'duplicates'|'failed') {
    this.db.prepare(`UPDATE collection_jobs SET ${field}=${field}+1, updated_at=? WHERE id=?`).run(new Date().toISOString(),id);
  }

  getLocation(id:string):FileLocationRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM file_locations WHERE id=?').get(id); if(!r)return;
    return {id:r.id,sourceId:r.source_id,relativePath:r.relative_path,sizeBytes:r.size_bytes,modifiedAtMs:r.modified_at_ms,discoveredAt:r.discovered_at,lastSeenAt:r.last_seen_at,state:r.state,contentAssetId:r.content_asset_id||undefined,error:r.error||undefined,organizedPath:r.organized_path||undefined,organizedAt:r.organized_at||undefined};
  }

  /** Look up a location by its stable identity (source + the original
   * discovery relative path, which never changes once organized — only
   * `organized_path`/`organized_at` move). Used by the organizer, which has
   * no reason to know the internal `locationId` hash scheme. */
  getLocationByRelativePath(sourceId:string, relativePath:string):FileLocationRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM file_locations WHERE source_id=? AND relative_path=?').get(sourceId, relativePath); if(!r)return;
    return {id:r.id,sourceId:r.source_id,relativePath:r.relative_path,sizeBytes:r.size_bytes,modifiedAtMs:r.modified_at_ms,discoveredAt:r.discovered_at,lastSeenAt:r.last_seen_at,state:r.state,contentAssetId:r.content_asset_id||undefined,error:r.error||undefined,organizedPath:r.organized_path||undefined,organizedAt:r.organized_at||undefined};
  }

  /** Every location (across sources) that currently resolves to one content
   * asset. The organizer uses it to decide whether a DUPLICATE location in
   * the selected folder is the copy to organize (canonical lives elsewhere)
   * or a true in-folder duplicate. */
  listLocationsForAsset(contentAssetId:string):FileLocationRecord[] {
    const rows:any[]=this.db.prepare('SELECT * FROM file_locations WHERE content_asset_id=? ORDER BY discovered_at').all(contentAssetId);
    return rows.map(r=>({id:r.id,sourceId:r.source_id,relativePath:r.relative_path,sizeBytes:r.size_bytes,modifiedAtMs:r.modified_at_ms,discoveredAt:r.discovered_at,lastSeenAt:r.last_seen_at,state:r.state,contentAssetId:r.content_asset_id||undefined,error:r.error||undefined,organizedPath:r.organized_path||undefined,organizedAt:r.organized_at||undefined}));
  }

  /** Set/clear where this location's bytes currently sit inside
   * `HITLOOP-ARCHIVE/…`. Pass nulls to undo (restored to its original
   * `relativePath`, which is never itself rewritten). */
  setLocationOrganized(id:string, organizedPath:string|null, organizedAt:string|null) {
    this.db.prepare('UPDATE file_locations SET organized_path=?, organized_at=? WHERE id=?').run(organizedPath, organizedAt, id);
  }

  insertOrganizeMove(x:{id:string;jobId:string;sha256:string;fromPath:string;toPath:string;sizeBytes:number;reason:'organize'|'undo';createdAt:string}) {
    this.db.prepare(`INSERT INTO organize_moves (id,job_id,sha256,from_path,to_path,size_bytes,reason,created_at)
      VALUES (@id,@jobId,@sha256,@fromPath,@toPath,@sizeBytes,@reason,@createdAt)`).run(x);
  }

  listOrganizeMoves(jobId:string):Array<{id:string;jobId:string;sha256:string;fromPath:string;toPath:string;sizeBytes:number;reason:'organize'|'undo';createdAt:string}> {
    const rows:any[]=this.db.prepare('SELECT * FROM organize_moves WHERE job_id=? ORDER BY created_at ASC, rowid ASC').all(jobId);
    return rows.map(r=>({id:r.id,jobId:r.job_id,sha256:r.sha256,fromPath:r.from_path,toPath:r.to_path,sizeBytes:r.size_bytes,reason:r.reason,createdAt:r.created_at}));
  }

  /** For `UNDO_ORGANIZE { sourceId, relativePath }` (no explicit jobId): the
   * most recent organize-apply job that moved anything into this
   * collectionId. 'HITLOOP-ARCHIVE' must match `organize/scheme.ts`'s
   * ORGANIZED_ROOT_NAME — duplicated as a literal here (not imported) so
   * database.ts never depends on worker.ts/organize/* (worker.ts already
   * depends on database.ts; importing back would cycle). */
  findLatestOrganizeJobIdForCollection(collectionId:string):string|undefined {
    const like = `HITLOOP-ARCHIVE/${collectionId}/%`;
    const row = this.db.prepare(`SELECT job_id FROM organize_moves WHERE to_path LIKE ? AND reason='organize' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(like) as {job_id:string}|undefined;
    return row?.job_id;
  }

  upsertLocation(x:FileLocationRecord) {
    this.db.prepare(`INSERT INTO file_locations
      (id,source_id,relative_path,size_bytes,modified_at_ms,discovered_at,last_seen_at,state,content_asset_id,error)
      VALUES (@id,@sourceId,@relativePath,@sizeBytes,@modifiedAtMs,@discoveredAt,@lastSeenAt,@state,@contentAssetId,@error)
      ON CONFLICT(id) DO UPDATE SET size_bytes=excluded.size_bytes, modified_at_ms=excluded.modified_at_ms,
      last_seen_at=excluded.last_seen_at, state=excluded.state, content_asset_id=excluded.content_asset_id, error=excluded.error`)
      .run({...x,contentAssetId:x.contentAssetId??null,error:x.error??null});
  }

  upsertObservation(x:{id:string;contentAssetId:string;provider:string;providerAssetId?:string;kind:string;status:string;summary?:string;payload?:unknown;error?:string}) {
    const now=new Date().toISOString();
    this.db.prepare(`INSERT INTO observations
      (id,content_asset_id,provider,provider_asset_id,kind,status,summary,payload_json,error,created_at,updated_at)
      VALUES (@id,@contentAssetId,@provider,@providerAssetId,@kind,@status,@summary,@payloadJson,@error,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET provider_asset_id=excluded.provider_asset_id,status=excluded.status,
      summary=excluded.summary,payload_json=excluded.payload_json,error=excluded.error,updated_at=excluded.updated_at`)
      .run({...x,providerAssetId:x.providerAssetId??null,summary:x.summary??null,payloadJson:x.payload===undefined?null:JSON.stringify(x.payload),error:x.error??null,createdAt:now,updatedAt:now});
  }

  listObservations(contentAssetId:string) {
    const rows:any[]=this.db.prepare('SELECT * FROM observations WHERE content_asset_id=? ORDER BY created_at').all(contentAssetId);
    return rows.map(r=>({id:r.id,contentAssetId:r.content_asset_id,provider:r.provider,providerAssetId:r.provider_asset_id||undefined,kind:r.kind,status:r.status,summary:r.summary||undefined,payload:r.payload_json?JSON.parse(r.payload_json):undefined,error:r.error||undefined,createdAt:r.created_at,updatedAt:r.updated_at}));
  }

  upsertJevDecision(x:{id:string;contentAssetId:string;question:string;choices:Array<{value:string;probability:number}>;selectedValue?:string;confidence?:number;status:string;evidence?:unknown;humanValue?:string}) {
    const now=new Date().toISOString();
    this.db.prepare(`INSERT INTO jev_decisions
      (id,content_asset_id,question,choices_json,selected_value,confidence,status,evidence_json,human_value,created_at,updated_at)
      VALUES (@id,@contentAssetId,@question,@choicesJson,@selectedValue,@confidence,@status,@evidenceJson,@humanValue,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET choices_json=excluded.choices_json,selected_value=excluded.selected_value,
      confidence=excluded.confidence,status=excluded.status,evidence_json=excluded.evidence_json,human_value=excluded.human_value,updated_at=excluded.updated_at`)
      .run({...x,choicesJson:JSON.stringify(x.choices),selectedValue:x.selectedValue??null,confidence:x.confidence??null,evidenceJson:x.evidence===undefined?null:JSON.stringify(x.evidence),humanValue:x.humanValue??null,createdAt:now,updatedAt:now});
  }

  listJevDecisions(contentAssetId:string) {
    const rows:any[]=this.db.prepare('SELECT * FROM jev_decisions WHERE content_asset_id=? ORDER BY created_at').all(contentAssetId);
    return rows.map(r=>({id:r.id,contentAssetId:r.content_asset_id,question:r.question,choices:JSON.parse(r.choices_json),selectedValue:r.selected_value||undefined,confidence:r.confidence??undefined,status:r.status,evidence:r.evidence_json?JSON.parse(r.evidence_json):undefined,humanValue:r.human_value||undefined,createdAt:r.created_at,updatedAt:r.updated_at}));
  }

  getAsset(id:string):ContentAssetRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM content_assets WHERE id=?').get(id); if(!r)return;
    return {id:r.id,sha256:r.sha256,sizeBytes:r.size_bytes,createdAt:r.created_at,state:r.state};
  }

  listAssetLocations(contentAssetId:string):FileLocationRecord[] {
    const rows:any[]=this.db.prepare('SELECT * FROM file_locations WHERE content_asset_id=? ORDER BY relative_path').all(contentAssetId);
    return rows.map(r=>({id:r.id,sourceId:r.source_id,relativePath:r.relative_path,sizeBytes:r.size_bytes,modifiedAtMs:r.modified_at_ms,discoveredAt:r.discovered_at,lastSeenAt:r.last_seen_at,state:r.state,contentAssetId:r.content_asset_id||undefined,error:r.error||undefined,organizedPath:r.organized_path||undefined,organizedAt:r.organized_at||undefined}));
  }

  setAssetState(id:string,state:ContentAssetRecord['state']) {
    this.db.prepare('UPDATE content_assets SET state=? WHERE id=?').run(state,id);
  }

  findAssetByHash(hash:string):ContentAssetRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM content_assets WHERE sha256=?').get(hash); if(!r)return;
    return {id:r.id,sha256:r.sha256,sizeBytes:r.size_bytes,createdAt:r.created_at,state:r.state};
  }

  insertAsset(x:ContentAssetRecord) {
    this.db.prepare('INSERT OR IGNORE INTO content_assets (id,sha256,size_bytes,created_at,state) VALUES (@id,@sha256,@sizeBytes,@createdAt,@state)').run(x);
  }
}
