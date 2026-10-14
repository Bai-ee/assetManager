import clientsMapData from './clients.map.json';
import { isCollectionBucketName, isValidPillar } from './organize/pillars';

/**
 * Per-client NAS convention (F1). Folder layout:
 *   HITLOOP-ARCHIVE/<client-slug>/<collection>/<pillar>/   (organizer)
 *   HITLOOP-ARCHIVE/<client-slug>/content/<kind>/<year>/   (analyzer copy)
 * An owner may also drop files at `<client-slug>/...` directly under the
 * source root. Anything else (legacy top-level collections, unknown slugs)
 * is the home client: the worker sends NO clientId and HITLOOP falls back.
 *
 * `clients.map.json` (committed, public ids only) maps slug -> HITLOOP clientId.
 * Home is never listed. A slug must not equal an existing legacy collection
 * id (a top-level `HITLOOP-ARCHIVE/<collectionId>/`), and a home folder at the
 * source root named exactly like a slug is attributed to that client.
 */
export type ClientsMap = Readonly<Record<string, string>>;

const ORGANIZED_ROOT = 'HITLOOP-ARCHIVE';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{3,80}$/;

/** Validates a raw slug -> clientId map. Throws on the first bad entry. */
export function loadClientsMap(raw: unknown): ClientsMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('clients map must be a JSON object of slug -> clientId');
  const out: Record<string, string> = {};
  for (const [slug, id] of Object.entries(raw as Record<string, unknown>)) {
    if (!SLUG_RE.test(slug)) throw new Error(`clients map: invalid slug "${slug}" (lowercase kebab only)`);
    if (slug === ORGANIZED_ROOT.toLowerCase() || slug === 'content' || slug === 'root' || isValidPillar(slug)) throw new Error(`clients map: reserved slug "${slug}"`);
    if (typeof id !== 'string' || !CLIENT_ID_RE.test(id)) throw new Error(`clients map: invalid clientId for "${slug}"`);
    out[slug] = id;
  }
  return Object.freeze(out);
}

/** The committed map, validated at module load (a bad entry fails the worker fast). */
export const CLIENTS_MAP: ClientsMap = loadClientsMap(clientsMapData);

function parts(relativePath: string): string[] {
  return String(relativePath ?? '').split(/[\\/]+/).filter(p => p && p !== '.');
}

/** Client slug for a source-root-relative path, or null (home/legacy). */
export function clientSlugForPath(relativePath: string, map: ClientsMap = CLIENTS_MAP): string | null {
  const p = parts(relativePath);
  const has = (s: string | undefined): s is string => !!s && Object.prototype.hasOwnProperty.call(map, s);
  // HITLOOP-ARCHIVE/<slug>/<pillar|_unsorted|_meta>/... is a legacy collection that shares the slug's name.
  if (p[0] === ORGANIZED_ROOT) return has(p[1]) && !isCollectionBucketName(p[2]) ? p[1] : null;
  return has(p[0]) ? p[0] : null;
}

/** HITLOOP clientId for a source-root-relative path, or null (send no clientId). */
export function clientForPath(relativePath: string, map: ClientsMap = CLIENTS_MAP): string | null {
  const slug = clientSlugForPath(relativePath, map);
  return slug ? map[slug] : null;
}

/** Single client shared by EVERY path, else null (mixed or any home path = no clientId).
 * Used for deduped assets whose bytes live in several places. */
export function clientForAllPaths(paths: string[], map: ClientsMap = CLIENTS_MAP): string | null {
  if (!paths.length) return null;
  const ids = new Set(paths.map(p => clientForPath(p, map)));
  return ids.size === 1 ? Array.from(ids)[0] : null;
}

/** Adds `clientId` to an emitted analyzer item when its own `relativePath` maps to a client.
 * `organizedPath` is deliberately ignored: `_meta` sidecars are sha-keyed and shared, so a home
 * file with the same bytes as a client file can point at the client's copy. */
export function withClientId<T extends { relativePath: string }>(item: T, map: ClientsMap = CLIENTS_MAP): T & { clientId?: string } {
  const clientId = clientForPath(item.relativePath, map);
  return clientId ? { ...item, clientId } : item;
}
