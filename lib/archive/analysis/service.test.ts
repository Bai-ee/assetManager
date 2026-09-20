import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ArchiveDatabase } from '../database';
import { ArchiveAnalysisService, videoObservationId } from './service';

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

async function readyFixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-analysis-advance-'));
  const db=new ArchiveDatabase(path.join(root,'archive.sqlite'));
  db.insertAsset({id:'asset1',sha256:'asset1',sizeBytes:3,createdAt:new Date().toISOString(),state:'QUEUED'});
  db.upsertObservation({id:videoObservationId('asset1'),contentAssetId:'asset1',provider:'twelvelabs',providerAssetId:'task1',kind:'video_understanding',status:'SUBMITTED'});
  return { root, db };
}

test('advanceVideo analyzes a ready asset and records a READY observation with the summary',async()=>{
  const { root, db }=await readyFixture();
  let analyzeCalls=0;
  const provider:any={
    getAsset:async()=>({status:'ready'}),
    analyzeAsset:async(assetId:string,prompt:string)=>{
      analyzeCalls++;
      assert.equal(assetId,'task1');
      assert.match(prompt,/archivist/);
      return {text:'a live performance clip with visible stage lighting',usage:{input_tokens:120,output_tokens:80},finishReason:'stop',raw:{}};
    },
  };
  const service=new ArchiveAnalysisService(db,provider);
  const result=await service.advanceVideo('asset1');
  assert.equal(analyzeCalls,1);
  assert.equal(result?.status,'READY');
  assert.equal(result?.summary,'a live performance clip with visible stage lighting');
  db.close(); await fs.rm(root,{recursive:true,force:true});
});

test('advanceVideo does not call analyze while TwelveLabs is still processing the asset',async()=>{
  const { root, db }=await readyFixture();
  const provider:any={
    getAsset:async()=>({status:'processing'}),
    analyzeAsset:async()=>{ throw new Error('analyzeAsset must not be called before the asset is ready'); },
  };
  const service=new ArchiveAnalysisService(db,provider);
  const result=await service.advanceVideo('asset1');
  assert.equal(result?.status,'INDEXING');
  db.close(); await fs.rm(root,{recursive:true,force:true});
});

test('advanceVideo records a FAILED observation and rethrows when analyze errors',async()=>{
  const { root, db }=await readyFixture();
  const provider:any={
    getAsset:async()=>({status:'ready'}),
    analyzeAsset:async()=>{ throw new Error('TwelveLabs analyze failed: 500'); },
  };
  const service=new ArchiveAnalysisService(db,provider);
  await assert.rejects(()=>service.advanceVideo('asset1'),/TwelveLabs analyze failed/);
  const observation=db.listObservations('asset1').find(o=>o.id===videoObservationId('asset1'));
  assert.equal(observation?.status,'FAILED');
  db.close(); await fs.rm(root,{recursive:true,force:true});
});
