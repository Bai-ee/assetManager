import * as fs from 'fs/promises';
import * as path from 'path';
import { ArchiveDatabase } from '../database';
import type { ArchiveSource, SelectionItem } from '../types';
import { reviewBand } from '../jev/service';
import { JEV_QUESTIONS } from '../jev/taxonomy';
import { CLIENTS_MAP, clientSlugForPath } from '../clients';
import {
  ORGANIZED_ROOT_NAME,
  UNSORTED,
  isFilesystemArtifact,
  isAudioExtension,
  isMovableExtension,
  isProjectFileExtension,
  isProjectFolderName,
  isValidPillar,
  organizedRootPath,
  slugifyCollectionId,
  targetPath,
  withCollisionSuffix,
} from './scheme';

/** A legacy (home) collection may not be named like a client slug: it would land at
 * HITLOOP-ARCHIVE/<slug>/ and be indistinguishable from that client's folder. */
function assertNotSlugNamedLegacyCollection(collectionId: string, clientSlug: string | null) {
  if (!clientSlug && Object.prototype.hasOwnProperty.call(CLIENTS_MAP, collectionId)) {
    throw new Error(`collectionId "${collectionId}" is reserved for a client folder (clients.map.json); pick another collection name`);
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.moleboard']);

// The full sentence Jev was asked, matching the taxonomy's "pillar" question
// id. `jev_decisions.question` stores this sentence (see daemon.ts
// runJevForAsset), not the taxonomy id, so lookups must match on it.
const PILLAR_QUESTION_TEXT = JEV_QUESTIONS.find(q => q.id === 'pillar')?.question;

export interface OrganizePlanMove {
  sha256: string;
  /** Relative to the source's rootPath. */
  from: string;
  /** Relative to the source's rootPath (always under HITLOOP-ARCHIVE/…). */
  to: string;
  pillar: string;
  confidence: number | null;
  sizeBytes: number;
}

export interface OrganizePlanSkip {
  /** Relative to the source's rootPath. */
  path: string;
  reason: string;
}

export interface OrganizePlan {
  /** Absolute path to <rootPath>/HITLOOP-ARCHIVE/. */
  root: string;
  collectionId: string;
  /** Present when planned from a single selected folder (the pre-existing
   * `{selectedRelativePath}` shape). Mutually exclusive with `selection`. */
  selectedRelativePath?: string;
  /** Present when planned from an explicit `{items, collectionId}` selection
   * (`PROCESS_SELECTION`/`ORGANIZE_COLLECTION{items}`). Mutually exclusive
   * with `selectedRelativePath`. */
  selection?: SelectionItem[];
  /** `clients.map.json` slug when the selection sits under `<slug>/...`
   * (items: only when every item agrees). Collection lands at
   * `HITLOOP-ARCHIVE/<clientSlug>/<collectionId>/`. Absent = legacy/home. */
  clientSlug?: string;
  moves: OrganizePlanMove[];
  skipped: OrganizePlanSkip[];
  counts: { moves: number; skipped: number };
}

interface WalkEntry {
  /** Relative to the walk root (the selected folder). */
  relativePath: string;
  absolutePath: string;
}

async function* walkAll(root: string, current = root): AsyncGenerator<WalkEntry> {
  let dir;
  try { dir = await fs.opendir(current); } catch { return; }
  for await (const entry of dir) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name === ORGANIZED_ROOT_NAME) {
      // Never re-walk the organizer's own output tree as source content to
      // organize, unless this walk's root is already inside it.
      const rootIsInsideOrganized = root.split(path.sep).includes(ORGANIZED_ROOT_NAME);
      if (!rootIsInsideOrganized) continue;
    }
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) { yield* walkAll(root, full); continue; }
    if (entry.isFile()) yield { relativePath: path.relative(root, full), absolutePath: full };
  }
}

/**
 * Directories (relative to `root`) that must be treated as project folders:
 * named `Ableton Project Info` / `Samples` / `Backup` at any depth, or
 * directly (immediate children only) containing a DAW project file.
 * Exclusion then applies to that directory AND everything beneath it,
 * recursively — a video sitting loose inside an Ableton project folder never
 * moves, even though its own extension is otherwise movable.
 */
async function findProjectDirs(root: string): Promise<Set<string>> {
  const projectDirs = new Set<string>();

  async function walkDirs(current: string): Promise<void> {
    let dir;
    try { dir = await fs.opendir(current); } catch { return; }
    const entries = [];
    for await (const entry of dir) entries.push(entry);

    const relCurrent = path.relative(root, current);
    const hasProjectFile = entries.some(e => e.isFile() && isProjectFileExtension(e.name));
    if (hasProjectFile || isProjectFolderName(path.basename(current))) {
      projectDirs.add(relCurrent);
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && entry.name !== ORGANIZED_ROOT_NAME) {
        await walkDirs(path.join(current, entry.name));
      }
    }
  }

  await walkDirs(root);
  return projectDirs;
}

/** The nearest ancestor directory (relative to the walk root) of
 * `relativePath` that is a project dir, or null. Checks the walk root itself
 * ('' -> '.') through the file's immediate parent; never the file itself. */
/** True when `relativePath` (relative to the source root) sits inside the
 * selected folder (also relative to the source root; '.' = whole source). */
function isInsideSelection(relativePath: string, selectedRelativePath: string): boolean {
  const sel = path.normalize(selectedRelativePath || '.');
  if (sel === '.' || sel === '') return true;
  const rel = path.normalize(relativePath);
  return rel === sel || rel.startsWith(sel + path.sep);
}

/** Items-selection form of `isInsideSelection` above: true when
 * `relativePath` (relative to the source root) IS a selected file, or sits
 * inside (or is) a selected folder. Used by the same folder-scoped
 * duplicate-location rule, so a duplicate whose canonical copy lives outside
 * every selected item is still planned. */
function isInsideItemsSelection(relativePath: string, items: SelectionItem[]): boolean {
  const rel = path.normalize(relativePath);
  for (const item of items) {
    const itemRel = path.normalize(item.relativePath);
    if (rel === itemRel) return true;
    if (item.kind === 'folder' && rel.startsWith(itemRel + path.sep)) return true;
  }
  return false;
}

/** `findProjectDirs` walks a single root top-down; an explicitly selected
 * `file` item has no walked subtree of its own to run it over. This applies
 * the identical rule (named Ableton Project Info/Samples/Backup, or directly
 * containing a DAW project file) bottom-up instead: from the file's parent
 * directory up to (and including) `sourceRoot`. Returns the offending
 * ancestor's path relative to `sourceRoot` (or '.'), or null. */
async function ancestorProjectFolder(sourceRoot: string, absoluteFilePath: string): Promise<string | null> {
  let dir = path.dirname(absoluteFilePath);
  while (true) {
    const rel = path.relative(sourceRoot, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // walked above sourceRoot
    if (isProjectFolderName(path.basename(dir))) return rel || '.';
    let entries: Array<{ name: string; isFile(): boolean }> = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { entries = []; }
    if (entries.some(e => e.isFile() && isProjectFileExtension(e.name))) return rel || '.';
    const resolvedDir = path.resolve(dir);
    if (resolvedDir === path.resolve(sourceRoot)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root without finding sourceRoot
    dir = parent;
  }
}

function projectAncestorOf(relativePath: string, projectDirs: Set<string>): string | null {
  const parts = relativePath.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join(path.sep);
    if (projectDirs.has(ancestor)) return ancestor === '' ? '.' : ancestor;
  }
  return null;
}

export interface PlanOrganizeBySelectedPathParams {
  db: ArchiveDatabase;
  source: ArchiveSource;
  selectedRelativePath: string;
}

export interface PlanOrganizeByItemsParams {
  db: ArchiveDatabase;
  source: ArchiveSource;
  items: SelectionItem[];
  collectionId: string;
}

export type PlanOrganizeParams = PlanOrganizeBySelectedPathParams | PlanOrganizeByItemsParams;

/**
 * Pure(-ish) read: walks the selected folder (or explicit item selection) on
 * disk, cross-references `file_locations`/`content_assets`/`jev_decisions` in
 * SQLite, and returns the full move/skip list. Writes nothing to disk or to
 * SQLite — safe to call for `ORGANIZE_COLLECTION {mode:'plan'}` any number of
 * times.
 */
export async function planOrganizeCollection(params: PlanOrganizeParams): Promise<OrganizePlan> {
  const { db, source } = params;
  const sourceRoot = path.resolve(source.rootPath);
  const root = organizedRootPath(sourceRoot);

  const moves: OrganizePlanMove[] = [];
  const skipped: OrganizePlanSkip[] = [];
  // targetDir+filename -> sha256 already claimed within this plan, so two
  // different assets that would otherwise land on the same filename get a
  // collision suffix instead of one silently shadowing the other.
  const claimed = new Map<string, string>();
  // sha-identified assets already given a move in this plan, so a second
  // location of the same bytes inside the selection never moves twice.
  const plannedAssets = new Set<string>();

  // Shared per-candidate-file logic for both planning modes below: the
  // artifact/hidden/extension/hash/duplicate/pillar/collision rules must
  // never drift between a single-selected-folder plan and an explicit-items
  // plan, so there is exactly one implementation of them.
  async function planEntry(opts: {
    relFromSource: string;
    collectionId: string;
    clientSlug: string | null;
    insideSelection: (relativePath: string) => boolean;
    projectAncestorReason: () => Promise<string | null>;
  }): Promise<void> {
    const { relFromSource, collectionId, clientSlug } = opts;
    const basename = path.basename(relFromSource);

    if (isFilesystemArtifact(basename)) { skipped.push({ path: relFromSource, reason: 'filesystem artifact' }); return; }
    if (basename.startsWith('.')) { skipped.push({ path: relFromSource, reason: 'hidden file' }); return; }
    if (isProjectFileExtension(basename)) { skipped.push({ path: relFromSource, reason: 'project file (never moves)' }); return; }
    if (isAudioExtension(basename)) { skipped.push({ path: relFromSource, reason: 'audio (never moves)' }); return; }

    const projectAncestor = await opts.projectAncestorReason();
    if (projectAncestor) { skipped.push({ path: relFromSource, reason: `inside project folder: ${projectAncestor}` }); return; }
    if (!isMovableExtension(basename)) { skipped.push({ path: relFromSource, reason: 'unsupported extension' }); return; }

    const location = db.getLocationByRelativePath(source.id, relFromSource);
    if (!location || !location.contentAssetId) { skipped.push({ path: relFromSource, reason: 'not yet hashed' }); return; }
    if (location.organizedPath) { skipped.push({ path: relFromSource, reason: 'already organized' }); return; }
    if (plannedAssets.has(location.contentAssetId)) { skipped.push({ path: relFromSource, reason: 'duplicate location' }); return; }
    // One organized copy per asset, ever: if any other location of these
    // bytes already sits in HITLOOP-ARCHIVE/, this one stays put.
    const siblings = db.listLocationsForAsset(location.contentAssetId);
    const organizedElsewhere = siblings.find(l => l.id !== location.id && l.organizedPath);
    if (organizedElsewhere) { skipped.push({ path: relFromSource, reason: `duplicate: asset already organized at ${organizedElsewhere.organizedPath}` }); return; }
    if (location.state === 'DUPLICATE') {
      // The worker marks DUPLICATE globally (first-seen sha wins across the
      // whole source), but the organizer is scoped to the selection: a
      // duplicate whose canonical copy lives OUTSIDE the selection is the
      // copy the owner asked to organize. Only skip when the canonical
      // location is itself inside the selection.
      const canonicalInside = siblings.find(l => l.id !== location.id && l.state !== 'DUPLICATE' && l.sourceId === source.id && opts.insideSelection(l.relativePath));
      if (canonicalInside) { skipped.push({ path: relFromSource, reason: 'duplicate location' }); return; }
    }

    const asset = db.getAsset(location.contentAssetId);
    if (!asset) { skipped.push({ path: relFromSource, reason: 'content asset record missing' }); return; }

    let pillar: string = UNSORTED;
    let confidence: number | null = null;
    if (PILLAR_QUESTION_TEXT) {
      const decision = db.listJevDecisions(asset.id).find(d => d.question === PILLAR_QUESTION_TEXT);
      if (decision) {
        confidence = decision.confidence ?? null;
        const bandOk = decision.confidence != null && reviewBand(decision.confidence) !== 'IDENTIFICATION_REQUIRED';
        if (bandOk && isValidPillar(decision.selectedValue)) pillar = decision.selectedValue;
      }
      // No decision at all (image with no video-understanding evidence, or
      // Jev hasn't run yet) also lands in _unsorted — the default above.
    }

    let filename = basename;
    let toAbsolute = targetPath(sourceRoot, collectionId, pillar, filename, clientSlug);
    let claimKey = `${clientSlug ?? ''}/${collectionId}/${pillar}/${filename}`;
    const claimedSha = claimed.get(claimKey);
    let collides = Boolean(claimedSha && claimedSha !== asset.sha256);
    if (!collides && !claimedSha) {
      // Defends against a prior partial apply that already left a
      // differently-sourced file at this exact target path.
      collides = await fs.stat(toAbsolute).then(() => true, () => false);
    }
    if (collides) {
      filename = withCollisionSuffix(basename, asset.sha256);
      toAbsolute = targetPath(sourceRoot, collectionId, pillar, filename, clientSlug);
      claimKey = `${clientSlug ?? ''}/${collectionId}/${pillar}/${filename}`;
    }
    claimed.set(claimKey, asset.sha256);
    plannedAssets.add(asset.id);

    moves.push({
      sha256: asset.sha256,
      from: relFromSource,
      to: path.relative(sourceRoot, toAbsolute),
      pillar,
      confidence,
      sizeBytes: asset.sizeBytes,
    });
  }

  if ('items' in params) {
    const { items, collectionId } = params;
    // A selection is client-scoped only when every item sits under the same slug; mixing
    // clients (or a client with home items) is rejected rather than routed to legacy.
    const itemSlugs = new Set(items.map(item => clientSlugForPath(item.relativePath)));
    if (itemSlugs.size > 1) throw new Error('Selection mixes client folders (or a client folder with home items); organize each client separately');
    const clientSlug = Array.from(itemSlugs)[0] ?? null;
    assertNotSlugNamedLegacyCollection(collectionId, clientSlug);
    const insideSelection = (relativePath: string) => isInsideItemsSelection(relativePath, items);
    // Absolute-path dedupe: a file inside a selected folder that is ALSO
    // separately selected (or covered by two overlapping selected folders)
    // is only ever planned once.
    const visited = new Set<string>();

    for (const item of items) {
      const absolute = path.resolve(sourceRoot, item.relativePath);
      const relative = path.relative(sourceRoot, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Selected item escapes source root: ${item.relativePath}`);
      }

      if (item.kind === 'folder') {
        const projectDirs = await findProjectDirs(absolute);
        for await (const entry of walkAll(absolute)) {
          const relFromSource = path.relative(sourceRoot, entry.absolutePath);
          if (visited.has(relFromSource)) continue;
          visited.add(relFromSource);
          await planEntry({
            relFromSource,
            collectionId,
            clientSlug,
            insideSelection,
            projectAncestorReason: async () => projectAncestorOf(entry.relativePath, projectDirs),
          });
        }
      } else {
        const relFromSource = path.normalize(relative);
        if (visited.has(relFromSource)) continue;
        visited.add(relFromSource);
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat || !stat.isFile()) { skipped.push({ path: relFromSource, reason: 'not found' }); continue; }
        await planEntry({
          relFromSource,
          collectionId,
          clientSlug,
          insideSelection,
          projectAncestorReason: () => ancestorProjectFolder(sourceRoot, absolute),
        });
      }
    }

    return {
      root,
      collectionId,
      selection: items,
      ...(clientSlug ? { clientSlug } : {}),
      moves,
      skipped,
      counts: { moves: moves.length, skipped: skipped.length },
    };
  }

  const selectedRelativePath = params.selectedRelativePath || '.';
  const selectedRoot = path.resolve(sourceRoot, selectedRelativePath);
  const relCheck = path.relative(sourceRoot, selectedRoot);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error('Selected path escapes source root');
  }

  const collectionId = slugifyCollectionId(selectedRelativePath);
  const clientSlug = clientSlugForPath(selectedRelativePath);
  assertNotSlugNamedLegacyCollection(collectionId, clientSlug);
  const projectDirs = await findProjectDirs(selectedRoot);

  for await (const entry of walkAll(selectedRoot)) {
    const relFromSource = path.relative(sourceRoot, entry.absolutePath);
    await planEntry({
      relFromSource,
      collectionId,
      clientSlug,
      insideSelection: (relativePath: string) => isInsideSelection(relativePath, selectedRelativePath),
      projectAncestorReason: async () => projectAncestorOf(entry.relativePath, projectDirs),
    });
  }

  return {
    root,
    collectionId,
    selectedRelativePath,
    ...(clientSlug ? { clientSlug } : {}),
    moves,
    skipped,
    counts: { moves: moves.length, skipped: skipped.length },
  };
}
