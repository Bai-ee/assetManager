import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { Readable } from 'stream';
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
