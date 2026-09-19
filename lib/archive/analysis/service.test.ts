import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ArchiveDatabase } from '../database';
import { ArchiveAnalysisService } from './service';

test('video analysis persists provider observation and avoids duplicate submission',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-analysis-'));
  const db=new ArchiveDatabase(path.join(root,'archive.sqlite'));
  db.insertAsset({id:'asset1',sha256:'asset1',sizeBytes:3,createdAt:new Date().toISOString(),state:'QUEUED'});
  let calls=0;
  const provider:any={submitVideo:async()=>{calls++;return {provider:'twelvelabs',providerAssetId:'task1',sourceAssetId:'asset1',status:'SUBMITTED',raw:{id:'task1'}}}};
  const service=new ArchiveAnalysisService(db,provider);
  await service.analyzeVideo('asset1',path.join(root,'clip.mov'));
  await service.analyzeVideo('asset1',path.join(root,'clip.mov'));
  assert.equal(calls,1);
  assert.equal(db.listObservations('asset1')[0].providerAssetId,'task1');
  db.close(); await fs.rm(root,{recursive:true,force:true});
});
