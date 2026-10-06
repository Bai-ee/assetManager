/**
 * Discogs ingest: point at a folder of record-label photos (+ videos), read the
 * labels, match each record to an existing Discogs release, add it to the
 * collection.
 *
 *   dry run (default):  npm run discogs:ingest -- <dir> [--limit N]
 *   apply:              npm run discogs:ingest -- <dir> --apply [--folder-id 1] [--notes]
 *   undo an apply run:  npm run discogs:ingest -- --undo <run>-applied.jsonl
 *   rename on the NAS:  add --rename (dry run lists the names; with --apply renames, journaled)
 *   undo renames:       npm run discogs:ingest -- --undo-renames <run>-renames.jsonl
 *
 * Renames touch only confident records (exact catno) and only inside <dir>.
 *
 * Auto-add needs score >= ADD_THRESHOLD AND an exact catalog-number match.
 * Everything else is listed for review, never written. Runs are logged under
 * ~/.discogs-ingest/runs; label reads are cached under ~/.discogs-ingest/cache
 * so re-running costs nothing. Nothing is ever written to the source folder.
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DiscogsClient } from './client.ts';
import { scanFolder, toJpeg, groupRecords, DEFAULT_INDEX_PATH } from './media.ts';
import { readLabel } from './label-reader.ts';
import { mergeReads, findCandidates } from './matcher.ts';
import { ADD_THRESHOLD, REVIEW_THRESHOLD } from './types.ts';
import type { GroupPlan, LabelRead, RecordGroup } from './types.ts';
import { CostLedger, appendCostLog } from './cost.ts';
import { plannedNames, applyRenames, undoRenames } from './rename.ts';
import { basename } from 'node:path';

const HOME = join(homedir(), '.discogs-ingest');
const CACHE = join(HOME, 'cache');
const RUNS = join(HOME, 'runs');
const NOTES_FIELD_ID = 3;
const COST_LOG = join(HOME, 'costs.jsonl');
const ledger = new CostLedger();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function hasUsefulFields(reads: LabelRead[]): boolean {
  return reads.some(r => r.status !== 'unreadable' && (r.catno || r.artist || r.title));
}

async function planGroup(client: DiscogsClient, group: RecordGroup, owned: Set<number>, claimed: Set<number>): Promise<GroupPlan> {
  const reads: LabelRead[] = [];
  for (const img of group.images) {
    const jpeg = await toJpeg(img, CACHE);
    const read = await readLabel(jpeg, img.name, { cacheDir: CACHE });
    ledger.add({ kind: 'vision', file: img.name, model: read.model, usage: read.usage, cached: read.cached });
    reads.push(read);
  }
  const base = { group, reads, candidates: [], best: null } as GroupPlan;
  if (!group.images.length) return { ...base, action: 'skip-unreadable', reason: 'video only, no label photo' };
  if (!hasUsefulFields(reads)) return { ...base, action: 'skip-unreadable', reason: 'no readable label text' };

  const candidates = await findCandidates(client, mergeReads(reads));
  const best = candidates[0] ?? null;
  const plan = { ...base, candidates, best };
  if (!best || best.score < REVIEW_THRESHOLD) return { ...plan, action: 'review', reason: 'no confident match' };
  if (owned.has(best.releaseId)) return { ...plan, action: 'already-owned', reason: 'already in collection' };
  if (claimed.has(best.releaseId)) return { ...plan, action: 'already-owned', reason: 'same release as an earlier group in this run' };
  if (best.score >= ADD_THRESHOLD && best.reasons.includes('catno exact')) {
    claimed.add(best.releaseId);
    return { ...plan, action: 'add', reason: `score ${best.score}, catno exact` };
  }
  return { ...plan, action: 'review', reason: `score ${best.score}${best.reasons.includes('catno exact') ? '' : ', no exact catno'}` };
}

const NOTES_MAX = 250; // Discogs rejects longer collection notes (422)

function notesFor(group: RecordGroup, renamed: Map<string, string> = new Map()): string {
  const name = (f: { path: string; name: string }) => renamed.has(f.path) ? basename(renamed.get(f.path)!) : f.name;
  const imgs = group.images.map(name);
  const vids = group.videos.map(name);
  const full = `HITLOOP ingest. Label photos: ${imgs.join(', ') || 'none'}. Videos: ${vids.join(', ') || 'none'}.`;
  if (full.length <= NOTES_MAX) return full;
  // Renamed files share one base; name it once and count the rest.
  const base = (imgs[0] ?? vids[0] ?? '').replace(/_(label|video)\d+(-\d+)?\.\w+$/, '');
  return `HITLOOP ingest. Files: ${base}_* (${imgs.length} label photo${imgs.length === 1 ? '' : 's'}, ${vids.length} video${vids.length === 1 ? '' : 's'}).`.slice(0, NOTES_MAX);
}

function printPlan(plans: GroupPlan[]) {
  for (const p of plans) {
    const read = mergeReads(p.reads);
    const what = [read.artist, read.title].filter(Boolean).join(' - ') || '(unread)';
    const files = [...p.group.images, ...p.group.videos].map(f => f.name).join(', ');
    console.log(`\n[${p.action.toUpperCase()}] ${p.group.id}  ${what}  | ${read.label ?? '?'} ${read.catno ?? ''}`);
    console.log(`  files: ${files}`);
    if (p.best) console.log(`  best:  ${p.best.releaseId} ${p.best.title} | ${p.best.catno} | ${p.best.formats.join(', ')} | ${p.best.score} (${p.best.reasons.join('; ')})`);
    console.log(`  why:   ${p.reason}`);
  }
  const count = (a: string) => plans.filter(p => p.action === a).length;
  console.log(`\nSummary: ${plans.length} groups | add ${count('add')} | already-owned ${count('already-owned')} | review ${count('review')} | unreadable ${count('skip-unreadable')}`);
}

async function undo(file: string) {
  const client = new DiscogsClient();
  const me = await client.identity();
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  for (const r of rows) {
    await client.removeInstance(me.username, r.folderId, r.releaseId, r.instanceId);
    console.log(`removed ${r.releaseId} (instance ${r.instanceId})`);
  }
}

async function main() {
  const undoFile = arg('--undo');
  if (undoFile) return undo(undoFile);
  const undoRenameFile = arg('--undo-renames');
  if (undoRenameFile) {
    const r = await undoRenames(undoRenameFile);
    console.log(`restored ${r.restored} file names${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`);
    return;
  }

  const dir = process.argv.slice(2).find(a => !a.startsWith('--') && a !== arg('--limit') && a !== arg('--folder-id') && a !== arg('--undo-renames'));
  if (!dir) { console.error('usage: discogs:ingest <dir> [--apply] [--limit N] [--folder-id 1] [--notes]'); process.exit(1); }
  const apply = process.argv.includes('--apply');
  const withNotes = process.argv.includes('--notes');
  const withRename = process.argv.includes('--rename');
  const limit = Number(arg('--limit') ?? Infinity);
  const folderId = Number(arg('--folder-id') ?? 1);
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(RUNS, { recursive: true });

  const client = new DiscogsClient();
  if (!client.configured) throw new Error('DISCOGS_TOKEN missing');
  const me = await client.identity();
  const owned = await client.collectionReleaseIds(me.username);

  const files = await scanFolder(dir, { indexPath: DEFAULT_INDEX_PATH });
  const groups = groupRecords(files).slice(0, limit);
  console.log(`${files.length} files, ${files.filter(f => f.duplicateOf).length} duplicates, ${groups.length} groups. Collection: ${owned.size} releases.`);

  const plans: GroupPlan[] = [];
  const claimed = new Set<number>();
  for (const g of groups) {
    try { plans.push(await planGroup(client, g, owned, claimed)); }
    catch (e) { plans.push({ group: g, reads: [], candidates: [], best: null, action: 'review', reason: `error: ${e instanceof Error ? e.message : e}` }); }
  }
  printPlan(plans);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cost = ledger.summary();
  appendCostLog(COST_LOG, { runId: stamp, folder: dir, ...cost });
  console.log(`\nCost: $${cost.usd.toFixed(4)} | ${cost.billedCalls} billed vision calls, ${cost.cachedCalls} cached (free) | ${cost.inputTokens} in / ${cost.outputTokens} out tokens${cost.unknownModelCalls ? ` | ${cost.unknownModelCalls} calls on an unpriced model` : ''}`);
  const planFile = join(RUNS, `${stamp}-plan.json`);
  writeFileSync(planFile, JSON.stringify(plans, null, 2));
  console.log(`\nPlan saved: ${planFile}`);
  // Confident = exact catalog number on a release we add or already own.
  const confident = plans.filter(p => p.best && p.best.reasons.includes('catno exact') && (p.action === 'add' || p.action === 'already-owned'));
  const renamePairs = withRename ? confident.flatMap(p => plannedNames(p.group, p.best!)) : [];
  if (withRename) console.log(`\nRenames planned: ${renamePairs.length} files in ${confident.length} records`);
  if (!apply) {
    for (const r of renamePairs) console.log(`  ${basename(r.from)} -> ${basename(r.to)}`);
    console.log('Dry run. Nothing written to Discogs or the folder. Re-run with --apply.');
    return;
  }

  const log = join(RUNS, `${stamp}-applied.jsonl`);
  for (const p of plans.filter(p => p.action === 'add' && p.best)) {
    const releaseId = p.best!.releaseId;
    const added = await client.addToCollection(me.username, folderId, releaseId);
    appendFileSync(log, JSON.stringify({ releaseId, folderId, instanceId: added.instance_id, group: p.group.id }) + '\n');
    if (withNotes) await client.setInstanceField(me.username, folderId, releaseId, added.instance_id, NOTES_FIELD_ID, notesFor(p.group));
    console.log(`added ${releaseId} ${p.best!.title} (instance ${added.instance_id})`);
  }
  console.log(`Applied. Undo with: npm run discogs:ingest -- --undo ${log}`);

  const renamed = new Map<string, string>();
  if (withRename && renamePairs.length) {
    const journal = join(RUNS, `${stamp}-renames.jsonl`);
    const r = await applyRenames(renamePairs, journal);
    for (const line of readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean)) {
      const { from, to } = JSON.parse(line); renamed.set(from, to);
    }
    console.log(`Renamed ${r.renamed} files${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}. Undo with: npm run discogs:ingest -- --undo-renames ${journal}`);
  }

  // Refresh notes on every confident record (new or already owned), but only
  // overwrite notes this tool wrote — never a note the owner typed.
  if (withNotes) {
    let updated = 0;
    for (const p of confident) {
      for (const inst of await client.instances(me.username, p.best!.releaseId)) {
        const current = (inst as any).notes?.find((n: any) => n.field_id === NOTES_FIELD_ID)?.value ?? '';
        if (current && !current.startsWith('HITLOOP ingest')) continue;
        const next = notesFor(p.group, renamed);
        if (current === next) continue;
        try {
          await client.setInstanceField(me.username, inst.folder_id, p.best!.releaseId, inst.instance_id, NOTES_FIELD_ID, next);
          updated++;
        } catch (e) {
          console.warn(`notes not updated for ${p.best!.releaseId}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    console.log(`Notes refreshed on ${updated} collection entries.`);
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
