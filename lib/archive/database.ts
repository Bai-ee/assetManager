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
      (id,source_id,selected_relative_path,state,created_at,updated_at,discovered,hashed,duplicates,failed)
      VALUES (@id,@sourceId,@selectedRelativePath,@state,@createdAt,@updatedAt,@discovered,@hashed,@duplicates,@failed)`)
      .run({...j,...j.counters});
  }

  getJob(id:string):CollectionJobRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM collection_jobs WHERE id=?').get(id); if(!r)return;
    return {id:r.id,sourceId:r.source_id,selectedRelativePath:r.selected_relative_path,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at,counters:{discovered:r.discovered,hashed:r.hashed,duplicates:r.duplicates,failed:r.failed}};
  }

  setJobState(id:string,state:CollectionJobRecord['state']) {
    this.db.prepare('UPDATE collection_jobs SET state=?, updated_at=? WHERE id=?').run(state,new Date().toISOString(),id);
  }

  bumpJob(id:string, field:'discovered'|'hashed'|'duplicates'|'failed') {
    this.db.prepare(`UPDATE collection_jobs SET ${field}=${field}+1, updated_at=? WHERE id=?`).run(new Date().toISOString(),id);
  }

  getLocation(id:string):FileLocationRecord|undefined {
    const r:any=this.db.prepare('SELECT * FROM file_locations WHERE id=?').get(id); if(!r)return;
    return {id:r.id,sourceId:r.source_id,relativePath:r.relative_path,sizeBytes:r.size_bytes,modifiedAtMs:r.modified_at_ms,discoveredAt:r.discovered_at,lastSeenAt:r.last_seen_at,state:r.state,contentAssetId:r.content_asset_id||undefined,error:r.error||undefined};
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
