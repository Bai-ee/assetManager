import { createHash } from 'crypto';
import { ArchiveDatabase } from '../database';
import { TwelveLabsAdapter, isTwelveLabsVideo } from '../providers/twelvelabs';

function observationId(assetId:string,provider:string,kind:string){
  return createHash('sha256').update(`${assetId}:${provider}:${kind}`).digest('hex');
}

/** The deterministic id `analyzeVideo` stores its observation under. Exported so
 * callers (the daemon's tests, a future poller) can look up or seed that exact
 * row without reimplementing the hash. */
export function videoObservationId(contentAssetId:string):string {
  return observationId(contentAssetId,'twelvelabs','video_understanding');
}

/** What Pegasus is asked for on a ready asset. Evidence for an archivist, not
 * a caption for a viewer: plain prose, nothing speculative, "unknown" where
 * the video doesn't actually show or say something. */
export const ARCHIVAL_EVIDENCE_PROMPT=`You are describing this video for an archivist, not a viewer. Write plain prose, under 400 words. State only what is directly evidenced in the video; write "unknown" for anything you cannot actually see or hear rather than guessing.

Cover:
- Subject and setting: what is happening, and where it appears to be.
- On-screen text: transcribe it verbatim if any appears.
- Category: is this a performance, a promo, flyer-motion graphics, behind-the-scenes footage, an interview, or something else.
- People: how many appear, and whether any faces are clearly identifiable.
- Era or date cues: anything (fashion, technology, quality, timestamps) that suggests when this was made.
- Names: any brand, venue, or event names that appear or are spoken.
- Music: the genre, if audible, and only if you can actually hear it.
- Overall mood.`;

export class ArchiveAnalysisService {
  constructor(private db=new ArchiveDatabase(),private twelveLabs=new TwelveLabsAdapter()) {}

  get configured(): boolean { return Boolean(this.twelveLabs?.configured); }

  async advanceVideo(contentAssetId:string) {
    const obs=this.db.listObservations(contentAssetId).find(x=>x.provider==='twelvelabs'&&x.kind==='video_understanding');
    if(!obs?.providerAssetId) return obs || null;
    const asset=await this.twelveLabs.getAsset(obs.providerAssetId);
    const status=String(asset.status||'').toLowerCase();
    if(status==='failed') {
      this.db.upsertObservation({...obs,status:'FAILED',payload:asset,error:'TwelveLabs asset processing failed'});
      this.db.setAssetState(contentAssetId,'RETRYABLE_FAILED'); return this.db.listObservations(contentAssetId).find(x=>x.id===obs.id)!;
    }
    if(status!=='ready') {
      // Local "INDEXING" means TwelveLabs is still processing the uploaded
      // asset itself, not that it has been added to a search index — Marengo
      // search indexing (indexAsset) is a separate, optional path, not needed
      // for Jev evidence.
      this.db.upsertObservation({...obs,status:'INDEXING',payload:asset}); return this.db.listObservations(contentAssetId).find(x=>x.id===obs.id)!;
    }
    // The asset is ready. Ask Pegasus to describe it directly — analyzeAsset's
    // only precondition is asset readiness, no index required.
    try {
      const analysis=await this.twelveLabs.analyzeAsset(obs.providerAssetId,ARCHIVAL_EVIDENCE_PROMPT);
      console.log(`twelvelabs analyze: asset=${contentAssetId} input_tokens=${analysis.usage?.input_tokens??'unknown'} output_tokens=${analysis.usage?.output_tokens??'unknown'}`);
      this.db.upsertObservation({...obs,status:'READY',summary:analysis.text,payload:{asset,analysis:{finishReason:analysis.finishReason,usage:analysis.usage}}});
      return this.db.listObservations(contentAssetId).find(x=>x.id===obs.id)!;
    } catch(error) {
      this.db.upsertObservation({...obs,status:'FAILED',payload:asset,error:error instanceof Error?error.message:String(error)});
      this.db.setAssetState(contentAssetId,'RETRYABLE_FAILED');
      throw error;
    }
  }

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
