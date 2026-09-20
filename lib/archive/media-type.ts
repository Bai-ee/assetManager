import * as path from 'path';
import { VIDEO_EXTENSIONS } from './providers/twelvelabs';

export type MediaType = 'video' | 'image' | 'audio' | 'document' | 'other';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.txt', '.md']);

/**
 * Classify a file location by extension. Shared by the sync-to-HITLOOP payload
 * (`archive_review.mediaType`) and the Jev evidence builder, so both sides agree
 * on what an asset is without re-deriving it separately.
 */
export function inferMediaType(relativePath: string): MediaType {
  const ext = path.extname(relativePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'other';
}
