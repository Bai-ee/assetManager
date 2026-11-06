/**
 * P0 recon — read-only inspection of an Apple Photos (1–4) or iPhoto (9.5+) library.
 *
 *   npm run photolib:inspect -- "<library path>" [--compare "<other library>"]...
 *       [--exif-sample 25] [--out report.md] [--json out.json]
 *
 * Never writes inside the library: the DB (+ -wal/-shm) is copied to a temp dir
 * and opened there. Requires `exiftool` on PATH for the date spot-check.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

const APPLE_EPOCH = 978307200; // 2001-01-01T00:00:00Z

type Kind = 'photos' | 'iphoto';
interface Lib {
  root: string;
  kind: Kind;
  dbPath: string;
  db: Database.Database;
  tmp: string;
  cols: Record<string, Set<string>>;
}

function parseArgs(argv: string[]) {
  const out = { lib: '', compare: [] as string[], exifSample: 25, out: '', json: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compare') out.compare.push(argv[++i]);
    else if (a === '--exif-sample') out.exifSample = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (!out.lib) out.lib = a;
  }
  if (!out.lib) throw new Error('usage: photolib:inspect -- <library> [--compare <lib>] [--exif-sample N] [--out md] [--json file]');
  return out;
}

export function detectLibrary(root: string): { kind: Kind; dbPath: string } {
  const photos = path.join(root, 'database', 'photos.db');
  if (fs.existsSync(photos)) return { kind: 'photos', dbPath: photos };
  const iphoto = path.join(root, 'Database', 'apdb', 'Library.apdb');
  if (fs.existsSync(iphoto)) return { kind: 'iphoto', dbPath: iphoto };
  throw new Error(`no photos.db or Library.apdb under ${root}`);
}

/** Copy DB + sidecars to a temp dir; the copy (never the library) is opened. */
export function openLibrary(root: string): Lib {
  const { kind, dbPath } = detectLibrary(root);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photolib-'));
  const base = path.basename(dbPath);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, base + suffix));
  }
  const db = new Database(path.join(tmp, base)); // writable copy so the WAL can replay
  const cols: Record<string, Set<string>> = {};
  for (const t of ['RKMaster', 'RKVersion', 'RKAlbum', 'RKAlbumVersion', 'RKKeywordForVersion', 'RKAdjustmentData', 'RKFolder']) {
    try {
      cols[t] = new Set((db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((r) => r.name));
    } catch {
      cols[t] = new Set();
    }
  }
  return { root, kind, dbPath, db, tmp, cols };
}

function closeLibrary(lib: Lib) {
  lib.db.close();
  fs.rmSync(lib.tmp, { recursive: true, force: true });
}

const has = (lib: Lib, t: string, c: string) => lib.cols[t]?.has(c) ?? false;
const one = <T = number>(lib: Lib, sql: string): T => Object.values(lib.db.prepare(sql).get() as object)[0] as T;
const sumIf = (lib: Lib, t: string, c: string, expr = c) => (has(lib, t, c) ? one(lib, `select coalesce(sum(${expr}),0) from ${t}`) : null);

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.DS_Store' || e.name.startsWith('._')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

interface MasterRow {
  uuid: string;
  imagePath: string;
  originalFileName: string | null;
  fileSize: number | null;
  uti: string | null;
  imageDate: number | null;
  tzOffset: number | null;
  tzName: string | null;
  fingerprint: string | null;
  mediaGroupId: string | null;
  isInTrash: number;
  isMissing: number;
  fileIsReference: number;
}

function readMasters(lib: Lib): MasterRow[] {
  const m = (c: string, alias = c) => (has(lib, 'RKMaster', c) ? `m.${c} as ${alias}` : `null as ${alias}`);
  const v = (c: string, alias = c) => (has(lib, 'RKVersion', c) ? `v.${c} as ${alias}` : `null as ${alias}`);
  // version join: original (versionNumber 0) carries tz name in both schemas
  const sql = `select m.uuid as uuid, m.imagePath as imagePath, ${m('originalFileName')}, ${m('fileSize')},
      ${has(lib, 'RKMaster', 'UTI') ? 'm.UTI' : has(lib, 'RKMaster', 'type') ? 'm.type' : 'null'} as uti,
      m.imageDate as imageDate, ${m('imageTimeZoneOffsetSeconds', 'tzOffset')}, ${v('imageTimeZoneName', 'tzName')},
      ${m('fingerprint')}, ${m('mediaGroupId')},
      coalesce(m.isInTrash,0) as isInTrash, coalesce(m.isMissing,0) as isMissing, coalesce(m.fileIsReference,0) as fileIsReference
    from RKMaster m left join RKVersion v on v.modelId =
      (select v2.modelId from RKVersion v2 where v2.masterUuid = m.uuid order by v2.versionNumber, v2.modelId limit 1)`;
  return lib.db.prepare(sql).all() as MasterRow[];
}

/** Parse a GMT±HHMM name or IANA name into offset seconds at the given UTC instant. */
export function tzOffsetSeconds(name: string | null, utcMs: number): number | null {
  if (!name) return null;
  const g = /^GMT([+-])(\d{2})(\d{2})$/.exec(name);
  if (g) return (g[1] === '-' ? -1 : 1) * (Number(g[2]) * 3600 + Number(g[3]) * 60);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: name, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - utcMs) / 1000);
  } catch {
    return null;
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function exiftoolJson(files: string[]): Record<string, unknown>[] {
  if (!files.length) return [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    const raw = execFileSync('exiftool', ['-json', '-fast', '-n', '-DateTimeOriginal', '-OffsetTimeOriginal', '-CreateDate',
      '-CreationDate', '-GPSLatitude', '-GPSLongitude', '-ContentIdentifier', '-MIMEType', ...chunk],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    out.push(...(JSON.parse(raw) as Record<string, unknown>[]));
  }
  return out;
}

/** EXIF "YYYY:MM:DD HH:MM:SS" → same string as a wall-clock key. */
const exifWall = (s: unknown) => (typeof s === 'string' && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !s.startsWith('0000')
  ? s.slice(0, 19).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : null);

function sample<T>(arr: T[], n: number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const dupKey = (name: string | null, size: number | null) => (name && size ? `${name.toLowerCase()}|${size}` : null);

export function inspect(libPath: string, opts: { compare?: string[]; exifSample?: number } = {}) {
  const lib = openLibrary(libPath);
  try {
    const r: Record<string, unknown> = { library: libPath, kind: lib.kind, generatedAt: new Date().toISOString() };
    const masters = readMasters(lib);
    const live = masters.filter((x) => !x.isInTrash);

    // --- DB counts
    const byUti: Record<string, number> = {};
    for (const x of live) byUti[x.uti ?? '?'] = (byUti[x.uti ?? '?'] ?? 0) + 1;
    const isVideo = (u: string | null) => !!u && /movie|mpeg|video|avi/i.test(u);
    r.db = {
      masters: masters.length,
      inTrash: masters.length - live.length,
      missingFlag: live.filter((x) => x.isMissing).length,
      referenced: live.filter((x) => x.fileIsReference).length,
      videos: live.filter((x) => isVideo(x.uti)).length,
      photos: live.filter((x) => !isVideo(x.uti)).length,
      bytes: live.reduce((s, x) => s + (x.fileSize ?? 0), 0),
      byUti,
      versions: one(lib, 'select count(*) from RKVersion'),
      versionsWithAdjustments: sumIf(lib, 'RKVersion', 'hasAdjustments'),
      adjustmentRows: lib.cols.RKAdjustmentData.size ? one(lib, 'select count(*) from RKAdjustmentData') : null,
      favorites: sumIf(lib, 'RKVersion', 'isFavorite') ?? sumIf(lib, 'RKVersion', 'mainRating', 'mainRating > 0'),
      hidden: sumIf(lib, 'RKVersion', 'isHidden'),
      titled: has(lib, 'RKVersion', 'name') ? one(lib, "select count(*) from RKVersion where name is not null and name <> ''") : null,
      described: has(lib, 'RKVersion', 'extendedDescription') ? one(lib, "select count(*) from RKVersion where extendedDescription is not null and extendedDescription <> ''") : null,
      keywordLinks: lib.cols.RKKeywordForVersion.size ? one(lib, 'select count(*) from RKKeywordForVersion') : null,
      gps: has(lib, 'RKVersion', 'latitude') ? one(lib, 'select count(*) from RKVersion where latitude is not null')
        : has(lib, 'RKVersion', 'exifLatitude') ? one(lib, 'select count(*) from RKVersion where exifLatitude is not null') : null,
      tzName: live.filter((x) => x.tzName).length,
      tzOffset: live.filter((x) => x.tzOffset != null).length,
      dated: live.filter((x) => x.imageDate != null).length,
      liveGroups: new Set(live.map((x) => x.mediaGroupId).filter(Boolean)).size,
      liveMembers: live.filter((x) => x.mediaGroupId).length,
      userAlbums: lib.cols.RKAlbum.size
        ? one(lib, `select count(*) from RKAlbum where coalesce(isInTrash,0)=0 and coalesce(isMagic,0)=0 and name is not null`) : null,
      albumLinks: lib.cols.RKAlbumVersion.size ? one(lib, 'select count(*) from RKAlbumVersion') : null,
    };
    const dates = live.map((x) => x.imageDate).filter((d): d is number => d != null).sort((a, b) => a - b);
    if (dates.length) r.dateRangeUtc = [iso((dates[0] + APPLE_EPOCH) * 1000), iso((dates[dates.length - 1] + APPLE_EPOCH) * 1000)];
    const years: Record<string, number> = {};
    for (const d of dates) { const y = new Date((d + APPLE_EPOCH) * 1000).getUTCFullYear(); years[y] = (years[y] ?? 0) + 1; }
    r.byYear = years;
    const tzNames: Record<string, number> = {};
    for (const x of live) tzNames[x.tzName ?? 'null'] = (tzNames[x.tzName ?? 'null'] ?? 0) + 1;
    r.tzNames = tzNames;

    // --- disk vs DB
    const mastersDir = path.join(lib.root, 'Masters');
    const diskFiles = walk(mastersDir);
    const diskRel = new Set(diskFiles.map((f) => path.relative(mastersDir, f)));
    const dbRel = new Set(masters.map((x) => x.imagePath));
    const missing = live.filter((x) => !x.fileIsReference && !diskRel.has(x.imagePath));
    const orphans = diskFiles.filter((f) => !dbRel.has(path.relative(mastersDir, f)));
    const sizeOf = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const orphanBytes = orphans.reduce((s, f) => s + sizeOf(f), 0);
    const extCount = (files: string[]) => files.reduce<Record<string, number>>((acc, f) => {
      const e = path.extname(f).toLowerCase() || '(none)'; acc[e] = (acc[e] ?? 0) + 1; return acc;
    }, {});
    r.disk = {
      masterFiles: diskFiles.length,
      byExt: extCount(diskFiles),
      dbMastersMissingOnDisk: missing.length,
      missingSample: missing.slice(0, 10).map((x) => x.imagePath),
      orphanFiles: orphans.length,
      orphanBytes,
      orphanByExt: extCount(orphans),
      orphanSample: orphans.slice(0, 15).map((f) => path.relative(mastersDir, f)),
    };
    const resDir = path.join(lib.root, 'resources');
    const resFiles = walk(resDir);
    const resTop: Record<string, number> = {};
    for (const f of resFiles) { const top = path.relative(resDir, f).split(path.sep).slice(0, 2).join('/'); resTop[top] = (resTop[top] ?? 0) + 1; }
    r.resources = {
      files: resFiles.length,
      byTopDir: resTop,
      movFiles: resFiles.filter((f) => /\.mov$/i.test(f)).length,
      fullsizeOutputs: resFiles.filter((f) => /fullsizeoutput/i.test(path.basename(f))).length,
      movSample: resFiles.filter((f) => /\.mov$/i.test(f)).slice(0, 5).map((f) => path.relative(resDir, f)),
      fullsizeSample: resFiles.filter((f) => /fullsizeoutput/i.test(path.basename(f))).slice(0, 5).map((f) => path.relative(resDir, f)),
    };

    // --- in-library dupes (same name+size, or same fingerprint)
    const seen = new Map<string, number>();
    for (const x of live) { const k = x.fingerprint ?? dupKey(x.originalFileName, x.fileSize); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
    const dupExtra = [...seen.values()].reduce((s, n) => s + (n - 1), 0);
    r.dupesWithinLibrary = { extraCopies: dupExtra, key: lib.kind === 'photos' ? 'fingerprint' : 'name+size' };
    r.estCopy = {
      files: diskFiles.length - missing.length - dupExtra,
      bytes: (r.db as { bytes: number }).bytes + orphanBytes,
      note: 'unique DB masters + orphan files; exact sha dedupe happens in P1',
    };

    // --- exiftool spot-check: DB date vs EXIF, both interpretations of imageDate
    const n = opts.exifSample ?? 25;
    const pick = sample(live.filter((x) => !isVideo(x.uti) && x.imageDate != null && diskRel.has(x.imagePath)), n);
    const exif = exiftoolJson(pick.map((x) => path.join(mastersDir, x.imagePath)));
    const exifBy = new Map(exif.map((e) => [String(e.SourceFile), e]));
    let utcLocalMatch = 0, wallMatch = 0, exifDated = 0;
    const rows = pick.map((x) => {
      const e = exifBy.get(path.join(mastersDir, x.imagePath)) ?? {};
      const utcMs = (x.imageDate! + APPLE_EPOCH) * 1000;
      const off = x.tzOffset ?? tzOffsetSeconds(x.tzName, utcMs) ?? 0;
      const asUtcToLocal = iso(utcMs + off * 1000); // imageDate = UTC instant
      const asWall = iso(utcMs);                     // imageDate = local wall clock
      const ew = exifWall(e.DateTimeOriginal);
      if (ew) { exifDated++; if (ew === asUtcToLocal) utcLocalMatch++; if (ew === asWall) wallMatch++; }
      return { file: x.imagePath, exif: ew, exifOffset: e.OffsetTimeOriginal ?? null, dbUtcPlusTz: asUtcToLocal, dbRaw: asWall, tz: x.tzName, off };
    });
    r.exifSpotCheck = { sampled: pick.length, exifDated, matchIfImageDateIsUtc: utcLocalMatch, matchIfImageDateIsWallClock: wallMatch, rows };

    // --- orphans: do they carry their own dates?
    const orphanExif = exiftoolJson(orphans);
    const oDated = orphanExif.filter((e) => exifWall(e.DateTimeOriginal) || exifWall(e.CreationDate) || exifWall(e.CreateDate)).length;
    const contentIds = orphanExif.filter((e) => e.ContentIdentifier).length;
    r.orphanExif = { files: orphans.length, withCaptureDate: oDated, withContentIdentifier: contentIds };

    // --- live photo partners (MOV with ContentIdentifier anywhere under the bundle's Masters+resources)
    const movs = [...diskFiles, ...resFiles].filter((f) => /\.mov$/i.test(f));
    const movExif = exiftoolJson(movs);
    const movIds = new Set(movExif.map((e) => e.ContentIdentifier).filter(Boolean).map(String));
    const groupIds = new Set(live.map((x) => x.mediaGroupId).filter(Boolean).map(String));
    r.livePairs = {
      dbGroups: groupIds.size,
      movWithContentId: movIds.size,
      matchedGroups: [...groupIds].filter((g) => movIds.has(g)).length,
    };

    // --- cross-library dupes
    const mine = new Set(live.map((x) => dupKey(x.originalFileName, x.fileSize)).filter(Boolean) as string[]);
    r.compare = (opts.compare ?? []).map((other) => {
      const ol = openLibrary(other);
      try {
        const om = readMasters(ol).filter((x) => !x.isInTrash);
        const keys = om.map((x) => dupKey(x.originalFileName, x.fileSize)).filter(Boolean) as string[];
        const overlap = keys.filter((k) => mine.has(k)).length;
        return { library: other, kind: ol.kind, masters: om.length, overlapByNameSize: overlap };
      } finally { closeLibrary(ol); }
    });
    return r;
  } finally {
    closeLibrary(lib);
  }
}

const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;

export function toMarkdown(r: Record<string, any>): string {
  const d = r.db, k = r.disk, x = r.exifSpotCheck;
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([a, b]) => `${a} ${b}`).join(' · ');
  return [
    `# Photolib recon — ${path.basename(r.library)}`,
    '', `- Library: \`${r.library}\` (${r.kind})`, `- Generated: ${r.generatedAt}`, '',
    '## DB', '| metric | value |', '|---|---|',
    ...Object.entries(d).filter(([, v]) => typeof v !== 'object').map(([a, v]) => `| ${a} | ${a === 'bytes' ? gb(v as number) : v} |`),
    `| byUti | ${kv(d.byUti)} |`,
    `| date range (UTC) | ${(r.dateRangeUtc ?? []).join(' → ')} |`, `| by year | ${kv(r.byYear)} |`, `| tz names | ${kv(r.tzNames)} |`,
    '', '## Disk vs DB', '| metric | value |', '|---|---|',
    `| Masters files on disk | ${k.masterFiles} (${kv(k.byExt)}) |`,
    `| DB masters missing on disk | ${k.dbMastersMissingOnDisk} |`,
    `| orphan files (on disk, not in DB) | ${k.orphanFiles} · ${gb(k.orphanBytes)} · ${kv(k.orphanByExt)} |`,
    `| orphans with own capture date | ${r.orphanExif.withCaptureDate} / ${r.orphanExif.files} (ContentIdentifier ${r.orphanExif.withContentIdentifier}) |`,
    `| resources files | ${r.resources.files} · mov ${r.resources.movFiles} · fullsizeoutput ${r.resources.fullsizeOutputs} |`,
    `| resources dirs | ${kv(r.resources.byTopDir)} |`,
    `| live pairs | DB groups ${r.livePairs.dbGroups} · MOVs w/ ContentIdentifier ${r.livePairs.movWithContentId} · matched ${r.livePairs.matchedGroups} |`,
    `| dupes within library (${r.dupesWithinLibrary.key}) | ${r.dupesWithinLibrary.extraCopies} |`,
    `| est. copy | ${r.estCopy.files} files · ${gb(r.estCopy.bytes)} (${r.estCopy.note}) |`,
    '', 'Orphan sample:', ...k.orphanSample.map((s: string) => `- \`${s}\``),
    '', 'Resources samples:', ...[...r.resources.movSample, ...r.resources.fullsizeSample].map((s: string) => `- \`${s}\``),
    '', '## EXIF spot-check (DB imageDate vs EXIF DateTimeOriginal)',
    `Sampled ${x.sampled}, EXIF-dated ${x.exifDated}. Match if imageDate = UTC instant (+tz): **${x.matchIfImageDateIsUtc}** · if wall clock: **${x.matchIfImageDateIsWallClock}**.`,
    '', '| file | EXIF | EXIF offset | DB utc+tz | DB raw | tz |', '|---|---|---|---|---|---|',
    ...x.rows.map((w: any) => `| ${w.file} | ${w.exif ?? '—'} | ${w.exifOffset ?? '—'} | ${w.dbUtcPlusTz} | ${w.dbRaw} | ${w.tz} |`),
    '', '## Cross-library overlap (name+size)',
    ...(r.compare.length ? r.compare.map((c: any) => `- \`${c.library}\` (${c.kind}): ${c.masters} masters, ${c.overlapByNameSize} overlap`) : ['- none compared']),
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const a = parseArgs(process.argv.slice(2));
  const report = inspect(a.lib, { compare: a.compare, exifSample: a.exifSample });
  const md = toMarkdown(report);
  if (a.out) fs.writeFileSync(a.out, md);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(report, null, 2));
  process.stdout.write(md);
}
