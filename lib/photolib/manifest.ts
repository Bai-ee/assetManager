/**
 * Local photolib manifest (SQLite, WAL) — schema per docs/archive/PHOTOLIB.md.
 * Row types are camelCase; columns are snake_case (`size_bytes` <-> `sizeBytes`). Mapping is mechanical.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SourceRow { id: string; kind: string; libraryPath: string; label: string | null; addedAt: string }

export interface AssetRow {
  sha256: string; id: string; kind: string; ext: string; sizeBytes: number;
  width: number | null; height: number | null; durationSec: number | null;
  takenLocal: string | null; tz: string | null; tzOffsetSec: number | null; tsUtc: string | null; tsSource: string | null; tsKind: string;
  lat: number | null; lon: number | null;
  canonicalPath: string; sidecarPath: string; sidecarJson: string;
  copiedAt: string | null; verifiedAt: string | null; thumbS: string | null; thumbM: string | null;
  pushedAt: string | null; pushHash: string | null; updatedAt: string;
}

export interface ChildRow {
  parentSha: string; role: string; sha256: string; ext: string; sizeBytes: number;
  durationSec: number | null; canonicalPath: string; copiedAt: string | null;
}

export interface LocationRow {
  sourceId: string; relativePath: string; sha256: string; masterUuid: string | null; versionUuid: string | null; originalFileName: string;
}

export interface RunRow { runId: string; sourceId: string; command: string; startedAt: string; finishedAt: string | null; state: string; summaryJson: string | null }

/**
 * role: 'primary' | 'motion' | 'edited' | 'sidecar' (file created at destPath) |
 * 'raw-deleted' (move mode: the source copy at srcPath was deleted after its identical file at destPath was verified).
 * srcPath (share-relative) is set for move-mode rows: undo moves the file back / restores the raw copy there.
 * Full-metadata files in _meta/ (metadata.ts) are not journaled: undo never removes captured metadata.
 */
export interface JournalRow { id: number; runId: string; sha256: string; role: string; destPath: string; sizeBytes: number; at: string; undoneAt: string | null; srcPath?: string | null }
export type JournalEntry = Omit<JournalRow, 'id' | 'undoneAt'>;

const SCHEMA = `
create table if not exists sources (id text primary key, kind text not null, library_path text not null, label text, added_at text not null);
create table if not exists assets (sha256 text primary key, id text not null, kind text not null, ext text not null, size_bytes integer not null,
  width integer, height integer, duration_sec real, taken_local text, tz text, tz_offset_sec integer, ts_utc text, ts_source text, ts_kind text not null,
  lat real, lon real, canonical_path text not null, sidecar_path text not null, sidecar_json text not null,
  copied_at text, verified_at text, thumb_s text, thumb_m text, pushed_at text, push_hash text, updated_at text not null);
create table if not exists children (parent_sha text not null, role text not null, sha256 text not null, ext text not null, size_bytes integer not null,
  duration_sec real, canonical_path text not null, copied_at text, primary key (parent_sha, role));
create table if not exists locations (source_id text not null, relative_path text not null, sha256 text not null, master_uuid text, version_uuid text,
  original_file_name text not null, primary key (source_id, relative_path));
create table if not exists runs (run_id text primary key, source_id text not null, command text not null, started_at text not null,
  finished_at text, state text not null, summary_json text);
create table if not exists journal (id integer primary key autoincrement, run_id text not null, sha256 text not null, role text not null,
  dest_path text not null, size_bytes integer not null, at text not null, undone_at text);
create index if not exists idx_locations_sha on locations(sha256);
create index if not exists idx_journal_run on journal(run_id);
`;

const snake = (k: string) => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function fromRow<T>(r: any): T {
  const o: any = {};
  for (const k of Object.keys(r)) o[camel(k)] = r[k];
  return o as T;
}

export function photolibHome(): string {
  return process.env.PHOTOLIB_HOME || path.join(os.homedir(), '.photolib');
}

function upsertSql(table: string, cols: string[], pk: string[]): string {
  const sc = cols.map(snake);
  const upd = sc.filter(c => !pk.map(snake).includes(c)).map(c => `${c}=excluded.${c}`).join(', ');
  return `insert into ${table} (${sc.join(', ')}) values (${cols.map(c => '@' + c).join(', ')}) on conflict(${pk.map(snake).join(', ')}) do update set ${upd}`;
}

const ASSET_COLS = ['sha256', 'id', 'kind', 'ext', 'sizeBytes', 'width', 'height', 'durationSec', 'takenLocal', 'tz', 'tzOffsetSec', 'tsUtc', 'tsSource', 'tsKind',
  'lat', 'lon', 'canonicalPath', 'sidecarPath', 'sidecarJson', 'copiedAt', 'verifiedAt', 'thumbS', 'thumbM', 'pushedAt', 'pushHash', 'updatedAt'];
const CHILD_COLS = ['parentSha', 'role', 'sha256', 'ext', 'sizeBytes', 'durationSec', 'canonicalPath', 'copiedAt'];
const LOC_COLS = ['sourceId', 'relativePath', 'sha256', 'masterUuid', 'versionUuid', 'originalFileName'];

export class Manifest {
  readonly db: Database.Database;
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(photolibHome(), 'photolib.sqlite');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    const journalCols = this.db.prepare(`select name from pragma_table_info('journal')`).all() as { name: string }[];
    if (!journalCols.some(c => c.name === 'src_path')) this.db.exec('alter table journal add column src_path text');
  }

  upsertSource(src: SourceRow): void {
    this.db.prepare(`insert into sources (id, kind, library_path, label, added_at) values (@id, @kind, @libraryPath, @label, @addedAt)
      on conflict(id) do update set kind=excluded.kind, library_path=excluded.library_path, label=excluded.label`).run(src);
  }

  /** Cached sha256 for a library file (source_id, relative_path), valid only when the file size is unchanged. */
  getCachedHash(sourceId: string, relativePath: string, sizeBytes: number): string | null {
    const r = this.db.prepare(`select l.sha256 as sha from locations l left join assets a on a.sha256 = l.sha256
      left join children c on c.sha256 = l.sha256
      where l.source_id = ? and l.relative_path = ? and coalesce(a.size_bytes, c.size_bytes) = ? limit 1`).get(sourceId, relativePath, sizeBytes) as { sha: string } | undefined;
    return r?.sha ?? null;
  }

  putLocation(loc: LocationRow): void {
    this.db.prepare(upsertSql('locations', LOC_COLS, ['sourceId', 'relativePath'])).run(loc);
  }

  getAsset(sha256: string): AssetRow | undefined {
    const r = this.db.prepare('select * from assets where sha256 = ?').get(sha256);
    return r ? fromRow<AssetRow>(r) : undefined;
  }

  upsertAsset(row: AssetRow): void {
    this.db.prepare(upsertSql('assets', ASSET_COLS, ['sha256'])).run(row);
  }

  upsertChild(row: ChildRow): void {
    this.db.prepare(upsertSql('children', CHILD_COLS, ['parentSha', 'role'])).run(row);
  }

  listChildren(parentSha: string): ChildRow[] {
    return this.db.prepare('select * from children where parent_sha = ? order by role').all(parentSha).map(r => fromRow<ChildRow>(r));
  }

  listLocations(sha256: string): LocationRow[] {
    return this.db.prepare('select * from locations where sha256 = ? order by source_id, relative_path').all(sha256).map(r => fromRow<LocationRow>(r));
  }

  /**
   * needsPush = never pushed OR no push_hash recorded (does NOT include already-pushed rows whose sidecar later changed;
   * runPush uses withThumbs and compares push hashes itself). withThumbs = both thumbnails exist.
   */
  listAssets(opts: { missingThumbs?: boolean; needsPush?: boolean; withThumbs?: boolean; limit?: number } = {}): AssetRow[] {
    const w: string[] = [];
    if (opts.withThumbs) w.push('(thumb_s is not null and thumb_m is not null)');
    if (opts.missingThumbs) w.push('(thumb_s is null or thumb_m is null)');
    if (opts.needsPush) w.push('(pushed_at is null or push_hash is null)');
    const sql = `select * from assets ${w.length ? 'where ' + w.join(' and ') : ''} order by taken_local, sha256 ${opts.limit ? 'limit ' + Math.floor(opts.limit) : ''}`;
    return this.db.prepare(sql).all().map(r => fromRow<AssetRow>(r));
  }

  setThumbs(sha256: string, s: string, m: string): void {
    this.db.prepare('update assets set thumb_s = ?, thumb_m = ?, updated_at = ? where sha256 = ?').run(s, m, new Date().toISOString(), sha256);
  }

  markPushed(sha256: string, pushHash: string): void {
    this.db.prepare('update assets set pushed_at = ?, push_hash = ? where sha256 = ?').run(new Date().toISOString(), pushHash, sha256);
  }

  /** `summary` (optional) is stored as summary_json immediately; finishRun overwrites it. */
  startRun(run: { runId: string; sourceId: string; command: string; startedAt?: string; summary?: unknown }): void {
    this.db.prepare(`insert into runs (run_id, source_id, command, started_at, state, summary_json) values (?, ?, ?, ?, 'running', ?)`)
      .run(run.runId, run.sourceId, run.command, run.startedAt ?? new Date().toISOString(), run.summary === undefined ? null : JSON.stringify(run.summary));
  }

  finishRun(runId: string, state: string, summary: unknown): void {
    this.db.prepare('update runs set finished_at = ?, state = ?, summary_json = ? where run_id = ?')
      .run(new Date().toISOString(), state, summary === undefined ? null : JSON.stringify(summary), runId);
  }

  getRun(runId: string): RunRow | undefined {
    const r = this.db.prepare('select * from runs where run_id = ?').get(runId);
    return r ? fromRow<RunRow>(r) : undefined;
  }

  journal(e: JournalEntry): number {
    return Number(this.db.prepare('insert into journal (run_id, sha256, role, dest_path, size_bytes, at, src_path) values (?, ?, ?, ?, ?, ?, ?)')
      .run(e.runId, e.sha256, e.role, e.destPath, e.sizeBytes, e.at, e.srcPath ?? null).lastInsertRowid);
  }

  /** All journal rows of a run (including undone), ascending id. */
  journalForRun(runId: string): JournalRow[] {
    return this.db.prepare('select * from journal where run_id = ? order by id').all(runId).map(r => fromRow<JournalRow>(r));
  }

  markUndone(journalId: number): void {
    this.db.prepare('update journal set undone_at = ? where id = ?').run(new Date().toISOString(), journalId);
  }

  /** Removes the children row(s) for a child file (used by undo, which only knows the child's own sha + role). */
  deleteChildFile(sha256: string, role: string): void {
    this.db.prepare('delete from children where sha256 = ? and role = ?').run(sha256, role);
  }

  /** Removes one library location row (used by undo when the asset itself is kept). */
  deleteLocation(sourceId: string, relativePath: string): void {
    this.db.prepare('delete from locations where source_id = ? and relative_path = ?').run(sourceId, relativePath);
  }

  /** Removes the asset row plus its children and locations. */
  deleteAsset(sha256: string): void {
    this.db.transaction(() => {
      this.db.prepare('delete from children where parent_sha = ?').run(sha256);
      this.db.prepare('delete from locations where sha256 = ?').run(sha256);
      this.db.prepare('delete from assets where sha256 = ?').run(sha256);
    })();
  }

  close(): void { this.db.close(); }
}
