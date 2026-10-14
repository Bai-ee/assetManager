import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LabelRead, LabelReadStatus } from './types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TOOL_NAME = 'record_label';

export interface ReadLabelOptions {
  cacheDir?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const nullableString = { type: ['string', 'null'] };

const TOOL = {
  name: TOOL_NAME,
  description: 'Record the text read from the centre label of one vinyl record photo.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['readable', 'partial', 'unreadable'],
        description:
          "'readable' = catalog number present, or artist AND title present. 'partial' = some text but not enough. 'unreadable' = nothing useful.",
      },
      artist: { ...nullableString, description: 'Artist name as printed, or null.' },
      title: { ...nullableString, description: 'Release title (EP / single name), or null.' },
      label: { ...nullableString, description: 'Record label name, or null.' },
      catno: { ...nullableString, description: 'Catalog number exactly as printed, or null.' },
      year: { ...nullableString, description: 'Year if printed (e.g. a copyright/pressing year), or null.' },
      tracks: { type: 'array', items: { type: 'string' }, description: 'Track / mix names printed on the label.' },
      side: { ...nullableString, description: "Side as printed ('A', 'B', 'AA', ...), 'logo side' if only a logo, or null." },
      notes: { ...nullableString, description: 'Other useful info (speed, matrix/runout text, country). Never price stickers.' },
    },
    required: ['status', 'artist', 'title', 'label', 'catno', 'year', 'tracks', 'side', 'notes'],
  },
};

const PROMPT = [
  'This is a photo of the centre label of a vinyl record. The text may be rotated or upside down; read it in whatever orientation it appears.',
  'You must respond by calling the record_label tool exactly once, with what is printed on the label.',
  'Rules:',
  '- Copy catalog numbers exactly as printed (keep letters, dashes, spaces, digits). Never guess or complete them.',
  '- Use null for any field that is not clearly visible. Use [] for tracks if none are legible.',
  '- Ignore shop price stickers and dealer stamps (e.g. "AMOEBA $1.99", "waxaddict House Cut-Outs 910002"); those are not the catalog number.',
  '- A label showing only a logo or no legible text is "unreadable" (or "partial" if the label name or side is legible).',
  "- status: 'readable' if a catalog number is present, or both artist and title are present; 'partial' if some text but not enough; 'unreadable' if nothing useful.",
].join('\n');

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

interface MessageResponse {
  content?: Array<ToolUseBlock | { type: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function normalize(raw: Record<string, unknown>, fileName: string, model: string): LabelRead {
  const status: LabelReadStatus =
    raw.status === 'readable' || raw.status === 'partial' || raw.status === 'unreadable' ? raw.status : 'unreadable';
  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim())
    : [];
  return {
    file: fileName,
    status,
    artist: str(raw.artist),
    title: str(raw.title),
    label: str(raw.label),
    catno: str(raw.catno),
    year: str(raw.year),
    tracks,
    side: str(raw.side),
    notes: str(raw.notes),
    model,
    cached: false,
  };
}

/** Model a read will use (same precedence as readLabel). */
export function resolveLabelModel(model?: string): string {
  return model || process.env.DISCOGS_VISION_MODEL || DEFAULT_MODEL;
}

/** Cache file for one jpeg + model. Needs no API key and makes no model call. */
export function labelCacheFile(jpegPath: string, cacheDir: string, model?: string): string {
  const bytes = fs.readFileSync(jpegPath);
  const hash = createHash('sha256').update(bytes).update('\0').update(resolveLabelModel(model)).digest('hex');
  return path.join(cacheDir, `label-${hash}.json`);
}

/** True when readLabel would answer this jpeg from its cache (free). */
export function isLabelCached(jpegPath: string, cacheDir: string, model?: string): boolean {
  return fs.existsSync(labelCacheFile(jpegPath, cacheDir, model));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function readLabel(jpegPath: string, fileName: string, opts: ReadLabelOptions = {}): Promise<LabelRead> {
  const model = resolveLabelModel(opts.model);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Label reader is not configured: ANTHROPIC_API_KEY is missing');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const bytes = fs.readFileSync(jpegPath);
  const hash = createHash('sha256').update(bytes).update('\0').update(model).digest('hex');
  const cacheFile = opts.cacheDir ? path.join(opts.cacheDir, `label-${hash}.json`) : null;

  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as LabelRead;
      return { ...cached, file: fileName, cached: true };
    } catch {
      // corrupt cache entry: fall through and re-read
    }
  }

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    tools: [TOOL],
    // This model rejects forced tool_choice (400), so use auto and instruct the call in the prompt.
    tool_choice: { type: 'auto' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const init = (): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body,
    signal: AbortSignal.timeout(90_000),
  });

  let response = await fetchImpl(ANTHROPIC_API_URL, init());
  if (response.status === 429 || response.status >= 500) {
    await sleep(2000);
    response = await fetchImpl(ANTHROPIC_API_URL, init());
  }
  if (!response.ok) {
    throw new Error(`Label read failed for ${fileName}: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as MessageResponse;
  const toolUse = (payload.content || []).find(
    (b): b is ToolUseBlock => b.type === 'tool_use' && (b as ToolUseBlock).name === TOOL_NAME,
  );
  if (!toolUse) throw new Error(`Label read for ${fileName} did not include the expected tool call`);

  console.log(
    `label read: file=${fileName} model=${model} input_tokens=${payload.usage?.input_tokens ?? 'unknown'} output_tokens=${payload.usage?.output_tokens ?? 'unknown'}`,
  );

  const result = normalize(toolUse.input || {}, fileName, model);
  if (payload.usage) {
    const u = payload.usage;
    result.usage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      ...(u.cache_read_input_tokens != null ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens != null ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
    };
  }
  if (cacheFile) {
    fs.mkdirSync(opts.cacheDir as string, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  }
  return result;
}
