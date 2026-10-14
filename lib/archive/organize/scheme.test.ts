import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  ORGANIZED_ROOT_NAME,
  collectionIdFromOrganizedRelativePath,
  collectionTitleFromPath,
  isAudioExtension,
  isFilesystemArtifact,
  isMovableExtension,
  isProjectFileExtension,
  isProjectFolderName,
  isUnderOrganizedRoot,
  isValidPillar,
  slugifyCollectionId,
  targetPath,
  withCollisionSuffix,
} from './scheme';

test('classifies movable vs never-move extensions', () => {
  assert.equal(isMovableExtension('clip.MP4'), true);
  assert.equal(isMovableExtension('photo.jpeg'), true);
  assert.equal(isMovableExtension('photo.HEIC'), true);
  assert.equal(isMovableExtension('track.wav'), false);
  assert.equal(isMovableExtension('song.als'), false);
  assert.equal(isMovableExtension('doc.pdf'), false);

  assert.equal(isAudioExtension('track.WAV'), true);
  assert.equal(isAudioExtension('take.aiff'), true);
  assert.equal(isAudioExtension('clip.mp4'), false);

  assert.equal(isProjectFileExtension('song.als'), true);
  assert.equal(isProjectFileExtension('set.RPP'), true);
  assert.equal(isProjectFileExtension('clip.mp4'), false);

  assert.equal(isProjectFolderName('Samples'), true);
  assert.equal(isProjectFolderName('Ableton Project Info'), true);
  assert.equal(isProjectFolderName('samples'), false); // exact match only
});

test('filesystem artifacts', () => {
  assert.equal(isFilesystemArtifact('._clip.mp4'), true);
  assert.equal(isFilesystemArtifact('.DS_Store'), true);
  assert.equal(isFilesystemArtifact('clip.mp4'), false);
});

test('pillar validation', () => {
  assert.equal(isValidPillar('was-there'), true);
  assert.equal(isValidPillar('building-now'), true);
  assert.equal(isValidPillar('unknown-pillar'), false);
  assert.equal(isValidPillar(undefined), false);
  assert.equal(isValidPillar(null), false);
});

test('slugifyCollectionId matches the HITLOOP cjs rule', () => {
  assert.equal(slugifyCollectionId('.'), 'root');
  assert.equal(slugifyCollectionId(''), 'root');
  assert.equal(slugifyCollectionId('hpit03_finals'), 'hpit03-finals');
  assert.equal(slugifyCollectionId('Some Folder/Sub Folder'), 'some-folder-sub-folder');
  assert.equal(slugifyCollectionId('---odd***chars---'), 'odd-chars');
});

test('collectionTitleFromPath uses the last path segment', () => {
  assert.equal(collectionTitleFromPath('.'), 'root');
  assert.equal(collectionTitleFromPath('Some Folder/Sub Folder'), 'Sub Folder');
});

test('targetPath builds <root>/HITLOOP-ARCHIVE/<collectionId>/<pillar>/<filename>', () => {
  const p = targetPath('/nas', 'hpit03-finals', 'was-there', 'clip.mp4');
  assert.equal(p, path.join('/nas', ORGANIZED_ROOT_NAME, 'hpit03-finals', 'was-there', 'clip.mp4'));
});

test('withCollisionSuffix inserts sha12 before the extension', () => {
  assert.equal(withCollisionSuffix('clip.mp4', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), 'clip (a1b2c3d4e5f6).mp4');
  assert.equal(withCollisionSuffix('noext', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), 'noext (ffffffffffff)');
});

test('isUnderOrganizedRoot accepts the root itself and anything beneath, rejects siblings/escapes', () => {
  assert.equal(isUnderOrganizedRoot('/nas', path.join('/nas', ORGANIZED_ROOT_NAME)), true);
  assert.equal(isUnderOrganizedRoot('/nas', path.join('/nas', ORGANIZED_ROOT_NAME, 'c1', 'was-there', 'clip.mp4')), true);
  assert.equal(isUnderOrganizedRoot('/nas', '/nas/other-folder/clip.mp4'), false);
  assert.equal(isUnderOrganizedRoot('/nas', `/nas/${ORGANIZED_ROOT_NAME}-lookalike/clip.mp4`), false);
  assert.equal(isUnderOrganizedRoot('/nas', '/elsewhere/HITLOOP-ARCHIVE/clip.mp4'), false);
});

test('collectionIdFromOrganizedRelativePath parses an organized-relative path', () => {
  assert.equal(collectionIdFromOrganizedRelativePath(`${ORGANIZED_ROOT_NAME}/hpit03-finals/was-there/clip.mp4`), 'hpit03-finals');
  assert.equal(collectionIdFromOrganizedRelativePath('not-organized/clip.mp4'), null);
  assert.equal(collectionIdFromOrganizedRelativePath(ORGANIZED_ROOT_NAME), null);
});
