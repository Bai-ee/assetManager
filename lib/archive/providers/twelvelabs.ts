import * as path from 'path';

export interface VideoObservation {
  provider: 'twelvelabs';
  providerAssetId: string;
  sourceAssetId: string;
  status: 'SUBMITTED' | 'INDEXING' | 'READY' | 'FAILED';
  summary?: string;
  raw?: unknown;
}

const VIDEO_EXTENSIONS = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);

export function isTwelveLabsVideo(filePath:string):boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export class TwelveLabsAdapter {
  constructor(
    private apiKey=process.env.TWELVELABS_API_KEY,
    private indexId=process.env.TWELVELABS_INDEX_ID,
    private baseUrl=process.env.TWELVELABS_API_URL || 'https://api.twelvelabs.io/v1.3',
  ) {}

  get configured(){ return Boolean(this.apiKey && this.indexId); }

  /**
   * Provider boundary only. We intentionally do not call this during hashing.
   * The archive must first dedupe bytes so identical videos are submitted once.
   */
  async submitVideo(sourceAssetId:string,filePath:string):Promise<VideoObservation> {
    if(!this.configured) throw new Error('TwelveLabs is not configured');
    if(!isTwelveLabsVideo(filePath)) throw new Error('Unsupported TwelveLabs video type');

    const form=new FormData();
    form.set('index_id',this.indexId!);
    const bytes=await import('fs/promises').then(fs=>fs.readFile(filePath));
    form.set('video_file',new Blob([bytes]),path.basename(filePath));

    const response=await fetch(new URL('/tasks',this.baseUrl),{
      method:'POST',headers:{'x-api-key':this.apiKey!},body:form,signal:AbortSignal.timeout(120_000),
    });
    if(!response.ok) throw new Error(`TwelveLabs submit failed: ${response.status}`);
    const body=await response.json() as {id?:string};
    if(!body.id) throw new Error('TwelveLabs response missing task id');
    return {provider:'twelvelabs',providerAssetId:body.id,sourceAssetId,status:'SUBMITTED',raw:body};
  }
}
