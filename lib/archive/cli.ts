import * as path from 'path';
import { ArchiveWorker } from './worker';

async function main() {
  const root = process.argv[2];
  const selected = process.argv[3] || '.';
  if (!root) {
    console.error('Usage: npm run archive:scan -- <source-root> [relative-folder]');
    process.exit(1);
  }
  const worker = new ArchiveWorker();
  const source = await worker.registerSource(path.basename(root), root);
  const job = worker.createJob(source.id, selected);
  console.log('Archive job', job.id, 'started:', selected);
  const done = await worker.run(job.id);
  console.log(JSON.stringify(done, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
