/**
 * Heartbeat: builds the public `life.status/1` document for the Life Timeline status page and POSTs it.
 *   npx tsx scripts/photolib/heartbeat.mts            (normally via heartbeat.sh from launchd every 300 s)
 *
 * Read-only against the run: ~/.photolib/RUN_ENABLED, logs/icloud-all.log, the newest logs/icloud-run-*.log,
 * photolib.sqlite (readonly), pmset, df, mount, curl localhost:3005, pgrep. It never stats the NAS share.
 * Writes ~/.photolib/status.json (the same document plus a private `_samples` array used for the rate estimate;
 * `_samples` is stripped from the POST) and POSTs to ${LIFE_STATUS_URL:-https://life.hitloop.agency}/api/archive/worker/life/status.
 * A failed POST is one line in ~/.photolib/logs/heartbeat.log and exit code 0. The document is public: no paths,
 * file names or account names ever go in (everything free-form passes through clean()).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

const HOME = os.homedir();
const PH = process.env.PHOTOLIB_HOME || path.join(HOME, '.photolib');
const LOGS = path.join(PH, 'logs');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCHEMA = 'life.status/1';

// ---------- helpers ----------
const sh = (cmd: string, args: string[], timeoutMs = 8000): string | null => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { const out = (e as { stdout?: string }).stdout; return typeof out === 'string' && out ? out : null; }
};
const read = (p: string, maxBytes = 48 * 1024 * 1024): string => {
  try {
    const st = fs.statSync(p);
    if (st.size <= maxBytes) return fs.readFileSync(p, 'utf8');
    const fd = fs.openSync(p, 'r');
    try { const b = Buffer.alloc(maxBytes); fs.readSync(fd, b, 0, maxBytes, st.size - maxBytes); return b.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return ''; }
};
/** Public-safe free text: drop path-like tokens, file names, e-mail addresses, clip to 160 chars. */
export function clean(s: string): string {
  return s
    .replace(/\S*\/\S*/g, '')
    .replace(/\S+\.(jpe?g|heic|png|mov|mp4|mp3|m4v|gif|tiff?|dng|xmp|aae|sqlite|json|log)\b/gi, '')
    .replace(/\S+@\S+/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}
const localIso = (d: string, t: string): string => new Date(`${d}T${t}`).toISOString();
const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (.*)$/;
interface L { at: string; ms: number; text: string }
export function parseLines(text: string): L[] {
  const out: L[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const at = localIso(m[1], m[2]);
    out.push({ at, ms: Date.parse(at), text: m[3] });
  }
  return out;
}
const STEP_LINE = /^(===|done |ok |retry |FAIL|plan:|plan empty|no files|apply |verify:|reusing plan|downloaded |NAS not mounted)/;

// ---------- run state ----------
export type Step = 'download' | 'plan' | 'apply' | 'thumbs' | 'push' | 'verify' | null;
export interface Section { label: string | null; startedAt: string | null; step: Step; stepStartedAt: string | null; failLine: string | null; planItems: number | null; monthly: boolean }

/** Derives the current batch/month and step from the lines of the newest run log. */
export function currentSection(lines: L[]): Section {
  let hdr = -1, monthly = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^=== month \S+ ===$/.test(lines[i].text)) { hdr = i; monthly = true; break; }
  }
  if (hdr < 0) for (let i = lines.length - 1; i >= 0; i--) if (/^=== batch \S+ ===$/.test(lines[i].text)) { hdr = i; break; }
  if (hdr < 0) return { label: null, startedAt: null, step: null, stepStartedAt: null, failLine: null, planItems: null, monthly: false };
  const h = lines[hdr];
  let label: string;
  if (monthly) label = /^=== month (\S+) ===$/.exec(h.text)![1];
  else { const m = /^=== batch (\d+)\.\.(\d+) ===$/.exec(h.text)!; label = m[1] === m[2] ? m[1] : `${m[1]}-${m[2]}`; }
  let step: Step = 'download', stepAt = h.at, failLine: string | null = null, planItems: number | null = null;
  const move = (s: Step, at: string) => { step = s; stepAt = at; };
  for (const l of lines.slice(hdr + 1)) {
    const t = l.text;
    if (/^ok download/.test(t)) move('plan', l.at);
    else if (/^plan: planId/.test(t)) { const it = /"items":(\d+)/.exec(t); planItems = it ? Number(it[1]) : null; move('apply', l.at); }
    else if (/^reusing plan/.test(t)) move('apply', l.at);
    else if (/^(no files|plan empty)/.test(t)) move('verify', l.at);
    else if (/^ok apply/.test(t)) move('thumbs', l.at);
    else if (/^ok thumbs/.test(t)) move('push', l.at);
    else if (/^ok push/.test(t)) move('verify', l.at);
    else if (/^FAIL/.test(t)) failLine = t;
    // download skipped (--no-download / DOWNLOAD_SCOPE=year): "downloaded <label>" line while still in the download step
    else if (/^downloaded /.test(t) && step === 'download') move('plan', l.at);
    else if (/^verify:/.test(t) || /^done /.test(t) || /^=== done /.test(t)) move('verify', l.at);
  }
  return { label, startedAt: h.at, step, stepStartedAt: stepAt, failLine, planItems, monthly };
}

/** Counts icloudpd "Downloaded" lines after the section header (raw text, for speed). */
export function countDownloaded(text: string, startedAtMs: number | null): number {
  let n = 0;
  const re = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) INFO\s+Downloaded /gm;
  const hdrRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} === (month|batch) /gm;
  let from = 0, m: RegExpExecArray | null;
  while ((m = hdrRe.exec(text))) from = m.index; // start of the LAST header
  re.lastIndex = from;
  while ((m = re.exec(text))) n++;
  // Quarter/year download scope: the month's files were downloaded in an earlier section, so also honour the
  // folder file count the script logs ("downloaded <label>: N files") for this section.
  const folder = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} downloaded \S+: (\d+) files/gm;
  folder.lastIndex = from;
  while ((m = folder.exec(text))) n = Math.max(n, Number(m[1]));
  void startedAtMs;
  return n;
}

export function monthLabels(fromYear: number, now: Date): string[] {
  const out: string[] = [];
  for (let y = fromYear; y <= now.getFullYear(); y++)
    for (let m = 1; m <= 12; m++) { if (y === now.getFullYear() && m > now.getMonth() + 1) break; out.push(`${y}-${String(m).padStart(2, '0')}`); }
  return out;
}

// ---------- main document ----------
interface Sample { t: string; assets: number }

export function ratePerMin(samples: Sample[], nowIso: string, assets: number): number | null {
  const now = Date.parse(nowIso);
  const win = samples.filter(s => now - Date.parse(s.t) <= 3 * 3600_000 && Date.parse(s.t) < now);
  if (!win.length) return null;
  const first = win[0];
  const mins = (now - Date.parse(first.t)) / 60_000;
  const delta = assets - first.assets;
  if (mins < 10 || delta <= 0) return null;
  return Math.round((delta / mins) * 10) / 10;
}

function build(): { doc: Record<string, unknown>; samples: Sample[] } {
  const nowD = new Date();
  const nowIso = nowD.toISOString();
  const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(PH, 'status.json'), 'utf8')); } catch { return null; } })();

  // RUN_ENABLED
  const en = read(path.join(PH, 'RUN_ENABLED')).trim().toLowerCase();
  const enabled = en === 'on' || en === 'dry' ? en : 'off';

  // icloud-all.log: last "start" line and what follows it
  const all = parseLines(read(path.join(LOGS, 'icloud-all.log')));
  let si = -1;
  for (let i = all.length - 1; i >= 0; i--) if (/^start( at \d+)?$/.test(all[i].text)) { si = i; break; }
  const sinceStart = si >= 0 ? all.slice(si) : [];
  const startYear = (() => { const m = sinceStart[0] && /^start at (\d{4})$/.exec(sinceStart[0].text); return m ? Number(m[1]) : null; })();
  const finishedYears = sinceStart.map(l => /^finished (\d{4})$/.exec(l.text)).filter(Boolean).map(m => Number(m![1]));
  const stopped = [...sinceStart].reverse().find(l => /^STOPPED at /.test(l.text));
  const allDone = sinceStart.some(l => l.text === 'ALL DONE');
  const procUp = (sh('pgrep', ['-f', 'icloud-all.sh']) ?? '').trim().length > 0;
  const state = procUp ? 'running' : stopped ? 'stopped' : allDone ? 'done' : 'idle';

  // newest run log
  let runLog: string | null = null;
  try {
    const files = fs.readdirSync(LOGS).filter(f => /^icloud-run-.*\.log$/.test(f)).map(f => ({ f, m: fs.statSync(path.join(LOGS, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    runLog = files[0]?.f ?? null;
  } catch { /* none */ }
  const runText = runLog ? read(path.join(LOGS, runLog)) : '';
  const runLines = parseLines(runText);
  const sec = currentSection(runLines);

  // monthly mode live? any "=== month" line in a run log of the start year or later
  let monthlyLive = sec.monthly;
  const doneMonths = new Set<string>();
  const monthDur: number[] = [];
  const fromYear = startYear ?? (sec.label ? Number(sec.label.slice(0, 4)) : nowD.getFullYear());
  try {
    for (const f of fs.readdirSync(LOGS).filter(f => /^icloud-run-\d{4}-\d{4}\.log$/.test(f))) {
      if (Number(f.slice(11, 15)) < fromYear) continue;
      const lines = f === runLog ? runLines : parseLines(read(path.join(LOGS, f)));
      const opened = new Map<string, number>();
      for (const l of lines) {
        let m = /^=== month (\d{4}-\d{2}) ===$/.exec(l.text);
        if (m) { monthlyLive = true; opened.set(m[1], l.ms); continue; }
        m = /^done (\d{4}-\d{2})$/.exec(l.text);
        if (m) { doneMonths.add(m[1]); const o = opened.get(m[1]); if (o && l.ms >= si_ms(all, si)) monthDur.push(l.ms - o); }
      }
    }
  } catch { /* ignore */ }

  // batches
  let labels: string[], done: string[];
  if (monthlyLive) {
    labels = monthLabels(fromYear, nowD);
    done = labels.filter(l => doneMonths.has(l) || finishedYears.includes(Number(l.slice(0, 4))));
  } else {
    labels = []; for (let y = fromYear; y <= nowD.getFullYear(); y++) labels.push(String(y));
    done = labels.filter(l => finishedYears.includes(Number(l)));
  }
  const remaining = labels.filter(l => !done.includes(l));

  // manifest
  let assets = 0, unpushed = 0, noThumb = 0, pushedLast24h = 0, pushed = 0, lastPushAt: string | null = null;
  try {
    const db = new Database(path.join(PH, 'photolib.sqlite'), { readonly: true, fileMustExist: true, timeout: 5000 });
    const since = new Date(nowD.getTime() - 24 * 3600_000).toISOString();
    const r = db.prepare(`select count(*) a, coalesce(sum(pushed_at is null),0) u, coalesce(sum(thumb_s is null or thumb_m is null),0) t,
      coalesce(sum(pushed_at > ?),0) p24, count(pushed_at) p, max(pushed_at) lp from assets`).get(since) as Record<string, number | string | null>;
    db.close();
    assets = Number(r.a); unpushed = Number(r.u); noThumb = Number(r.t); pushedLast24h = Number(r.p24); pushed = Number(r.p);
    lastPushAt = (r.lp as string) ?? null;
  } catch { /* manifest unreadable: zeros */ }

  // machine
  const batt = sh('pmset', ['-g', 'batt']) ?? '';
  const ac = sh('pmset', ['-g', 'ac']) ?? '';
  const power = /Now drawing from 'Battery Power'/.test(batt) ? 'Battery' : 'AC';
  const pct = /(\d+)%/.exec(batt);
  const watts = /Wattage = (\d+)W/.exec(ac);
  const dfLine = (sh('df', ['-k', '/']) ?? '').trim().split('\n').pop()?.split(/\s+/) ?? [];
  const diskFreeGb = dfLine[3] ? Math.round((Number(dfLine[3]) / 1048576) * 10) / 10 : 0;
  const memFree = /free percentage: (\d+)%/.exec(sh('memory_pressure', [], 8000) ?? '');
  const nasMounted = / on \/Volumes\/bryan /.test(sh('mount', []) ?? '');
  const controlServerUp = (() => { try { execFileSync('curl', ['-s', '-m', '5', '-o', '/dev/null', 'localhost:3005/'], { timeout: 8000, stdio: 'ignore' }); return true; } catch { return false; } })();

  // rate + eta
  const samples: Sample[] = (Array.isArray(prev?._samples) ? prev._samples : []).filter((s: Sample) => s && typeof s.t === 'string' && typeof s.assets === 'number');
  const itemsPerMin = ratePerMin(samples, nowIso, assets);
  samples.push({ t: nowIso, assets });
  while (samples.length > 80 || (samples.length && Date.parse(samples[0].t) < nowD.getTime() - 6 * 3600_000)) samples.shift();

  // ETA from wall-time per finished batch of THIS run (monthly: header→done pairs; yearly: gaps between finished lines)
  let durs = monthDur.slice(-6);
  if (!monthlyLive) {
    const marks = [si >= 0 ? all[si].ms : 0, ...sinceStart.filter(l => /^finished \d{4}$/.test(l.text)).map(l => l.ms)];
    durs = marks.slice(1).map((m, i) => m - marks[i]).slice(-3);
  }
  let etaFinishAt: string | null = null;
  if (state === 'running' && durs.length && remaining.length) {
    const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
    const cur = sec.startedAt ? nowD.getTime() - Date.parse(sec.startedAt) : 0;
    const left = Math.max(avg - cur, avg * 0.1) + Math.max(remaining.length - 1, 0) * avg;
    etaFinishAt = new Date(nowD.getTime() + left).toISOString();
  }

  // error
  let error: string | null = null;
  if ((state === 'stopped' || state === 'idle') && sec.failLine) {
    const tail = runLines.slice(-60).map(l => l.text).join('\n');
    error = /authenticat|2fa|two-factor|two factor|password|login/i.test(tail) && /^FAIL download/.test(sec.failLine) ? 'icloudpd auth' : clean(sec.failLine);
  } else if (state === 'stopped') error = 'run stopped';

  // recent events
  const ev: { at: string; msg: string }[] = [];
  for (const l of sinceStart) {
    let m: RegExpExecArray | null;
    if ((m = /^start at (\d{4})$/.exec(l.text))) ev.push({ at: l.at, msg: `run started at ${m[1]}` });
    else if ((m = /^finished (\d{4})$/.exec(l.text))) ev.push({ at: l.at, msg: `batch ${m[1]} finished` });
    else if ((m = /^STOPPED at (\S+)$/.exec(l.text))) ev.push({ at: l.at, msg: `STOPPED at ${clean(m[1])}` });
    else if (l.text === 'ALL DONE') ev.push({ at: l.at, msg: 'all batches done' });
  }
  const runStartMs = si >= 0 ? all[si].ms : 0;
  for (const l of runLines) {
    if (l.ms < runStartMs - 60_000 || !STEP_LINE.test(l.text) || /^downloaded |^NAS not|^apply |^===\s*(batch|done)/.test(l.text)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^=== month (\S+) ===$/.exec(l.text))) ev.push({ at: l.at, msg: `month ${m[1]} started` });
    else if ((m = /^done (\S+)$/.exec(l.text))) ev.push({ at: l.at, msg: `month ${m[1]} done` });
    else if (/^(retry|FAIL)/.test(l.text)) ev.push({ at: l.at, msg: clean(l.text) });
    else if (/^verify:/.test(l.text)) { const v = /"assets":(\d+),"unpushed":(\d+),"noThumb":(\d+)/.exec(l.text); if (v) ev.push({ at: l.at, msg: `verified: ${v[1]} assets, ${v[2]} unpushed, ${v[3]} without thumbs` }); }
    else if (/^plan: planId/.test(l.text)) { const it = /"items":(\d+)/.exec(l.text); if (it) ev.push({ at: l.at, msg: `plan ready: ${it[1]} items` }); }
  }
  ev.sort((a, b) => a.at.localeCompare(b.at));
  const recent = ev.slice(-10).map(e => ({ at: e.at, msg: clean(e.msg) }));

  const active = state === 'running' || state === 'stopped';
  const doc = {
    schema: SCHEMA,
    updatedAt: nowIso,
    run: {
      enabled, state,
      startedAt: si >= 0 ? all[si].at : null,
      batch: active ? sec.label : null,
      step: state === 'running' ? sec.step : null,
      stepStartedAt: state === 'running' ? sec.stepStartedAt : null,
      stoppedAt: state === 'stopped' ? (sec.monthly && sec.label ? sec.label : clean(/^STOPPED at (\S+)$/.exec(stopped!.text)?.[1] ?? '') || null) : null,
      error,
    },
    progress: {
      batchesDone: done.length, batchesTotal: labels.length, batchesRemaining: remaining,
      itemsDownloadedThisBatch: active && sec.label ? countDownloaded(runText, null) : 0,
      itemsThisBatchTotal: sec.planItems,
      assets, pushed, unpushed, noThumb, lastPushAt, pushedLast24h,
      itemsPerMin, etaFinishAt,
    },
    machine: {
      power, batteryPct: pct ? Number(pct[1]) : null, chargerWatts: watts ? Number(watts[1]) : null,
      diskFreeGb, memFreePct: memFree ? Number(memFree[1]) : null, nasMounted, controlServerUp,
    },
    recent,
  };
  return { doc, samples };
}
const si_ms = (all: L[], si: number) => (si >= 0 ? all[si].ms : 0);

// ---------- IO ----------
function writeAtomic(p: string, data: string) { const t = `${p}.tmp-${process.pid}`; fs.writeFileSync(t, data); fs.renameSync(t, p); }
const hbLog = (msg: string) => { try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'heartbeat.log'), `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}\n`); } catch { /* ignore */ } };

function token(): string | null {
  if (process.env.HITLOOP_ARCHIVE_WORKER_TOKEN) return process.env.HITLOOP_ARCHIVE_WORKER_TOKEN;
  const m = /^HITLOOP_ARCHIVE_WORKER_TOKEN=(.*)$/m.exec(read(path.join(REPO, '.env.local'), 1_000_000));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

async function main() {
  const { doc, samples } = build();
  fs.mkdirSync(PH, { recursive: true });
  writeAtomic(path.join(PH, 'status.json'), JSON.stringify({ ...doc, _samples: samples }, null, 2) + '\n');
  if (process.argv.includes('--no-post')) return;
  const base = (process.env.LIFE_STATUS_URL || 'https://life.hitloop.agency').replace(/\/+$/, '');
  const tok = token();
  if (!tok) { hbLog('POST skipped: no worker token'); return; }
  try {
    const res = await fetch(`${base}/api/archive/worker/life/status`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify(doc), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) hbLog(`POST failed: HTTP ${res.status}`);
  } catch (e) { hbLog(`POST failed: ${clean(String((e as Error)?.message ?? e)) || 'network error'}`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch(e => { hbLog(`error: ${clean(String(e?.message ?? e))}`); }).finally(() => process.exit(0));
