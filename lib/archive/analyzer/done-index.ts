import * as fs from 'fs';
import * as path from 'path';

/** A file the analyzer has hashed / finished, as seen at that time (size + mtime are the change check). */
export interface DoneFile {
  sizeBytes: number; mtimeMs: number; sha256: string;
  /** Set once the analysis for this prompt/model is cached and emitted. */
  promptVersion?: string; model?: string;
  /** Source-root-relative organized copy (absent = not organized yet or organize failed). */
  organizedRelativePath?: string;
  /** ISO time the result was accepted by HITLOOP. */
  pushedAt?: string;
}
/** One directory's media + subdirectory listing, valid while the directory's own mtime is unchanged. */
export interface DirListing { mtimeMs: number; entries: Array<{ name: string; kind: 'file'; sizeBytes: number; mtimeMs: number } | { name: string; kind: 'dir' }> }
export interface SourceIndex { files: Record<string, DoneFile>; dirs: Record<string, DirListing> }
interface IndexFile { version: 1; sources: Record<string, SourceIndex> }

const SAVE_EVERY_MS = 10_000;

/**
 * Mac-local index (`ARCHIVE_ANALYZER_HOME/done-index.json`) keyed by sourceId + relativePath. Lets re-runs skip
 * per-file NAS work (lstat, hash, organize checks, push) for files that are already finished. Never built by a NAS
 * scan: entries are written as files complete. Missing/garbled file = empty index (falls back to the full path).
 */
export class DoneIndex {
  private data: IndexFile;
  private dirty = false;
  private lastSave = Date.now();

  constructor(readonly file: string) {
    let d: IndexFile | null = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')) as IndexFile; } catch { /* first run or torn file */ }
    this.data = d && d.version === 1 && d.sources && typeof d.sources === 'object' ? d : { version: 1, sources: {} };
  }

  source(sourceId: string): SourceIndex {
    const s = this.data.sources[sourceId] ??= { files: {}, dirs: {} };
    s.files ??= {}; s.dirs ??= {};
    return s;
  }

  /** Index entry for a file only when the walked size + mtime still match it. */
  fresh(sourceId: string, f: { relativePath: string; sizeBytes: number; mtimeMs: number }): DoneFile | null {
    const e = this.data.sources[sourceId]?.files?.[f.relativePath];
    return e && e.sizeBytes === f.sizeBytes && Math.abs(e.mtimeMs - f.mtimeMs) < 1 ? e : null;
  }

  /** True when the index knows this path but its size or mtime changed since (its old sha must not be reused). */
  stale(sourceId: string, f: { relativePath: string; sizeBytes: number; mtimeMs: number }): boolean {
    return !!this.data.sources[sourceId]?.files?.[f.relativePath] && !this.fresh(sourceId, f);
  }

  setFile(sourceId: string, rel: string, e: DoneFile) { this.source(sourceId).files[rel] = e; this.touch(); }
  stampPushed(sourceId: string, rels: string[], at = new Date().toISOString()) {
    const files = this.source(sourceId).files;
    for (const r of rels) if (files[r]) files[r].pushedAt = at;
    this.touch();
  }
  setDir(sourceId: string, rel: string, l: DirListing) { this.source(sourceId).dirs[rel] = l; this.touch(); }

  private touch() { this.dirty = true; if (Date.now() - this.lastSave >= SAVE_EVERY_MS) this.save(); }

  /** Atomic write; no-op when nothing changed. */
  save() {
    this.lastSave = Date.now();
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}
