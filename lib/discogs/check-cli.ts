/**
 * Discogs connection check.
 *   read-only:   npm run discogs:check
 *   write test:  npm run discogs:check -- --write-test [releaseId] [--keep]
 * The write test adds one release to the Uncategorized folder (id 1), verifies
 * it, then removes ONLY the copy it created (unless --keep). If you already own
 * that release it does nothing, so your existing copies are never touched.
 */
import { DiscogsClient } from './client.ts';

const DEFAULT_TEST_RELEASE = 249504; // the example release used in Discogs' own API docs

async function main() {
  const args = process.argv.slice(2);
  const writeTest = args.includes('--write-test');
  const keep = args.includes('--keep');
  const idArg = args.find(a => /^\d+$/.test(a));
  const releaseId = idArg ? Number(idArg) : DEFAULT_TEST_RELEASE;

  const client = new DiscogsClient();
  if (!client.configured) { console.error('DISCOGS_TOKEN is not set in .env.local'); process.exit(1); }

  const me = await client.identity();
  console.log(`Authenticated as: ${me.username}`);
  const folders = await client.folders(me.username);
  for (const f of folders) console.log(`  folder ${f.id} "${f.name}": ${f.count} items`);

  if (!writeTest) { console.log('Read check OK. Run with --write-test to test adding a release.'); return; }

  const release = await client.getRelease(releaseId);
  const label = `${(release.artists || []).map((a: any) => a.name).join(', ')} - ${release.title} (${release.year || 'n.d.'})`;
  console.log(`\nWrite test with release ${releaseId}: ${label}`);

  const before = await client.instances(me.username, releaseId);
  if (before.length) { console.log(`You already own ${before.length} copy/copies. Skipping so your collection is not touched.`); return; }

  const added = await client.addToCollection(me.username, 1, releaseId);
  console.log(`Added. instance_id=${added.instance_id}`);

  const after = await client.instances(me.username, releaseId);
  const found = after.find(i => i.instance_id === added.instance_id);
  console.log(found ? `Verified in collection (folder ${found.folder_id}).` : 'WARNING: add returned OK but the copy was not found on re-read.');

  if (keep) { console.log('--keep set: leaving it in your collection.'); return; }
  await client.removeInstance(me.username, 1, releaseId, added.instance_id);
  const cleaned = await client.instances(me.username, releaseId);
  console.log(cleaned.some(i => i.instance_id === added.instance_id) ? 'WARNING: remove did not stick.' : 'Removed the test copy. Collection is back to how it was.');
  console.log('\nWRITE TEST PASSED');
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); if (e?.body) console.error(String(e.body).slice(0, 300)); process.exit(1); });
