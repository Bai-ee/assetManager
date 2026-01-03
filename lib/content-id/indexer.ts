import * as fs from 'fs';
import * as path from 'path';
import CryptoJS from 'crypto-js';

// File metadata schema
export interface ContentMetadata {
  file_id: string;
  path: string;
  filename: string;
  ext: string;
  size_bytes: number;
  modified_at: string;
  created_at: string;

  asset_type: 'image' | 'video' | 'gif' | 'design' | 'doc' | 'audio' | 'code' | 'archive' | 'other';
  mime_type: string;

  brand: string;
  project: string;
  collection: string;

  content_summary: string;
  tags: string[];
  entities: {
    characters: string[];
    logos: string[];
    locations: string[];
    tools: string[];
  };

  visual?: {
    width?: number;
    height?: number;
    duration_sec?: number;
    frame_sample_count?: number;
    dominant_colors?: string[];
  };

  repo?: {
    is_repo: boolean;
    repo_root?: string;
    repo_name?: string;
  };

  suggested_name: string;
  suggested_path: string;

  embedding_text: string;
  indexed_at: string;
  index_version: number;
}

// Paths
const INDEX_DIR = path.join(process.cwd(), '.moleboard', 'index');

/**
 * Ensure index directory exists
 */
function ensureIndexDir(): void {
  if (!fs.existsSync(INDEX_DIR)) {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
  }
}

/**
 * Generate stable file ID from path, size, and mtime
 */
export function generateFileId(filePath: string, size: number, mtime: string): string {
  const content = `${filePath}:${size}:${mtime}`;
  return CryptoJS.SHA256(content).toString();
}

/**
 * Stage A: Fast heuristics (always runs)
 */
function stageAHeuristics(
  filePath: string,
  stats: fs.Stats,
  ext: string
): Partial<ContentMetadata> {
  const filename = path.basename(filePath);
  const normalizedExt = ext.toLowerCase().replace('.', '');

  // Detect asset type
  let assetType: ContentMetadata['asset_type'] = 'other';
  const videoExts = ['mov', 'mp4', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'm4v'];
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'svg', 'ico', 'heic', 'heif'];
  const designExts = ['psd', 'ai', 'aep', 'prproj', 'blend', 'sketch', 'fig', 'xd', 'indd', 'eps'];
  const audioExts = ['wav', 'aiff', 'aif', 'mp3', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
  const docExts = ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx'];

  if (normalizedExt === 'gif') assetType = 'gif';
  else if (videoExts.includes(normalizedExt)) assetType = 'video';
  else if (imageExts.includes(normalizedExt)) assetType = 'image';
  else if (designExts.includes(normalizedExt)) assetType = 'design';
  else if (audioExts.includes(normalizedExt)) assetType = 'audio';
  else if (docExts.includes(normalizedExt)) assetType = 'doc';
  else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(normalizedExt)) assetType = 'archive';
  else if (
    ['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'php'].includes(normalizedExt) ||
    ['json', 'yaml', 'yml', 'xml', 'html', 'css', 'scss', 'less'].includes(normalizedExt)
  ) {
    assetType = 'code';
  }

  // Detect brand from path keywords
  let brand = 'unknown';
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes('critters')) brand = 'critters';
  else if (lowerPath.includes('rositas')) brand = 'rositas';
  else if (lowerPath.includes('code') && lowerPath.includes('palette')) brand = 'code_and_palette';
  else if (lowerPath.includes('underground') || lowerPath.includes('existence')) brand = 'underground_existence';

  // Detect project from path structure
  let project = 'unknown';
  const pathParts = filePath.split('/');
  for (let i = pathParts.length - 2; i >= 0; i--) {
    const part = pathParts[i].toLowerCase();
    if (['projects', 'clientwork', 'assets', 'work'].includes(part)) {
      project = pathParts[i + 1] || 'unknown';
      break;
    }
  }

  // Detect collection from folder keywords
  let collection = 'unknown';
  const folderKeywords = ['characters', 'logo', 'mockups', 'website', 'game_assets', 'menus', 'social', 'posts', 'gifs', 'videos', 'images'];
  for (const keyword of folderKeywords) {
    if (lowerPath.includes(keyword)) {
      collection = keyword;
      break;
    }
  }

  // Generate tags from filename
  const tags: string[] = [];
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
  const nameParts = nameWithoutExt.split(/[-_ ]+/);
  for (const part of nameParts) {
    if (part.length > 2 && !['the', 'and', 'for', 'with'].includes(part.toLowerCase())) {
      tags.push(part.toLowerCase());
    }
  }

  // Repo detection
  let repo: ContentMetadata['repo'] = { is_repo: false };
  const parentDir = path.dirname(filePath);
  const gitPath = path.join(parentDir, '.git');
  if (fs.existsSync(gitPath)) {
    repo = { is_repo: true, repo_root: parentDir, repo_name: path.basename(parentDir) };
  }

  // Generate suggested name
  const suggestedName = `${brand}_${nameWithoutExt}_v01${ext}`;

  return {
    asset_type: assetType,
    mime_type: getMimeType(ext),
    brand,
    project,
    collection,
    tags,
    repo,
    suggested_name: suggestedName,
    suggested_path: filePath, // Will be adjusted by organize logic
  };
}

/**
 * Get MIME type from extension
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.psd': 'image/vnd.adobe.photoshop',
    '.aep': 'application/x-after-effects',
    '.blend': 'application/x-blender',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Generate embedding text from metadata
 */
function generateEmbeddingText(meta: Partial<ContentMetadata>): string {
  const parts: string[] = [];

  if (meta.brand && meta.brand !== 'unknown') parts.push(meta.brand);
  if (meta.project && meta.project !== 'unknown') parts.push(meta.project);
  if (meta.collection && meta.collection !== 'unknown') parts.push(meta.collection);
  if (meta.asset_type) parts.push(meta.asset_type);
  if (meta.tags?.length) parts.push(...meta.tags);
  if (meta.content_summary) parts.push(meta.content_summary);

  return parts.join(' ');
}

/**
 * Index a single file
 */
export async function indexFile(filePath: string): Promise<ContentMetadata | null> {
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath);
    const fileId = generateFileId(filePath, stats.size, stats.mtime.toISOString());

    // Check if already indexed and unchanged
    const existingPath = path.join(INDEX_DIR, `${fileId}.json`);
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'));
      if (existing.indexed_at && new Date(existing.indexed_at) > stats.mtime) {
        return existing;
      }
    }

    // Stage A: Heuristics (fast, always runs)
    const meta: ContentMetadata = {
      file_id: fileId,
      path: filePath,
      filename: path.basename(filePath),
      ext,
      size_bytes: stats.size,
      modified_at: stats.mtime.toISOString(),
      created_at: stats.birthtime?.toISOString() || stats.mtime.toISOString(),
      asset_type: 'other',
      mime_type: 'application/octet-stream',
      brand: 'unknown',
      project: 'unknown',
      collection: 'unknown',
      content_summary: '',
      tags: [],
      entities: { characters: [], logos: [], locations: [], tools: [] },
      suggested_name: '',
      suggested_path: '',
      embedding_text: '',
      indexed_at: new Date().toISOString(),
      index_version: 1,
    };

    // Apply Stage A heuristics
    const stageA = stageAHeuristics(filePath, stats, ext);
    Object.assign(meta, stageA);
    meta.embedding_text = generateEmbeddingText(meta);

    // Save to both SQLite and JSON
    ensureIndexDir();
    fs.writeFileSync(existingPath, JSON.stringify(meta, null, 2), 'utf-8');

    return meta;
  } catch (error) {
    console.error(`Error indexing file ${filePath}:`, error);
    return null;
  }
}

/**
 * Index all files in a directory
 */
export async function indexDirectory(
  rootPath: string,
  options: {
    extensions?: string[];
    progressCallback?: (current: number, total: number) => void;
  } = {}
): Promise<ContentMetadata[]> {
  const { extensions = ['.mp4', '.mov', '.png', '.jpg', '.jpeg', '.gif', '.psd', '.aep', '.blend', '.pdf'], progressCallback } = options;

  const results: ContentMetadata[] = [];
  const allFiles: string[] = [];

  // Collect all matching files
  function walkDir(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
          // Skip hidden and system directories
          if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== '.git') {
            walkDir(fullPath);
          }
        } else if (extensions.includes(path.extname(entry).toLowerCase())) {
          allFiles.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  walkDir(rootPath);

  // Index all files
  let indexed = 0;
  for (const filePath of allFiles) {
    const meta = await indexFile(filePath);
    if (meta) {
      results.push(meta);
    }
    indexed++;
    if (progressCallback) {
      progressCallback(indexed, allFiles.length);
    }
  }

  return results;
}

/**
 * Load indexed metadata for a file
 */
export function loadMetadata(fileId: string): ContentMetadata | null {
  const filePath = path.join(INDEX_DIR, `${fileId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Search indexed files
 */
export function searchIndex(
  query: string,
  filters?: {
    brand?: string[];
    asset_type?: string[];
    collection?: string[];
    min_size?: number;
    max_size?: number;
    tags?: string[];
  }
): ContentMetadata[] {
  ensureIndexDir();

  const results: ContentMetadata[] = [];
  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json'));

  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    try {
      const meta: ContentMetadata = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, file), 'utf-8'));

      // Text search
      if (query && !meta.embedding_text.toLowerCase().includes(lowerQuery)) {
        continue;
      }

      // Apply filters
      if (filters?.brand?.length && !filters.brand.includes(meta.brand)) {
        continue;
      }
      if (filters?.asset_type?.length && !filters.asset_type.includes(meta.asset_type)) {
        continue;
      }
      if (filters?.collection?.length && !filters.collection.includes(meta.collection)) {
        continue;
      }
      if (filters?.min_size !== undefined && meta.size_bytes < filters.min_size) {
        continue;
      }
      if (filters?.max_size !== undefined && meta.size_bytes > filters.max_size) {
        continue;
      }
      if (filters?.tags?.length && !filters.tags.some((t) => meta.tags.includes(t))) {
        continue;
      }

      results.push(meta);
    } catch {
      // Skip corrupted files
    }
  }

  // Sort by relevance (query match) then by size
  if (query) {
    results.sort((a, b) => {
      const aHasQuery = a.embedding_text.toLowerCase().includes(lowerQuery);
      const bHasQuery = b.embedding_text.toLowerCase().includes(lowerQuery);
      if (aHasQuery && !bHasQuery) return -1;
      if (!aHasQuery && bHasQuery) return 1;
      return b.size_bytes - a.size_bytes;
    });
  } else {
    results.sort((a, b) => b.size_bytes - a.size_bytes);
  }

  return results;
}

/**
 * Get all unique brands in index
 */
export function getIndexedBrands(): string[] {
  ensureIndexDir();
  const brands = new Set<string>();
  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, file), 'utf-8'));
      if (meta.brand) brands.add(meta.brand);
    } catch {
      // Skip corrupted files
    }
  }

  return Array.from(brands).sort();
}

/**
 * Get all unique tags in index
 */
export function getIndexedTags(): string[] {
  ensureIndexDir();
  const tags = new Set<string>();
  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, file), 'utf-8'));
      for (const tag of meta.tags || []) {
        tags.add(tag);
      }
    } catch {
      // Skip corrupted files
    }
  }

  return Array.from(tags).sort();
}
