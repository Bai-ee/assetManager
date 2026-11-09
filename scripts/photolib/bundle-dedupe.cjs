#!/usr/bin/env node
/**
 * bundle-dedupe — delete a whole photo-library bundle on an attached drive ONLY if a byte-identical twin exists on the NAS.
 *   node bundle-dedupe.cjs "<drive bundle>" "<NAS twin bundle>" <tag> [--delete]
 * Identical = same set of relative file paths (ignoring ._* and .DS_Store) with equal sizes AND equal sha256 for every file.
 * Dry run unless --delete. Result appended to ~/.photolib/logs/bundle-dedupe-<tag>.tsv. Never touches the NAS twin.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const [drive, nas, tag, flag] = process.argv.slice(2);
if (!drive || !nas || !tag || (flag && flag !== '--delete')) { console.error('usage: bundle-dedupe.cjs <drive bundle> <nas bundle> <tag> [--delete]'); process.exit(2); }
if (!drive.startsWith('/Volumes/') || drive.startsWith('/Volumes/bryan/')) throw new Error('drive bundle must be on an attached drive');
if (!nas.startsWith('/Volumes/bryan/')) throw new Error('twin must be on the NAS');
if (!/\.(photoslibrary|photolibrary|migratedphotolibrary)$|\/iPhoto Library$/.test(drive)) throw new Error('not a library bundle');

const list = root => {
  const out = new Map();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('._') || e.name === '.DS_Store') continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { out.set(path.relative(root, p), { link: fs.readlinkSync(p) }); continue; }
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.set(path.relative(root, p), { size: fs.statSync(p).size });
    }
  };
  walk(root);
  return out;
};
const sha = p => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(p, { highWaterMark: 8 << 20 }).on('error', rej).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))); });

(async () => {
  const a = list(drive), b = list(nas);
  const diff = [];
  for (const [k, v] of a) { const w = b.get(k); if (!w || w.size !== v.size || w.link !== v.link) diff.push(k); }
  for (const k of b.keys()) if (!a.has(k)) diff.push(`(nas only) ${k}`);
  const bytes = [...a.values()].reduce((s, v) => s + (v.size || 0), 0);
  let shaMismatch = 0, checked = 0;
  if (!diff.length) {
    for (const [k, v] of a) {
      if (v.link !== undefined) continue;
      if ((await sha(path.join(drive, k))) !== (await sha(path.join(nas, k)))) { shaMismatch++; diff.push(`(sha) ${k}`); if (shaMismatch > 20) break; }
      checked++;
    }
  }
  const identical = diff.length === 0;
  let deleted = false;
  if (identical && flag === '--delete') { fs.rmSync(drive, { recursive: true }); deleted = true; }
  const res = { drive, nas, files: a.size, gb: +(bytes / 1e9).toFixed(2), identical, checked, diffs: diff.length, sampleDiffs: diff.slice(0, 8), deleted };
  fs.appendFileSync(path.join(os.homedir(), `.photolib/logs/bundle-dedupe-${tag}.tsv`), [new Date().toISOString(), drive, nas, a.size, bytes, identical, deleted].join('\t') + '\n');
  console.log(JSON.stringify(res));
})().catch(e => { console.error(e.message); process.exit(1); });
