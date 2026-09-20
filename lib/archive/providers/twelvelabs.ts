import * as path from 'path';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

export interface VideoObservation {
  provider:'twelvelabs'; providerAssetId:string; sourceAssetId:string;
  status:'SUBMITTED'|'INDEXING'|'READY'|'FAILED'; raw?:unknown;
}
const VIDEO_EXTENSIONS=new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);
export function isTwelveLabsVideo(filePath:string){return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());}

export class TwelveLabsAdapter {
  constructor(private apiKey=process.env.TWELVELABS_API_KEY,private indexId=process.env.TWELVELABS_INDEX_ID,private baseUrl=process.env.TWELVELABS_API_URL||'https://api.twelvelabs.io/v1.3'){}
  get configured(){return Boolean(this.apiKey&&this.indexId);}
  private headers(){return {'x-api-key':this.apiKey!};}

  async submitVideo(sourceAssetId:string,filePath:string):Promise<VideoObservation>{
    if(!this.configured) throw new Error('TwelveLabs is not configured');
    if(!isTwelveLabsVideo(filePath)) throw new Error('Unsupported TwelveLabs video type');
    const info=await stat(filePath);
    if(info.size>200*1024*1024) throw new Error('TwelveLabs direct upload limit is 200 MB; staged URL upload required');

    // Current API is asset-first: upload -> wait for asset ready -> add asset to index.
    // Node's native FormData cannot stream fs.ReadStream portably, so this boundary
    // deliberately rejects large files and uses a buffered direct upload for POC-sized media.
    const bytes=await import('fs/promises').then(fs=>fs.readFile(filePath));
    const form=new FormData(); form.set('method','direct'); form.set('file',new Blob([bytes]),path.basename(filePath));
    const upload=await fetch(new URL('/assets',this.baseUrl),{method:'POST',headers:this.headers(),body:form,signal:AbortSignal.timeout(120_000)});
    if(!upload.ok) throw new Error(`TwelveLabs asset upload failed: ${upload.status}`);
    const asset=await upload.json() as {id?:string;_id?:string};
    const assetId=asset.id||asset._id;
    if(!assetId) throw new Error('TwelveLabs asset response missing id');
    return {provider:'twelvelabs',providerAssetId:assetId,sourceAssetId,status:'SUBMITTED',raw:asset};
  }

  async getAsset(assetId:string):Promise<any>{
    const r=await fetch(new URL(`/assets/${assetId}`,this.baseUrl),{headers:this.headers(),signal:AbortSignal.timeout(30_000)});
    if(!r.ok) throw new Error(`TwelveLabs asset status failed: ${r.status}`); return r.json();
  }

  async indexAsset(assetId:string):Promise<any>{
    if(!this.indexId) throw new Error('TwelveLabs index is not configured');
    const r=await fetch(new URL(`/indexes/${this.indexId}/indexed-assets`,this.baseUrl),{
      method:'POST',headers:{...this.headers(),'content-type':'application/json'},body:JSON.stringify({asset_id:assetId}),signal:AbortSignal.timeout(30_000)
    });
    if(!r.ok) throw new Error(`TwelveLabs indexing failed: ${r.status}`); return r.json();
  }
}
