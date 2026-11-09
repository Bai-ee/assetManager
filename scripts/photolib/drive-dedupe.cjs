#!/usr/bin/env node
/**
 * drive-dedupe — delete photo/video files on an ATTACHED DRIVE whose identical bytes are on the Life Timeline (NAS).
 * Owner decision 2026-11-08 (LIFE-TIMELINE-ICLOUD-INGEST-PLAN.md § Attached drives cleanup).
 *
 *   node drive-dedupe.cjs <list.txt of absolute drive paths> <tag> [--delete]
 *
 * Default is a DRY RUN (hashes + reports, deletes nothing). With --delete, a file is unlinked only when:
 *   - it is a photo/video extension, not under /Volumes/bryan, not inside Backups.backupdb or any library/app bundle;
 *   - its size equals a timeline asset or child (manifest ~/.photolib/photolib.sqlite, read-only);
 *   - its sha256 equals that asset's sha256, AND the NAS file at the asset's canonical path re-hashes to the same sha256.
 * Every deletion is appended to ~/.photolib/logs/drive-dedupe-<tag>.tsv (time, drive path, size, sha256, NAS path) so any
 * file can be copied back from the NAS.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const Database = require(path.join(__dirname, '../../node_modules/better-sqlite3'));

const [listFile, tag, flag] = process.argv.slice(2);
if (!listFile || !tag || (flag && flag !== '--delete')) { console.error('usage: drive-dedupe.cjs <list.txt> <tag> [--delete]'); process.exit(2); }
const DELETE = flag === '--delete';
const NAS = '/Volumes/bryan';
const MEDIA = /\.(jpe?g|heic|heif|png|gif|tiff?|cr2|cr3|nef|arw|dng|raf|orf|rw2|mov|mp4|m4v|avi|3gp|mts)$/i;
const FORBIDDEN = /(^|\/)(Backups\.backupdb|[^/]+\.(photoslibrary|migratedphotolibrary|photolibrary|app|backupbundle|sparsebundle)|iPhoto Library)(\/|$)/i;

const db = new Database(path.join(os.homedir(), '.photolib/photolib.sqlite'), { readonly: true, fileMustExist: true });
const bySize = new Map();
for (const r of db.prepare(`select sha256, size_bytes s, canonical_path p from assets union all select sha256, size_bytes s, canonical_path p from children`).all()) {
  (bySize.get(r.s) ?? bySize.set(r.s, []).get(r.s)).push(r);
}
db.close();

const sha = p => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(p, { highWaterMark: 8 << 20 }).on('error', rej).on('data', d => h.update(d)).on('end', () => res(h.digest('hex')));
});

(async () => {
  if (!fs.existsSync(path.join(NAS, 'HITLOOP-ARCHIVE/timeline'))) throw new Error('NAS timeline not mounted at /Volumes/bryan');
  const logPath = path.join(os.homedir(), `.photolib/logs/drive-dedupe-${tag}.tsv`);
  const files = fs.readFileSync(listFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const c = { listed: files.length, deleted: 0, wouldDelete: 0, bytes: 0, notOnTimeline: 0, skippedRule: 0, missing: 0, nasMismatch: 0, errors: 0 };
  const nasVerified = new Map(); // NAS path -> sha (each NAS file hashed once per run)
  for (const f of files) {
    try {
      if (!path.isAbsolute(f) || f.startsWith(NAS + '/') || !f.startsWith('/Volumes/') || FORBIDDEN.test(f) || !MEDIA.test(f)) { c.skippedRule++; continue; }
      let st; try { st = fs.statSync(f); } catch { c.missing++; continue; }
      if (!st.isFile()) { c.skippedRule++; continue; }
      const cands = bySize.get(st.size);
      if (!cands) { c.notOnTimeline++; continue; }
      const h = await sha(f);
      const hit = cands.find(r => r.sha256 === h);
      if (!hit) { c.notOnTimeline++; continue; }
      const nasPath = path.join(NAS, hit.p);
      let nh = nasVerified.get(nasPath);
      if (nh === undefined) { nh = fs.existsSync(nasPath) && fs.statSync(nasPath).size === st.size ? await sha(nasPath) : null; nasVerified.set(nasPath, nh); }
      if (nh !== h) { c.nasMismatch++; console.error(`NAS copy not verified, kept: ${f}`); continue; }
      if (DELETE) {
        fs.unlinkSync(f);
        fs.appendFileSync(logPath, [new Date().toISOString(), f, st.size, h, hit.p].join('\t') + '\n');
        c.deleted++;
      } else c.wouldDelete++;
      c.bytes += st.size;
    } catch (e) { c.errors++; console.error(`error ${f}: ${e.message}`); }
  }
  console.log(JSON.stringify({ mode: DELETE ? 'delete' : 'dry-run', ...c, gb: +(c.bytes / 1e9).toFixed(2), log: DELETE ? logPath : null }));
})().catch(e => { console.error(e.message); process.exit(1); });
