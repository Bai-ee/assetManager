import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AnalyzerPlugin } from './plugin';
import { CONTENT_TYPES } from './stage';
import { firstExisting, type ReadOnlyStore, type SourceInfo } from './store';
import { OpsManager, handleOpsRoute } from './fileops';
import { BrowseError, browse, isNasSource, mountSmb, nasStatus, organizedFor, readMountText, type NasStatus } from './nas';

export const PORT = 8777;
export const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'https://hitloop.agency', 'https://www.hitloop.agency',
]);
const SHA_RE = /^[a-f0-9]{64}$/;
export const isValidSha = (s: string) => SHA_RE.test(s);

export function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-allow-headers'] = 'range, content-type';
    h['access-control-expose-headers'] = 'content-range, accept-ranges, content-length';
    h['access-control-allow-private-network'] = 'true';
  }
  return h;
}

/** Parses a single `bytes=a-b` range. null = no/ignored header, 'bad' = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number, end: number;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

/** Host header must be loopback (blocks DNS-rebinding). */
export const isLoopbackHost = (host: string | undefined) => !!host && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);

export interface ServerDeps {
  workerId: string; thumbDir: string;
  store: Pick<ReadOnlyStore, 'locate'> & Partial<Pick<ReadOnlyStore, 'listSources' | 'getSource'>>;
  /** Test seams for the NAS endpoints. */
  mountText?: () => string;
  connect?: (smbUrl: string) => Promise<void>;
  /** Copy/move engine (defaults to a fresh OpsManager per server). */
  ops?: OpsManager;
  /** Live cost estimate for a selection (dry run, no model calls). */
  /** Generic plugins; a pathname under a plugin routePrefix is delegated to plugin.route. */
  plugins?: AnalyzerPlugin[];
  estimate?: (input: { sourceId: string; paths: string[]; promptVersion?: string; model?: string; batch?: boolean }) => Promise<unknown>;
}

export function createAnalyzerServer(deps: ServerDeps): http.Server {
  const sources = (): SourceInfo[] => deps.store.listSources?.() ?? [];
  const status = (): NasStatus => nasStatus(sources(), (deps.mountText ?? readMountText)());
  const ops = deps.ops ?? new OpsManager();
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status: number, body: string | object, extra: Record<string, string> = {}) => {
      const isStr = typeof body === 'string';
      res.writeHead(status, { ...corsHeaders(origin), 'content-type': isStr ? 'text/plain' : 'application/json', ...extra });
      res.end(isStr ? body : JSON.stringify(body));
    };
    if (!isLoopbackHost(req.headers.host)) return send(403, 'forbidden');
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(origin)); return res.end(); }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return send(400, 'bad request'); }

    if (pathname === '/nas/connect') {
      if (req.method !== 'POST') return send(405, 'method not allowed');
      try {
        const st = status();
        const connect = deps.connect ?? mountSmb;
        // Mount every share a NAS source needs; fall back to the primary share when none are registered under /Volumes.
        const urls = st.missing.length ? st.missing : (st.mounted ? [] : [st.smbUrl]);
        for (const u of urls) await connect(u);
        return send(200, status());
      } catch (e) { return send(502, { ok: false, error: `mount failed: ${e instanceof Error ? e.message : String(e)}`, ...status() }); }
    }
    if (pathname === '/nas/estimate') {
      if (req.method !== 'POST') return send(405, 'method not allowed');
      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(403, 'forbidden');
      if (!deps.estimate) return send(501, { ok: false, error: 'estimate not available' });
      let body: { sourceId?: unknown; paths?: unknown; promptVersion?: unknown; model?: unknown; batch?: unknown };
      try {
        const chunks: Buffer[] = []; let n = 0;
        for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) return send(413, { ok: false, error: 'body too large' }); chunks.push(c as Buffer); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch { return send(400, { ok: false, error: 'invalid JSON body' }); }
      const src = typeof body.sourceId === 'string' ? deps.store.getSource?.(body.sourceId) : undefined;
      if (!src || !isNasSource(src)) return send(404, { ok: false, error: 'unknown NAS source' });
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string').slice(0, 500) : [];
      // Price what Start would actually do: same prompt version / model the real command carries (the cache is keyed on them).
      const short = (v: unknown) => (typeof v === 'string' && /^[\w.\-]{1,64}$/.test(v) ? v : undefined);
      try { return send(200, { ok: true, ...(await deps.estimate({ sourceId: src.id, paths, promptVersion: short(body.promptVersion), model: short(body.model), ...(body.batch === true ? { batch: true } : {}) }) as object) }); }
      catch (e) { return send(400, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (pathname.startsWith('/nas/ops/')) {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(403, 'forbidden');
      let body: unknown;
      if (req.method === 'POST') {
        try {
          const chunks: Buffer[] = []; let n = 0;
          for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) return send(413, { ok: false, error: 'body too large' }); chunks.push(c as Buffer); }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch { return send(400, { ok: false, error: 'invalid JSON body' }); }
      }
      const r = handleOpsRoute(ops, id => deps.store.getSource?.(id), req.method || 'GET', pathname, body);
      return r ? send(r.status, r.body) : send(404, 'not found');
    }
    const plugin = (deps.plugins ?? []).find(p => p.routePrefix && p.route && pathname.startsWith(p.routePrefix));
    if (plugin) {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(403, 'forbidden');
      let body: unknown;
      if (req.method === 'POST') {
        try {
          const chunks: Buffer[] = []; let n = 0;
          for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) return send(413, { ok: false, error: 'body too large' }); chunks.push(c as Buffer); }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch { return send(400, { ok: false, error: 'invalid JSON body' }); }
      }
      try {
        const r = await plugin.route!({ method: req.method || 'GET', pathname, url, body }, { getSource: id => deps.store.getSource?.(id), listSources: sources });
        return r ? send(r.status, r.body as string | object) : send(404, 'not found');
      } catch (e) { return send(500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    if (pathname === '/nas/status') return send(200, status());
    if (pathname === '/nas/browse') {
      const src = deps.store.getSource?.(url.searchParams.get('sourceId') || '');
      if (!src || !isNasSource(src)) return send(404, { ok: false, error: 'unknown NAS source' });
      try { return send(200, browse(src.rootPath, url.searchParams.get('path') || '')); }
      catch (e) { return send(e instanceof BrowseError ? e.status : 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }
    if (pathname === '/health') return send(200, { ok: true, workerId: deps.workerId });

    const thumb = /^\/thumbs\/([a-f0-9]{64})\.jpg$/.exec(pathname);
    if (thumb) {
      const file = path.join(deps.thumbDir, `${thumb[1]}.jpg`);
      if (!fs.existsSync(file)) return send(404, 'not found');
      res.writeHead(200, { ...corsHeaders(origin), 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'content-length': String(fs.statSync(file).size) });
      return req.method === 'HEAD' ? res.end() : void fs.createReadStream(file).pipe(res);
    }

    const media = /^\/media\/([^/]+)$/.exec(pathname);
    if (media) {
      if (!isValidSha(media[1])) return send(400, 'invalid sha256');
      const locs = deps.store.locate(media[1]);
      let abs: string | null = null;
      for (const l of locs) { abs = organizedFor(l.rootPath, media[1]); if (abs) break; }
      abs = abs ?? firstExisting(locs);
      if (!abs) return send(404, 'not found');
      const size = fs.statSync(abs).size;
      const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      const range = parseRange(req.headers.range, size);
      if (range === 'bad') return send(416, 'range not satisfiable', { 'content-range': `bytes */${size}` });
      const base = { ...corsHeaders(origin), 'content-type': type, 'accept-ranges': 'bytes' };
      if (range) {
        res.writeHead(206, { ...base, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) });
        return req.method === 'HEAD' ? res.end() : void fs.createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
      }
      res.writeHead(200, { ...base, 'content-length': String(size) });
      return req.method === 'HEAD' ? res.end() : void fs.createReadStream(abs).pipe(res);
    }
    return send(404, 'not found');
  });
}
