import * as path from 'path';

/**
 * NAS organizer (W-B, docs/plans/ARCHIVE-NAS-STAGING-MASTER-PLAN-2026-09-20.md
 * §3a/§3b). Pure, dependency-free rules for what moves, where it lands, and
 * how collisions/names are resolved. No filesystem or SQLite access here —
 * see `planner.ts` (read plan), `mover.ts` (apply/undo), `journal.ts`
 * (append-only history).
 *
 * This is the ONE owned root the organizer is ever allowed to write inside.
 * `worker.ts`'s discovery walk and every path assertion in `mover.ts` key off
 * this exact name.
 */
export const ORGANIZED_ROOT_NAME = 'HITLOOP-ARCHIVE';

/** macOS resource forks (AppleDouble `._*` companion files) and `.DS_Store`
 * are SMB/Finder artifacts, not archive content. Canonical home for this
 * predicate — `worker.ts` re-exports it for the discovery pipeline so both
 * agree on what is "real" content. */
export function isFilesystemArtifact(name: string): boolean {
  return name.startsWith('._') || name === '.DS_Store';
}

// ---- WHAT MOVES ------------------------------------------------------

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.gif', '.webp', '.tif', '.tiff']);

// ---- WHAT NEVER MOVES -------------------------------------------------

export const AUDIO_EXTENSIONS = new Set(['.wav', '.aif', '.aiff', '.mp3', '.flac', '.m4a', '.ogg']);
export const PROJECT_EXTENSIONS = new Set(['.als', '.alp', '.logicx', '.flp', '.ptx', '.cpr', '.rpp']);
export const PROJECT_FOLDER_NAMES = new Set(['Ableton Project Info', 'Samples', 'Backup']);

function ext(name: string): string {
  return path.extname(name).toLowerCase();
}

export function isMovableExtension(name: string): boolean {
  const e = ext(name);
  return VIDEO_EXTENSIONS.has(e) || IMAGE_EXTENSIONS.has(e);
}

export function isAudioExtension(name: string): boolean {
  return AUDIO_EXTENSIONS.has(ext(name));
}

export function isProjectFileExtension(name: string): boolean {
  return PROJECT_EXTENSIONS.has(ext(name));
}

export function isProjectFolderName(name: string): boolean {
  return PROJECT_FOLDER_NAMES.has(name);
}

// ---- PILLAR TAXONOMY ---------------------------------------------------

export const PILLARS = ['was-there', 'made-this', 'found-this', 'how-made', 'thirty-years', 'building-now'] as const;
export type Pillar = typeof PILLARS[number];
export const UNSORTED = '_unsorted';

export function isValidPillar(value: string | null | undefined): value is Pillar {
  return !!value && (PILLARS as readonly string[]).includes(value);
}

// ---- NAMING / PATHS -----------------------------------------------------

/** Ported verbatim from HITLOOP's
 * `api/_lib/archive-permanent-archive.cjs` `slugifyCollectionId` so /archive
 * and the worker agree on the same folder name for the same processed
 * relativePath. Keep the two in sync by hand if either changes. */
export function slugifyCollectionId(relativePath: string): string {
  const trimmed = String(relativePath == null ? '.' : relativePath).trim();
  if (trimmed === '.' || trimmed === '') return 'root';
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'root';
}

/** title = the last path segment, as-is. Mirrors
 * `collectionTitleFromPath` in the same HITLOOP module. */
export function collectionTitleFromPath(relativePath: string): string {
  const trimmed = String(relativePath == null ? '.' : relativePath).trim();
  if (trimmed === '.' || trimmed === '') return 'root';
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : trimmed;
}

export function organizedRootPath(sourceRootPath: string): string {
  return path.join(path.resolve(sourceRootPath), ORGANIZED_ROOT_NAME);
}

export function collectionDir(sourceRootPath: string, collectionId: string): string {
  return path.join(organizedRootPath(sourceRootPath), collectionId);
}

export function pillarDir(sourceRootPath: string, collectionId: string, pillarOrUnsorted: string): string {
  return path.join(collectionDir(sourceRootPath, collectionId), pillarOrUnsorted);
}

export function collectionMetaDir(sourceRootPath: string, collectionId: string): string {
  return path.join(collectionDir(sourceRootPath, collectionId), '_meta');
}

/** Absolute organize target path for a filename inside a collection/pillar
 * bucket, before any collision suffix is applied. */
export function targetPath(sourceRootPath: string, collectionId: string, pillarOrUnsorted: string, filename: string): string {
  return path.join(pillarDir(sourceRootPath, collectionId, pillarOrUnsorted), filename);
}

/** ` (<sha12>)` inserted before the extension on a same-folder filename
 * collision, e.g. `clip.mp4` -> `clip (a1b2c3d4e5f6).mp4`. Filenames are
 * otherwise kept verbatim (WHERE IT LANDS contract). */
export function withCollisionSuffix(filename: string, sha256: string): string {
  const extension = path.extname(filename);
  const base = filename.slice(0, filename.length - extension.length);
  return `${base} (${sha256.slice(0, 12)})${extension}`;
}

/** True when `candidateAbsolutePath` resolves to the organized root itself or
 * somewhere beneath it. `mover.ts` hard-fails any apply move that isn't. */
export function isUnderOrganizedRoot(sourceRootPath: string, candidateAbsolutePath: string): boolean {
  const root = organizedRootPath(sourceRootPath);
  const candidate = path.resolve(candidateAbsolutePath);
  return candidate === root || (candidate + path.sep).startsWith(root + path.sep);
}

/** Parses a `HITLOOP-ARCHIVE/<collectionId>/...` path (relative to the
 * source root, as stored in `organize_moves`/`moves.jsonl`) back to its
 * collectionId. Returns null for anything not shaped like an organized path.
 * Used by `UNDO_ORGANIZE` to find which collection's journal to append to. */
export function collectionIdFromOrganizedRelativePath(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts[0] !== ORGANIZED_ROOT_NAME || !parts[1]) return null;
  return parts[1];
}
