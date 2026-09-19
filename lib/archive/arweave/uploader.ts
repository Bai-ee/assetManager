import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { ArweaveSigner, TurboFactory } from '@ardrive/turbo-sdk';

function wallet(){
  const raw=process.env.ARWEAVE_WALLET_JWK;
  if(!raw) throw new Error('ARWEAVE_WALLET_JWK is not configured on archive worker');
  return JSON.parse(raw);
}

export async function uploadOriginalToArweave(input:{filePath:string;archiveName:string;contentType?:string;sha256:string;collectionId:string}){
  const info=await stat(input.filePath);
  if(!info.isFile()) throw new Error('Arweave source is not a file');
  const turbo=TurboFactory.authenticated({signer:new ArweaveSigner(wallet()),config:{gatewayUrl:'https://turbo.ardrive.io',uploadUrl:'https://turbo.ardrive.io'}});
  const tags=[
    {name:'Content-Type',value:input.contentType||'application/octet-stream'},
    {name:'File-Name',value:input.archiveName},
    {name:'File-Size',value:String(info.size)},
    {name:'App-Name',value:'HITLOOP-Archive'},
    {name:'Archive-Schema',value:'1.0'},
    {name:'SHA-256',value:input.sha256},
    {name:'Collection-ID',value:input.collectionId},
  ];
  // Turbo SDK accepts Node readable streams; originals never need to be loaded
  // wholly into memory and are never modified.
  const result=await turbo.upload({data:createReadStream(input.filePath),dataItemOpts:{tags},turboOpts:{payment:{token:'arweave'}}});
  if(!result?.id) throw new Error('Turbo upload returned no transaction id');
  return {transactionId:result.id,arweaveUrl:`https://arweave.net/${result.id}`,sizeBytes:info.size,tags};
}
