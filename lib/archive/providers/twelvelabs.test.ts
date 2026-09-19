import test from 'node:test';
import assert from 'node:assert/strict';
import { isTwelveLabsVideo, TwelveLabsAdapter } from './twelvelabs';

test('TwelveLabs adapter gates supported video extensions',()=>{
  assert.equal(isTwelveLabsVideo('/archive/set.MOV'),true);
  assert.equal(isTwelveLabsVideo('/archive/flyer.jpg'),false);
});

test('TwelveLabs adapter stays disabled without credentials',()=>{
  const adapter=new TwelveLabsAdapter(undefined,undefined);
  assert.equal(adapter.configured,false);
});
