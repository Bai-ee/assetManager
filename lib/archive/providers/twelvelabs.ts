import * as path from 'path';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';

export interface VideoObservation {
  provider:'twelvelabs'; providerAssetId:string; sourceAssetId:string;
  status:'SUBMITTED'|'INDEXING'|'READY'|'FAILED'; raw?:unknown;
}
export const VIDEO_EXTENSIONS=new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);
export function isTwelveLabsVideo(filePath:string){return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());}

export interface AnalyzeResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  finishReason?: string;
  raw: unknown;
}

// A live run on hpit03_finals hit HTTP 413 uploading a 144 MB MP4 direct
// (TwelveLabs' docs claim a 200 MB direct-upload limit; the real one is
// lower). Anything over this threshold goes through the chunked multipart
// session instead, which streams from disk and never buffers the whole file.
export const DEFAULT_MULTIPART_THRESHOLD_BYTES=50*1024*1024;
const MAX_PARALLEL_CHUNK_UPLOADS=3;
const MAX_CHUNK_ATTEMPTS=3;
const MAX_PRESIGNED_URLS_PER_REQUEST=50;
const REPORT_BATCH_SIZE=10;
const MULTIPART_STATUS_POLL_ATTEMPTS=10;
const MULTIPART_STATUS_POLL_DELAY_MS=500;

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

interface MultipartUploadUrl { chunk_index:number; url:string; expires_at:string; }
interface MultipartSession {
  upload_id:string; asset_id:string; chunk_size:number; total_chunks:number;
  upload_urls:MultipartUploadUrl[]; upload_headers?:Record<string,string>; expires_at:string;
}

export class TwelveLabsAdapter {
  // TWELVELABS_INDEX_ID is optional: it is only needed for indexAsset (Marengo
  // search indexing), not for analyzeAsset (Pegasus), which is the live
  // evidence path for Jev and only requires the asset to be "ready".
  constructor(
    private apiKey=process.env.TWELVELABS_API_KEY,
    private indexId=process.env.TWELVELABS_INDEX_ID,
    private baseUrl=process.env.TWELVELABS_API_URL||'https://api.twelvelabs.io/v1.3',
    private multipartThresholdBytes=DEFAULT_MULTIPART_THRESHOLD_BYTES,
    private fetchImpl:typeof fetch=fetch,
  ){}
  get configured(){return Boolean(this.apiKey);}
  private headers(){return {'x-api-key':this.apiKey!};}

  // `new URL('/assets', 'https://api.twelvelabs.io/v1.3')` resolves against the
  // origin per WHATWG URL rules and silently drops the `/v1.3` version prefix
  // from every request — every call site below was hitting the wrong path
  // until this was joined correctly.
  private apiUrl(relativePath:string):string{
    const base=this.baseUrl.endsWith('/')?this.baseUrl:`${this.baseUrl}/`;
    const rel=relativePath.startsWith('/')?relativePath.slice(1):relativePath;
    return new URL(rel,base).toString();
  }

  async submitVideo(sourceAssetId:string,filePath:string):Promise<VideoObservation>{
    if(!this.configured) throw new Error('TwelveLabs is not configured');
    if(!isTwelveLabsVideo(filePath)) throw new Error('Unsupported TwelveLabs video type');
    const info=await stat(filePath);
    if(info.size>this.multipartThresholdBytes) return this.submitVideoMultipart(sourceAssetId,filePath,info.size);
    return this.submitVideoDirect(sourceAssetId,filePath);
  }

  private async submitVideoDirect(sourceAssetId:string,filePath:string):Promise<VideoObservation>{
    // Node's native FormData cannot stream fs.ReadStream portably, so this
    // buffered path is only ever reached under the multipart threshold above.
    const bytes=await import('fs/promises').then(fs=>fs.readFile(filePath));
    const form=new FormData(); form.set('method','direct'); form.set('file',new Blob([bytes]),path.basename(filePath));
    const upload=await this.fetchImpl(this.apiUrl('assets'),{method:'POST',headers:this.headers(),body:form,signal:AbortSignal.timeout(120_000)});
    if(!upload.ok) throw new Error(`TwelveLabs asset upload failed: ${upload.status}`);
    const asset=await upload.json() as {id?:string;_id?:string};
    const assetId=asset.id||asset._id;
    if(!assetId) throw new Error('TwelveLabs asset response missing id');
    return {provider:'twelvelabs',providerAssetId:assetId,sourceAssetId,status:'SUBMITTED',raw:asset};
  }

  /**
   * Chunked upload session (v1.3 `/assets/multipart-uploads`): create ->
   * stream each chunk to its presigned URL (bounded concurrency, retried on
   * network error/5xx, refreshed on an expired/invalid URL) -> report ETags
   * in batches -> poll session status to completed. The file is never read
   * into memory as a whole; each chunk is a fresh `fs.createReadStream`
   * range piped as the PUT body.
   */
  private async submitVideoMultipart(sourceAssetId:string,filePath:string,totalSize:number):Promise<VideoObservation>{
    const session=await this.createMultipartSession(filePath,totalSize);
    const urlCache=new Map<number,MultipartUploadUrl>();
    for(const u of session.upload_urls) urlCache.set(u.chunk_index,u);

    const chunkIndexes=Array.from({length:session.total_chunks},(_,i)=>i+1); // chunk_index is 1-indexed
    const proofs=new Map<number,{proof:string;chunkSize:number}>();

    await this.runWithConcurrency(chunkIndexes,MAX_PARALLEL_CHUNK_UPLOADS,async chunkIndex=>{
      const range=this.chunkByteRange(chunkIndex,session.chunk_size,totalSize);
      const etag=await this.uploadChunkWithRetry(filePath,session.upload_id,chunkIndex,range,session.upload_headers,urlCache);
      proofs.set(chunkIndex,{proof:etag,chunkSize:range.end-range.start+1});
    });

    await this.reportCompletedChunks(session.upload_id,proofs,session.total_chunks);
    await this.waitForMultipartCompletion(session.upload_id);

    return {provider:'twelvelabs',providerAssetId:session.asset_id,sourceAssetId,status:'SUBMITTED',raw:session};
  }

  private chunkByteRange(chunkIndex:number,chunkSize:number,totalSize:number):{start:number;end:number}{
    const start=(chunkIndex-1)*chunkSize;
    const end=Math.min(start+chunkSize,totalSize)-1;
    return {start,end};
  }

  private async createMultipartSession(filePath:string,totalSize:number):Promise<MultipartSession>{
    const r=await this.fetchImpl(this.apiUrl('assets/multipart-uploads'),{
      method:'POST',
      headers:{...this.headers(),'content-type':'application/json'},
      body:JSON.stringify({filename:path.basename(filePath),type:'video',total_size:totalSize,enable_hls:false,enable_thumbnail:false}),
      signal:AbortSignal.timeout(30_000),
    });
    if(!r.ok) throw new Error(`TwelveLabs multipart session create failed: ${r.status} ${await r.text()}`);
    return r.json() as Promise<MultipartSession>;
  }

  private async requestPresignedUrls(uploadId:string,start:number,count:number):Promise<MultipartUploadUrl[]>{
    const r=await this.fetchImpl(this.apiUrl(`assets/multipart-uploads/${uploadId}/presigned-urls`),{
      method:'POST',
      headers:{...this.headers(),'content-type':'application/json'},
      body:JSON.stringify({start,count:Math.min(count,MAX_PRESIGNED_URLS_PER_REQUEST)}),
      signal:AbortSignal.timeout(30_000),
    });
    if(!r.ok) throw new Error(`TwelveLabs presigned URL request failed: ${r.status} ${await r.text()}`);
    const body=await r.json() as {upload_urls?:MultipartUploadUrl[]};
    return body.upload_urls||[];
  }

  private async uploadChunkWithRetry(
    filePath:string,uploadId:string,chunkIndex:number,range:{start:number;end:number},
    uploadHeaders:Record<string,string>|undefined,urlCache:Map<number,MultipartUploadUrl>,
  ):Promise<string>{
    let entry=urlCache.get(chunkIndex);
    if(!entry){
      const [fresh]=await this.requestPresignedUrls(uploadId,chunkIndex,1);
      if(!fresh) throw new Error(`TwelveLabs did not return a presigned URL for chunk ${chunkIndex}`);
      urlCache.set(chunkIndex,fresh); entry=fresh;
    }

    for(let attempt=1;attempt<=MAX_CHUNK_ATTEMPTS;attempt++){
      let response:Response;
      try{
        // A fresh stream per attempt: a retried PUT must re-read the same
        // byte range, and a consumed stream cannot be replayed.
        const chunkStream=createReadStream(filePath,{start:range.start,end:range.end});
        const body=Readable.toWeb(chunkStream) as unknown as ReadableStream;
        // S3-style presigned PUTs reject chunked transfer encoding (HTTP 501).
        // An explicit Content-Length makes Node's fetch send the stream as a
        // fixed-length body instead.
        const contentLength=String(range.end-range.start+1);
        response=await this.fetchImpl(entry.url,{
          method:'PUT',headers:{...(uploadHeaders||{}),'content-length':contentLength},body,duplex:'half',signal:AbortSignal.timeout(600_000),
        } as RequestInit & {duplex:'half'});
      }catch(error){
        if(attempt===MAX_CHUNK_ATTEMPTS) throw error instanceof Error?error:new Error(String(error));
        continue;
      }

      if(response.ok){
        const etag=response.headers.get('etag');
        if(!etag) throw new Error(`TwelveLabs chunk ${chunkIndex} upload response missing ETag`);
        return etag;
      }
      if(response.status===403||response.status===404){
        // Presigned URL expired or was never valid for this chunk; get a
        // fresh one before the next attempt.
        const [fresh]=await this.requestPresignedUrls(uploadId,chunkIndex,1);
        if(fresh){ urlCache.set(chunkIndex,fresh); entry=fresh; }
        if(attempt===MAX_CHUNK_ATTEMPTS) throw new Error(`TwelveLabs chunk ${chunkIndex} upload failed: ${response.status} (URL refresh exhausted)`);
        continue;
      }
      if(response.status>=500){
        if(attempt===MAX_CHUNK_ATTEMPTS) throw new Error(`TwelveLabs chunk ${chunkIndex} upload failed: ${response.status}`);
        continue;
      }
      // Non-retryable client error.
      throw new Error(`TwelveLabs chunk ${chunkIndex} upload failed: ${response.status}`);
    }
    throw new Error(`TwelveLabs chunk ${chunkIndex} upload failed after ${MAX_CHUNK_ATTEMPTS} attempts`);
  }

  private async reportCompletedChunks(uploadId:string,proofs:Map<number,{proof:string;chunkSize:number}>,totalChunks:number):Promise<void>{
    const entries=Array.from(proofs.entries());
    let totalCompleted=0;
    for(let i=0;i<entries.length;i+=REPORT_BATCH_SIZE){
      const batch=entries.slice(i,i+REPORT_BATCH_SIZE).map(([chunkIndex,{proof,chunkSize}])=>(
        {chunk_index:chunkIndex,proof,proof_type:'etag',chunk_size:chunkSize}
      ));
      const r=await this.fetchImpl(this.apiUrl(`assets/multipart-uploads/${uploadId}`),{
        method:'POST',
        headers:{...this.headers(),'content-type':'application/json'},
        body:JSON.stringify({completed_chunks:batch}),
        signal:AbortSignal.timeout(30_000),
      });
      if(!r.ok) throw new Error(`TwelveLabs multipart report failed: ${r.status} ${await r.text()}`);
      const body=await r.json() as {total_completed?:number};
      totalCompleted=body.total_completed??totalCompleted;
    }
    if(totalCompleted<totalChunks) throw new Error(`TwelveLabs multipart report incomplete: ${totalCompleted}/${totalChunks} chunks acknowledged`);
  }

  private async waitForMultipartCompletion(uploadId:string):Promise<void>{
    for(let attempt=1;attempt<=MULTIPART_STATUS_POLL_ATTEMPTS;attempt++){
      const r=await this.fetchImpl(this.apiUrl(`assets/multipart-uploads/${uploadId}`),{headers:this.headers(),signal:AbortSignal.timeout(30_000)});
      if(!r.ok) throw new Error(`TwelveLabs multipart status check failed: ${r.status}`);
      const body=await r.json() as {status?:string};
      if(body.status==='completed') return;
      if(body.status==='failed'||body.status==='expired') throw new Error(`TwelveLabs multipart upload ${body.status}`);
      if(attempt===MULTIPART_STATUS_POLL_ATTEMPTS) throw new Error('TwelveLabs multipart upload did not complete in time');
      await sleep(MULTIPART_STATUS_POLL_DELAY_MS);
    }
  }

  /** Bounded-concurrency map over `items`. Lets every item finish before
   * throwing (the first collected error) rather than aborting siblings
   * mid-flight, which keeps a partial multipart session in a known state. */
  private async runWithConcurrency<T>(items:T[],limit:number,fn:(item:T)=>Promise<void>):Promise<void>{
    let index=0;
    const errors:unknown[]=[];
    const worker=async()=>{
      while(index<items.length){
        const current=items[index++];
        try{ await fn(current); } catch(error){ errors.push(error); }
      }
    };
    await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
    if(errors.length) throw errors[0];
  }

  async getAsset(assetId:string):Promise<any>{
    const r=await this.fetchImpl(this.apiUrl(`assets/${assetId}`),{headers:this.headers(),signal:AbortSignal.timeout(30_000)});
    if(!r.ok) throw new Error(`TwelveLabs asset status failed: ${r.status}`); return r.json();
  }

  /** Optional: only for Marengo search (indexed-assets); not required for
   * analysis. Jev evidence comes from analyzeAsset below, which needs no index. */
  async indexAsset(assetId:string):Promise<any>{
    if(!this.indexId) throw new Error('TwelveLabs index is not configured');
    const r=await this.fetchImpl(this.apiUrl(`indexes/${this.indexId}/indexed-assets`),{
      method:'POST',headers:{...this.headers(),'content-type':'application/json'},body:JSON.stringify({asset_id:assetId}),signal:AbortSignal.timeout(30_000)
    });
    if(!r.ok) throw new Error(`TwelveLabs indexing failed: ${r.status}`); return r.json();
  }

  /** Pegasus text generation directly on an uploaded asset. Precondition is
   * only "the asset status must be ready" — no index, no indexed-asset. This
   * is the live evidence path for Jev. */
  async analyzeAsset(assetId:string,prompt:string,options?:{model?:string;maxTokens?:number;temperature?:number}):Promise<AnalyzeResult>{
    if(!this.configured) throw new Error('TwelveLabs is not configured');
    const r=await this.fetchImpl(this.apiUrl('analyze'),{
      method:'POST',
      headers:{...this.headers(),'content-type':'application/json'},
      body:JSON.stringify({
        video:{type:'asset_id',asset_id:assetId},
        prompt,
        model_name:options?.model||'pegasus1.5',
        temperature:options?.temperature??0,
        stream:false,
        max_tokens:options?.maxTokens??4096,
      }),
      signal:AbortSignal.timeout(120_000),
    });
    if(!r.ok) throw new Error(`TwelveLabs analyze failed: ${r.status} ${await r.text()}`);
    const body=await r.json() as {id?:string;data?:string;finish_reason?:string;usage?:{input_tokens?:number;output_tokens?:number};error?:{message?:string}};
    if(body.error) throw new Error(`TwelveLabs analyze error: ${body.error.message||'unknown error'}`);
    if(typeof body.data!=='string') throw new Error('TwelveLabs analyze response missing data');
    return {text:body.data,usage:body.usage,finishReason:body.finish_reason,raw:body};
  }
}
