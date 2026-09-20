import * as path from 'path';
import { ArchiveWorker } from './worker';

async function main() {
  const root = process.argv[2];
  const label = process.argv[3] || (root ? path.basename(path.resolve(root)) : 'Bryan NAS');
  if (!root) {
    console.error('Usage: npm run archive:source -- <nas-mount-path> [label]');
    process.exit(1);
  }
  const worker = new ArchiveWorker();
  const source = await worker.registerSource(label, root);
  console.log('Registered archive source:');
  console.log(JSON.stringify({ id: source.id, label: source.label, state: source.state }, null, 2));
  console.log('\nStart the always-on worker with: npm run archive:worker');
}

main().catch(error => { console.error(error); process.exit(1); });
