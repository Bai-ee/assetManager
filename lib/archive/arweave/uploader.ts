import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';
import { ArweaveSigner, TurboFactory } from '@ardrive/turbo-sdk';

function wallet(){
  const raw=process.env.ARWEAVE_WALLET_JWK;
  if(!raw) throw new Error('ARWEAVE_WALLET_JWK is not configured on archive worker');
  return JSON.parse(raw);
}

export type ArweaveUploadTag={name:string;value:string};

/**
 * The slice of the Turbo SDK's authenticated client this uploader depends on.
 * Deliberately minimal and structural (not the SDK's own client type) so a
 * test can inject a fake without constructing a real signer/wallet.
 */
export interface TurboUploadClient {
  uploadFile(params:{
    fileStreamFactory:()=>Readable;
    fileSizeFactory:()=>number;
    dataItemOpts?:{tags?:ArweaveUploadTag[]};
    signal?:AbortSignal;
  }):Promise<{id:string}>;
}

/** Builds the real, authenticated Turbo client. Isolated so tests never touch a wallet. */
export function createTurboClient():TurboUploadClient{
  return TurboFactory.authenticated({signer:new ArweaveSigner(wallet())}) as unknown as TurboUploadClient;
}

export async function uploadOriginalToArweave(input:{
  filePath:string;
  archiveName:string;
  contentType?:string;
  sha256:string;
  collectionId:string;
  signal?:AbortSignal;
  turboClient?:TurboUploadClient;
}){
  const info=await stat(input.filePath);
  if(!info.isFile()) throw new Error('Arweave source is not a file');
  const turbo=input.turboClient??createTurboClient();
  const tags:ArweaveUploadTag[]=[
    {name:'Content-Type',value:input.contentType||'application/octet-stream'},
    {name:'File-Name',value:input.archiveName},
    {name:'File-Size',value:String(info.size)},
    {name:'App-Name',value:'HITLOOP-Archive'},
    {name:'Archive-Schema',value:'1.0'},
    {name:'SHA-256',value:input.sha256},
    {name:'Collection-ID',value:input.collectionId},
  ];
  let result:{id:string};
  try{
    // fileStreamFactory must return a FRESH stream on every call: the SDK's
    // node signer opens it twice (once to size/sign, once to hash and send),
    // so a single shared/consumed stream would silently truncate the upload.
    // Size comes from the stat() above, not from reading the file, so the
    // original bytes are never buffered into process memory.
    result=await turbo.uploadFile({
      fileStreamFactory:()=>createReadStream(input.filePath),
      fileSizeFactory:()=>info.size,
      dataItemOpts:{tags},
      signal:input.signal,
    });
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    throw new Error(`Arweave streaming upload failed for ${input.archiveName} (sha256 ${input.sha256}): ${message}`,{cause:error});
  }
  if(!result?.id) throw new Error('Turbo upload returned no transaction id');
  return {transactionId:result.id,arweaveUrl:`https://arweave.net/${result.id}`,sizeBytes:info.size,tags};
}

/** 2 MB ceiling for lib/archive/daemon.ts UPLOAD_JSON commands (archive
 * records, collection manifests, the static viewer). These are small
 * JSON/HTML documents the worker uploads on HITLOOP's behalf because the
 * Arweave wallet lives only here — never a source-file byte stream, so a
 * caller that hands this function a large payload by mistake gets a clear
 * error instead of a silent multi-MB data-item. */
export const MAX_DOCUMENT_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Uploads a small in-memory document (JSON or HTML text, already rendered to
 * bytes by the caller) to Arweave via the same Turbo client/result contract
 * as uploadOriginalToArweave. Buffered, not streamed from disk: these
 * documents are KBs, well under MAX_DOCUMENT_UPLOAD_BYTES, so there is no
 * memory-scaling concern like the original-file streamer guards against.
 */
export async function uploadDocumentToArweave(input:{
  bytes:Buffer;
  fileName:string;
  contentType:string;
  tags:ArweaveUploadTag[];
  signal?:AbortSignal;
  turboClient?:TurboUploadClient;
}){
  if(input.bytes.length>MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error(`Document ${input.fileName} is ${input.bytes.length} bytes, exceeding the ${MAX_DOCUMENT_UPLOAD_BYTES}-byte UPLOAD_JSON ceiling`);
  }
  const turbo=input.turboClient??createTurboClient();
  const hasContentType=input.tags.some(t=>t.name==='Content-Type');
  const tags:ArweaveUploadTag[]=hasContentType?input.tags:[...input.tags,{name:'Content-Type',value:input.contentType}];
  let result:{id:string};
  try{
    // fileStreamFactory still returns a fresh Readable per call (same
    // double-read contract as the original-file streamer above), even though
    // the underlying bytes are already in memory.
    result=await turbo.uploadFile({
      fileStreamFactory:()=>Readable.from(input.bytes),
      fileSizeFactory:()=>input.bytes.length,
      dataItemOpts:{tags},
      signal:input.signal,
    });
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    throw new Error(`Arweave document upload failed for ${input.fileName}: ${message}`,{cause:error});
  }
  if(!result?.id) throw new Error('Turbo upload returned no transaction id');
  return {transactionId:result.id,arweaveUrl:`https://arweave.net/${result.id}`,sizeBytes:input.bytes.length,tags};
}
