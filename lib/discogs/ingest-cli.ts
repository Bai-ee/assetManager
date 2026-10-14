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
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DiscogsClient } from './client';
import { DEFAULT_INDEX_PATH } from './media';
import { mergeReads } from './matcher';
import type { GroupPlan } from './types';
import { plannedNames, applyRenames, undoRenames } from './rename';
import { planFolder, applyPlan, undoApply, notesFor, NOTES_FIELD_ID } from './run';

const HOME = join(homedir(), '.discogs-ingest');
const CACHE = join(HOME, 'cache');
const RUNS = join(HOME, 'runs');
const COST_LOG = join(HOME, 'costs.jsonl');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
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
  const abs = resolve(file);
  const r = await undoApply({ journal: basename(abs) }, {
    client: new DiscogsClient(), runsDir: dirname(abs),
    onRemoved: x => console.log(`removed ${x.releaseId} (instance ${x.instanceId})`),
  });
  if (r.errors.length) {
    for (const e of r.errors) console.error(`could not remove ${e.releaseId}: ${e.error}`);
    throw new Error(`${r.errors.length} instances not removed`);
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

  const deps = { client, cacheDir: CACHE, runsDir: RUNS, indexPath: DEFAULT_INDEX_PATH, costLogPath: COST_LOG };
  const run = await planFolder({ dir, limit }, {
    ...deps,
    onScanned: i => console.log(`${i.files} files, ${i.duplicates} duplicates, ${i.groups} groups. Collection: ${i.collection} releases.`),
  });
  const plans = run.plans;
  const stamp = run.planId;
  printPlan(plans);

  const cost = run.cost;
  console.log(`\nCost: $${cost.usd.toFixed(4)} | ${cost.billedCalls} billed vision calls, ${cost.cachedCalls} cached (free) | ${cost.inputTokens} in / ${cost.outputTokens} out tokens${cost.unknownModelCalls ? ` | ${cost.unknownModelCalls} calls on an unpriced model` : ''}`);
  console.log(`\nPlan saved: ${join(RUNS, `${stamp}-plan.json`)}`);
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
  const toAdd = plans.filter(p => p.action === 'add' && p.best);
  const titles = new Map(toAdd.map(p => [p.group.id, p.best!.title]));
  const applied = await applyPlan(
    { planId: stamp, items: toAdd.map(p => ({ groupId: p.group.id, releaseId: p.best!.releaseId })), notes: withNotes, folderId },
    { ...deps, plans, journalName: `${stamp}-applied.jsonl`, onAdded: a => console.log(`added ${a.releaseId} ${titles.get(a.groupId)} (instance ${a.instanceId})`) },
  );
  for (const e of applied.errors) console.error(`add failed for ${e.releaseId}: ${e.error}`);
  if (applied.errors.length) throw new Error(`${applied.errors.length} adds failed; undo what was added with: npm run discogs:ingest -- --undo ${log}`);
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
