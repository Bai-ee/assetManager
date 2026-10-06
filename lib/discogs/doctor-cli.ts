/**
 * Read-only environment doctor for the Discogs pipeline.
 *   npm run discogs:doctor [-- <nas-folder>]
 * Prints OK/FAIL lines, exits 1 if any required check fails. Never prints secret values.
 * Network calls: Discogs GET /oauth/identity, Anthropic GET /v1/models (free),
 * HITLOOP POST .../usage with NO auth (expects 401; writes nothing).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { DiscogsClient } from './client.ts';
import { readCostLog } from './cost.ts';

const HOME = join(homedir(), '.discogs-ingest');
const folder = process.argv.slice(2).find(a => !a.startsWith('--')) || '/Volumes/bryan/MacTransfer/discogs';
let failed = 0;

function report(ok: boolean, name: string, detail = '', required = true) {
  if (!ok && required) failed++;
  console.log(`${ok ? 'OK  ' : required ? 'FAIL' : 'WARN'}  ${name}${detail ? ` - ${detail}` : ''}`);
}
function run(cmd: string, args: string[]): string | null {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
}
function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else { files++; bytes += statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  // Runtime
  const major = Number(process.versions.node.split('.')[0]);
  report(major >= 22, 'node version', process.versions.node);
  report(platform() === 'darwin', 'macOS', platform(), false);

  // ffmpeg / ffprobe
  const ffv = run('ffmpeg', ['-version']);
  report(!!ffv, 'ffmpeg present', ffv?.split('\n')[0] ?? 'not found');
  report(!!run('ffprobe', ['-version']), 'ffprobe present');
  if (ffv) {
    const filters = run('ffmpeg', ['-hide_banner', '-filters']) ?? '';
    for (const f of ['loudnorm', 'ebur128', 'astats', 'scale_vt']) {
      report(new RegExp(`\\s${f}\\s`).test(filters), `ffmpeg filter ${f}`, '', f !== 'scale_vt');
    }
    const enc = run('ffmpeg', ['-hide_banner', '-encoders']) ?? '';
    report(/\sh264_videotoolbox\s/.test(enc), 'ffmpeg encoder h264_videotoolbox', 'macOS only', false);
    report(/\slibx264\s/.test(enc), 'ffmpeg encoder libx264');
  }
  report(existsSync('/usr/bin/sips'), 'sips present');

  // Env names (values never printed)
  for (const n of ['DISCOGS_TOKEN', 'ANTHROPIC_API_KEY', 'HITLOOP_ARCHIVE_CONTROL_URL', 'HITLOOP_ARCHIVE_WORKER_TOKEN']) {
    report(Boolean(process.env[n]), `env ${n}`, process.env[n] ? 'set' : 'missing');
  }

  // Discogs identity
  const dc = new DiscogsClient();
  if (dc.configured) {
    try { const me = await dc.identity(); report(true, 'Discogs identity', me.username); }
    catch (e) { report(false, 'Discogs identity', (e as Error).message); }
  } else report(false, 'Discogs identity', 'no token');

  // Anthropic key (GET /v1/models is free)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
      report(r.ok, 'Anthropic key valid', `HTTP ${r.status}`);
    } catch (e) { report(false, 'Anthropic key valid', (e as Error).message); }
  } else report(false, 'Anthropic key valid', 'no key');

  // HITLOOP reachable: unauthenticated POST must be 401 (route exists, nothing written)
  const base = process.env.HITLOOP_ARCHIVE_CONTROL_URL?.replace(/\/+$/, '');
  if (base) {
    try {
      const r = await fetch(`${base}/api/archive/worker/usage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000),
      });
      report(r.status === 401, 'HITLOOP worker route reachable', `unauthenticated POST -> HTTP ${r.status} (expect 401)`);
    } catch (e) { report(false, 'HITLOOP worker route reachable', `${(e as Error).message} (is npm run dev up?)`); }
  } else report(false, 'HITLOOP worker route reachable', 'no URL');

  // NAS folder
  try {
    const names = readdirSync(folder).filter(n => !n.startsWith('.'));
    report(true, `NAS folder readable ${folder}`, `${names.length} files`);
  } catch (e) { report(false, `NAS folder readable ${folder}`, (e as Error).message); }

  // Local state dirs writable
  for (const d of ['', 'src', 'work', 'runs', 'cache']) {
    const p = join(HOME, d);
    try {
      mkdirSync(p, { recursive: true });
      const t = join(p, `.doctor-${process.pid}`);
      writeFileSync(t, ''); unlinkSync(t);
      report(true, `writable ${p}`);
    } catch (e) { report(false, `writable ${p}`, (e as Error).message); }
  }

  // Cache stats
  const src = dirSize(join(HOME, 'src'));
  console.log(`INFO  src cache: ${src.files} files, ${mb(src.bytes)}`);
  const readJson = (f: string): any => { try { return JSON.parse(readFileSync(join(HOME, f), 'utf8')); } catch { return null; } };
  const idx = readJson('index.json');
  console.log(`INFO  index.json entries: ${idx ? Object.keys(idx).length : 0}`);
  const pub = readJson('published.json');
  console.log(`INFO  published.json records: ${Array.isArray(pub) ? pub.length : 0}`);
  const costs = readCostLog(join(HOME, 'costs.jsonl'));
  const total = costs.reduce((s, c) => s + (c.usd ?? 0), 0);
  console.log(`INFO  costs.jsonl: ${costs.length} runs, total spend $${total.toFixed(4)}`);

  console.log(failed ? `\n${failed} required check(s) FAILED` : '\nAll required checks OK');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
