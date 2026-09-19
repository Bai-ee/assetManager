import * as fs from 'fs';
import * as path from 'path';
import type { ArchiveSource, CollectionJobRecord, ContentAssetRecord, FileLocationRecord } from './types';

export interface ArchiveManifest {
  version: 1;
  sources: Record<string, ArchiveSource>;
  jobs: Record<string, CollectionJobRecord>;
  locations: Record<string, FileLocationRecord>;
  assets: Record<string, ContentAssetRecord>;
  assetByHash: Record<string, string>;
}

const DIR = path.join(process.cwd(), '.moleboard');
const FILE = path.join(DIR, 'archive-manifest.json');

function empty(): ArchiveManifest {
  return { version: 1, sources: {}, jobs: {}, locations: {}, assets: {}, assetByHash: {} };
}

export class ManifestStore {
  private data: ArchiveManifest;
  constructor(private filePath = FILE) {
    this.data = this.load();
  }

  private load(): ArchiveManifest {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ArchiveManifest;
    } catch {
      return empty();
    }
  }

  snapshot(): ArchiveManifest {
    return structuredClone(this.data);
  }

  mutate(fn: (manifest: ArchiveManifest) => void): void {
    fn(this.data);
    this.flush();
  }

  flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = this.filePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2));
    fs.renameSync(temp, this.filePath);
  }
}
