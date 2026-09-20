import * as path from 'path';
import type { AssetState } from '../schema/asset-state';
import type { JevChoice, JevProvider } from './service';
import { JEV_QUESTIONS, type JevTaxonomyQuestion } from './taxonomy';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const TOOL_NAME = 'answer_jev_questions';

interface AnthropicToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content?: Array<AnthropicToolUseBlock | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A NAS mount path (e.g. `/Volumes/bryan/...`) must never reach the model —
 * only the path relative to the registered source, which is what the worker
 * already stores as provenance (ARCHITECTURE.md "Existing source paths/folder
 * names are evidence"). This is a defensive filter on top of that: the caller
 * is expected to already pass relative paths.
 */
function sanitizeSourcePaths(sourcePaths: string[]): string[] {
  return sourcePaths.filter(p => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p));
}

function buildEvidence(input: AssetState) {
  return {
    mediaType: input.mediaType,
    sourcePaths: sanitizeSourcePaths(input.sourcePaths),
    observations: input.observations.map(o => ({
      provider: o.provider,
      kind: o.kind,
      status: o.status,
      summary: o.summary ?? null,
    })),
  };
}

function questionProperty(q: JevTaxonomyQuestion) {
  const value: Record<string, unknown> = { type: 'string' };
  if (!q.openEnded && q.choices.length) value.enum = q.choices;
  return {
    type: 'array',
    description: q.question,
    items: {
      type: 'object',
      properties: {
        value: value,
        probability: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['value', 'probability'],
    },
  };
}

function buildTool(questions: JevTaxonomyQuestion[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const q of questions) {
    properties[q.id] = questionProperty(q);
    required.push(q.id);
  }
  return {
    name: TOOL_NAME,
    description:
      'Answer every HITLOOP archive taxonomy question for one asset, using only the evidence supplied. ' +
      'For each question return every candidate value worth recording, ranked by probability (0-1). ' +
      'If a question has no fixed choices, name what the evidence actually supports; return an empty array only if nothing is supported.',
    input_schema: { type: 'object', properties, required },
  };
}

/** Coerce and validate one question's raw tool output into ranked choices. */
function normalizeChoices(raw: unknown, question: JevTaxonomyQuestion): JevChoice[] {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned: JevChoice[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const value = String((item as Record<string, unknown>).value ?? '').trim();
    if (!value) continue;
    const probabilityRaw = Number((item as Record<string, unknown>).probability);
    if (!Number.isFinite(probabilityRaw)) continue;
    cleaned.push({ value, probability: Math.min(1, Math.max(0, probabilityRaw)) });
  }
  if (cleaned.length) return cleaned;
  // JevDecisionService requires at least one ranked choice. An open-ended
  // question (entities) can legitimately find nothing in the evidence — record
  // that explicitly rather than letting one empty question fail the whole asset.
  return [{ value: question.openEnded ? 'none-detected' : 'unknown', probability: 0.5 }];
}

/**
 * Jev provider backed by the Anthropic Messages API. One request per asset
 * answers all six taxonomy questions (forced via tool_choice), because that is
 * the only shape that keeps per-asset Jev spend to a single call. The existing
 * per-question `JevProvider.decide` interface is preserved: the first call for
 * an asset makes the request and fills a per-asset cache; later calls for the
 * same asset read from it.
 */
export class AnthropicJevProvider implements JevProvider {
  private cache = new Map<string, Record<string, JevChoice[]>>();
  private questionByText = new Map<string, JevTaxonomyQuestion>();
  private questionById = new Map<string, JevTaxonomyQuestion>();

  constructor(
    private apiKey = process.env.ANTHROPIC_API_KEY,
    private model = process.env.JEV_MODEL || DEFAULT_MODEL,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private questions: JevTaxonomyQuestion[] = JEV_QUESTIONS,
  ) {
    for (const q of this.questions) {
      this.questionByText.set(q.question, q);
      this.questionById.set(q.id, q);
    }
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  /** One Anthropic call answering every question for this asset. */
  async decideAll(input: AssetState, questions: JevTaxonomyQuestion[] = this.questions): Promise<Record<string, JevChoice[]>> {
    if (!this.apiKey) throw new Error('Jev is not configured: ANTHROPIC_API_KEY is missing');
    const tool = buildTool(questions);
    const evidence = buildEvidence(input);
    const body = {
      model: this.model,
      max_tokens: 1536,
      temperature: 0,
      tools: [tool],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Evidence for one archive asset, as JSON:\n${JSON.stringify(evidence, null, 2)}`,
        },
      ],
    };

    const response = await this.fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Jev request failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as AnthropicMessageResponse;
    const toolUse = (payload.content || []).find(
      (block): block is AnthropicToolUseBlock => block.type === 'tool_use' && (block as AnthropicToolUseBlock).name === TOOL_NAME,
    );
    if (!toolUse) throw new Error('Jev response did not include the expected tool call');

    // Cost visibility: worker-side spend is invisible to HITLOOP's Operating
    // Cost card unless logged here.
    const usage = payload.usage;
    console.log(
      `jev call: asset=${input.assetId} model=${this.model} input_tokens=${usage?.input_tokens ?? 'unknown'} output_tokens=${usage?.output_tokens ?? 'unknown'}`,
    );

    const answers: Record<string, JevChoice[]> = {};
    const rawInput = (toolUse.input || {}) as Record<string, unknown>;
    for (const q of questions) {
      answers[q.id] = normalizeChoices(rawInput[q.id], q);
    }
    this.cache.set(input.assetId, answers);
    return answers;
  }

  async decide(input: AssetState, question: string, _choices: string[]): Promise<JevChoice[]> {
    let cached = this.cache.get(input.assetId);
    if (!cached) cached = await this.decideAll(input);
    const match = this.questionById.get(question) || this.questionByText.get(question);
    if (!match) throw new Error(`Jev received an unknown question: ${question}`);
    return cached[match.id] || [];
  }
}
