import { TOOL, TOOL_NAME, buildPrompt } from './schema';
import type { Usage } from './cost';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface VisionResult { raw: unknown; usage: Usage }
export type Vision = (jpeg: Buffer, relativePath: string, kind: 'image' | 'video') => Promise<VisionResult>;

interface Resp { content?: Array<{ type: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } }

/** Single source of truth for the Messages request body, shared by the sync call and Batch mode. */
export function buildRequestParams(model: string, jpeg: Buffer, relativePath: string, kind: 'image' | 'video', forced = true) {
  return {
    model,
    max_tokens: 1500,
    tools: [TOOL],
    tool_choice: forced ? { type: 'tool', name: TOOL_NAME } : { type: 'auto' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: buildPrompt(relativePath, kind) },
    ] }],
  };
}

/** One forced tool call per file. fetchImpl is injectable so tests never touch the network. */
export function makeVision(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch }): Vision {
  const f = opts.fetchImpl ?? fetch;
  return async (jpeg, relativePath, kind) => {
    const mk = (forced: boolean): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(buildRequestParams(opts.model, jpeg, relativePath, kind, forced)),
      signal: AbortSignal.timeout(90_000),
    });
    let forced = true;
    let res = await f(API_URL, mk(forced));
    if (res.status === 400) {
      const text = await res.text();
      if (!/tool_choice/i.test(text)) throw new Error(`Vision call failed: 400 ${text}`);
      forced = false; // some models reject forced tool_choice
      res = await f(API_URL, mk(forced));
    }
    if (res.status === 429 || res.status >= 500) { await sleep(2000); res = await f(API_URL, mk(forced)); }
    if (!res.ok) throw new Error(`Vision call failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as Resp;
    const tu = (body.content || []).find(b => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!tu) throw new Error('Vision call returned no tool_use block');
    return { raw: tu.input, usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 } };
  };
}
