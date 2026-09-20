import { readFile } from 'fs/promises';
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
  const turbo=TurboFactory.authenticated({signer:new ArweaveSigner(wallet())});
  const tags=[
    {name:'Content-Type',value:input.contentType||'application/octet-stream'},
    {name:'File-Name',value:input.archiveName},
    {name:'File-Size',value:String(info.size)},
    {name:'App-Name',value:'HITLOOP-Archive'},
    {name:'Archive-Schema',value:'1.0'},
    {name:'SHA-256',value:input.sha256},
    {name:'Collection-ID',value:input.collectionId},
  ];
  // POC path: the installed Turbo SDK type accepts Buffer, not Node ReadStream.
  // Keep this limited to small validation files until the large-file path is verified.
  const data=await readFile(input.filePath);
  const result=await turbo.upload({data,dataItemOpts:{tags}});
  if(!result?.id) throw new Error('Turbo upload returned no transaction id');
  return {transactionId:result.id,arweaveUrl:`https://arweave.net/${result.id}`,sizeBytes:info.size,tags};
}
