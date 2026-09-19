import { createHash } from 'crypto';
import { ArchiveDatabase } from '../database';
import { TwelveLabsAdapter, isTwelveLabsVideo } from '../providers/twelvelabs';

function observationId(assetId:string,provider:string,kind:string){
  return createHash('sha256').update(`${assetId}:${provider}:${kind}`).digest('hex');
}

export class ArchiveAnalysisService {
  constructor(private db=new ArchiveDatabase(),private twelveLabs=new TwelveLabsAdapter()) {}

  async analyzeVideo(contentAssetId:string,filePath:string) {
    if(!isTwelveLabsVideo(filePath)) return null;
    const id=observationId(contentAssetId,'twelvelabs','video_understanding');
    const prior=this.db.listObservations(contentAssetId).find(x=>x.id===id);
    if(prior && ['SUBMITTED','INDEXING','READY'].includes(prior.status)) return prior;

    this.db.setAssetState(contentAssetId,'ANALYZING');
    this.db.upsertObservation({id,contentAssetId,provider:'twelvelabs',kind:'video_understanding',status:'SUBMITTING'});
    try {
      const result=await this.twelveLabs.submitVideo(contentAssetId,filePath);
      this.db.upsertObservation({id,contentAssetId,provider:'twelvelabs',providerAssetId:result.providerAssetId,kind:'video_understanding',status:result.status,payload:result.raw});
      return this.db.listObservations(contentAssetId).find(x=>x.id===id)!;
    } catch(error) {
      this.db.upsertObservation({id,contentAssetId,provider:'twelvelabs',kind:'video_understanding',status:'FAILED',error:error instanceof Error?error.message:String(error)});
      this.db.setAssetState(contentAssetId,'RETRYABLE_FAILED');
      throw error;
    }
  }
}
