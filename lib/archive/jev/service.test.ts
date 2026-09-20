import test from 'node:test'; import assert from 'node:assert/strict';
import { reviewBand, JevDecisionService } from './service';
test('review bands follow archive confidence policy',()=>{assert.equal(reviewBand(.91),'AUTO_CONFIRM');assert.equal(reviewBand(.75),'QUICK_REVIEW');assert.equal(reviewBand(.59),'IDENTIFICATION_REQUIRED')});
test('Jev decisions rank probabilities',async()=>{const provider:any={decide:async()=>[{value:'unknown',probability:.1},{value:'performance_photo',probability:.9}]};const svc=new JevDecisionService(provider);const d=await svc.decide({assetId:'a',sha256:'a',mediaType:'image',sourcePaths:[],evidence:[],observations:[]},'asset_type',['performance_photo','unknown']);assert.equal(d.selectedValue,'performance_photo');assert.equal(d.confidence,.9)});
