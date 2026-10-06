/**
 * Minimal Discogs API client for the Discogs feature module.
 * Boundary rule: lib/discogs may import from lib/archive, never the reverse.
 * Auth: personal access token (DISCOGS_TOKEN). Never log the token.
 * Rate limit: Discogs allows 60 req/min authenticated; we space calls ~1.1s
 * apart and back off on 429.
 */

const API = 'https://api.discogs.com';
const USER_AGENT = 'HitloopDiscogsModule/0.1 +https://hitloop.agency';
const MIN_INTERVAL_MS = 1100;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscogsIdentity { id: number; username: string; resource_url: string; }
export interface DiscogsFolder { id: number; name: string; count: number; }
export interface DiscogsInstance { instance_id: number; folder_id: number; id: number; date_added?: string; }

export class DiscogsError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) { super(message); this.status = status; this.body = body; }
}

export class DiscogsClient {
  private lastCall = 0;
  private token: string | undefined;
  private fetchImpl: FetchLike;

  constructor(token = process.env.DISCOGS_TOKEN, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  get configured(): boolean { return Boolean(this.token); }

  private async request<T>(method: string, path: string, attempt = 0, body?: unknown): Promise<T> {
    if (!this.token) throw new Error('Discogs is not configured: DISCOGS_TOKEN is missing');
    const wait = this.lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastCall = Date.now();

    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: `Discogs token=${this.token}`,
        Accept: 'application/vnd.discogs.v2.discogs+json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, 5_000 * (attempt + 1)));
      return this.request<T>(method, path, attempt + 1, body);
    }
    const text = await res.text();
    if (!res.ok) throw new DiscogsError(`Discogs ${method} ${path} failed: ${res.status}`, res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  identity() { return this.request<DiscogsIdentity>('GET', '/oauth/identity'); }

  async folders(username: string): Promise<DiscogsFolder[]> {
    const r = await this.request<{ folders: DiscogsFolder[] }>('GET', `/users/${encodeURIComponent(username)}/collection/folders`);
    return r.folders;
  }

  getRelease(releaseId: number) { return this.request<any>('GET', `/releases/${releaseId}`); }

  search(params: Record<string, string>) {
    const qs = new URLSearchParams({ type: 'release', ...params }).toString();
    return this.request<{ results: any[]; pagination: any }>('GET', `/database/search?${qs}`);
  }

  /** Every copy of this release already in the user's collection (empty = not owned). */
  async instances(username: string, releaseId: number): Promise<DiscogsInstance[]> {
    try {
      const r = await this.request<{ releases: DiscogsInstance[] }>('GET', `/users/${encodeURIComponent(username)}/collection/releases/${releaseId}`);
      return r.releases || [];
    } catch (e) {
      if (e instanceof DiscogsError && e.status === 404) return [];
      throw e;
    }
  }

  addToCollection(username: string, folderId: number, releaseId: number) {
    return this.request<{ instance_id: number; resource_url: string }>('POST', `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases/${releaseId}`);
  }

  removeInstance(username: string, folderId: number, releaseId: number, instanceId: number) {
    return this.request<unknown>('DELETE', `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases/${releaseId}/instances/${instanceId}`);
  }

  /** Release ids across the whole collection (folder 0 = All). Duplicates collapse in the Set. */
  async collectionReleaseIds(username: string): Promise<Set<number>> {
    const ids = new Set<number>();
    let page = 1;
    let pages = 1;
    do {
      const r = await this.request<{ releases: { id: number }[]; pagination: { pages: number } }>(
        'GET', `/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=100&page=${page}`);
      for (const rel of r.releases || []) ids.add(rel.id);
      pages = r.pagination?.pages ?? 1;
      page++;
    } while (page <= pages);
    return ids;
  }

  /** Write a custom collection field (e.g. notes) on one instance. */
  setInstanceField(username: string, folderId: number, releaseId: number, instanceId: number, fieldId: number, value: string) {
    return this.request<unknown>('POST', `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases/${releaseId}/instances/${instanceId}/fields/${fieldId}`, 0, { value });
  }
}
