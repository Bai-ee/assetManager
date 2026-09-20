import type { AssetState } from '../schema/asset-state';

export interface PermanentArchiveManifest {
  schemaVersion:'1.0';
  collection:{id:string;title:string;generatedAt:string};
  assets:Array<{
    id:string;sha256:string;mediaType:AssetState['mediaType'];
    archiveName:string;sourcePaths:string[];
    observations:unknown[];decisions:unknown[];
  }>;
  provenance:{sourceSystem:'hitloop-archive-worker';originalsReadOnly:true};
}

export function buildPermanentManifest(input:Omit<PermanentArchiveManifest,'schemaVersion'|'provenance'>):PermanentArchiveManifest{
  return {schemaVersion:'1.0',...input,provenance:{sourceSystem:'hitloop-archive-worker',originalsReadOnly:true}};
}
