import { createHash } from 'crypto';
import type { AssetState } from '../schema/asset-state';

export type ReviewBand='AUTO_CONFIRM'|'QUICK_REVIEW'|'IDENTIFICATION_REQUIRED';
export interface JevChoice { value:string; probability:number; }
export interface JevDecision {
  id:string; assetId:string; question:string; choices:JevChoice[];
  selectedValue:string; confidence:number; reviewBand:ReviewBand;
  evidence:unknown;
}

export function reviewBand(confidence:number):ReviewBand {
  if(confidence>0.90) return 'AUTO_CONFIRM';
  if(confidence>=0.60) return 'QUICK_REVIEW';
  return 'IDENTIFICATION_REQUIRED';
}

export function decisionId(assetId:string,question:string){
  return createHash('sha256').update(`${assetId}:${question}`).digest('hex');
}

export interface JevProvider {
  decide(input:AssetState,question:string,choices:string[]):Promise<JevChoice[]>;
}

/**
 * Provider-independent Jev boundary. Real Jev credentials can be added later
 * without changing archive persistence/review behavior.
 */
export class JevDecisionService {
  constructor(private provider:JevProvider){}
  async decide(input:AssetState,question:string,choices:string[]):Promise<JevDecision>{
    const ranked=(await this.provider.decide(input,question,choices)).sort((a,b)=>b.probability-a.probability);
    if(!ranked.length) throw new Error('Jev returned no choices');
    const top=ranked[0];
    return {id:decisionId(input.assetId,question),assetId:input.assetId,question,choices:ranked,selectedValue:top.value,confidence:top.probability,reviewBand:reviewBand(top.probability),evidence:input.evidence};
  }
}
