import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface SourceInfo { id: string; label: string; rootPath: string }
export interface KnownFile { sha256: string; sizeBytes: number; modifiedAtMs: number }
export interface Located { sourceId: string; rootPath: string; relativePath: string }

/** Read-only view of the worker's SQLite. Never migrates or writes. */
export class ReadOnlyStore {
  private db: Database.Database;
  private hasOrganized: boolean;

  constructor(filePath = process.env.ARCHIVE_DB_PATH || path.join(process.cwd(), '.moleboard', 'archive.sqlite')) {
    this.db = new Database(filePath, { readonly: true, fileMustExist: true });
    this.hasOrganized = (this.db.prepare('PRAGMA table_info(file_locations)').all() as Array<{ name: string }>).some(c => c.name === 'organized_path');
  }

  listSources(): SourceInfo[] {
    return (this.db.prepare('SELECT id,label,root_path FROM sources ORDER BY label').all() as any[]).map(r => ({ id: r.id, label: r.label, rootPath: r.root_path }));
  }

  getSource(id: string): SourceInfo | undefined {
    const r: any = this.db.prepare('SELECT id,label,root_path FROM sources WHERE id=?').get(id);
    return r && { id: r.id, label: r.label, rootPath: r.root_path };
  }

  /** Hash the worker already computed for this path (valid only if size+mtime still match). */
  knownFile(sourceId: string, relativePath: string): KnownFile | undefined {
    const r: any = this.db.prepare(`SELECT a.sha256 AS sha256, l.size_bytes AS size, l.modified_at_ms AS mtime
      FROM file_locations l JOIN content_assets a ON a.id=l.content_asset_id WHERE l.source_id=? AND l.relative_path=?`).get(sourceId, relativePath);
    return r && { sha256: r.sha256, sizeBytes: r.size, modifiedAtMs: r.mtime };
  }

  /** Where the bytes for a sha256 live (organized location first). */
  locate(sha256: string): Located[] {
    const cols = this.hasOrganized ? 'l.organized_path AS organized, ' : '';
    const rows = this.db.prepare(`SELECT ${cols} l.relative_path AS rel, s.id AS sid, s.root_path AS root
      FROM file_locations l JOIN content_assets a ON a.id=l.content_asset_id JOIN sources s ON s.id=l.source_id WHERE a.sha256=?`).all(sha256) as any[];
    const out: Located[] = [];
    for (const r of rows) {
      if (r.organized) out.push({ sourceId: r.sid, rootPath: r.root, relativePath: r.organized });
      out.push({ sourceId: r.sid, rootPath: r.root, relativePath: r.rel });
    }
    return out;
  }

  close() { this.db.close(); }
}

/** Resolve a relative path under root; null if it escapes the root. */
export function resolveUnder(root: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) return null;
  const abs = path.resolve(root, relativePath);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

export function firstExisting(locs: Located[]): string | null {
  for (const l of locs) {
    const abs = resolveUnder(l.rootPath, l.relativePath);
    if (abs && fs.existsSync(abs)) return abs;
  }
  return null;
}
