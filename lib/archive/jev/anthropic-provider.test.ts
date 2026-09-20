import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicJevProvider } from './anthropic-provider';
import { JEV_QUESTIONS } from './taxonomy';
import { buildAssetState } from '../schema/asset-state';

function fakeResponse(status: number, body: unknown, text = JSON.stringify(body)) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  } as Response;
}

function toolResponseBody(answers: Record<string, Array<{ value: string; probability: number }>>) {
  return {
    content: [{ type: 'tool_use', name: 'answer_jev_questions', input: answers }],
    usage: { input_tokens: 120, output_tokens: 40 },
  };
}

const assetState = buildAssetState({
  assetId: 'asset1',
  sha256: 'asset1',
  mediaType: 'video',
  sourcePaths: ['hpit03_finals/clip1.mp4', '/Volumes/bryan/hpit03_finals/clip1.mp4'],
  observations: [{ provider: 'twelvelabs', kind: 'video_understanding', status: 'READY', summary: 'a live set clip' }],
});

test('one request answers all six questions and caches them per asset', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const answers: Record<string, Array<{ value: string; probability: number }>> = {};
  for (const q of JEV_QUESTIONS) answers[q.id] = [{ value: q.choices[0] || 'none-detected', probability: 0.95 }];

  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return fakeResponse(200, toolResponseBody(answers));
  };
  const provider = new AnthropicJevProvider('sk-test', 'claude-sonnet-5', fetchImpl);

  const pillar = await provider.decide(assetState, 'Which content pillar does this artifact belong to?', []);
  const series = await provider.decide(assetState, 'Which posting series could publish this artifact?', []);

  assert.equal(calls.length, 1, 'only one Anthropic request for both questions on the same asset');
  assert.equal(pillar[0].value, answers.pillar[0].value);
  assert.equal(series[0].value, answers.series[0].value);

  const [{ url, init }] = calls;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal((init.headers as Record<string,string>)['x-api-key'], 'sk-test');
  assert.equal((init.headers as Record<string,string>)['anthropic-version'], '2023-06-01');
  const body = JSON.parse(init.body as string);
  assert.equal('temperature' in body, false, 'claude-sonnet-5 rejects temperature (400 deprecated)');
  assert.equal(body.tool_choice.name, 'answer_jev_questions');
  assert.equal(body.tools[0].input_schema.required.length, JEV_QUESTIONS.length);
});

test('never sends an absolute NAS path as evidence', async () => {
  let sentBody: any = null;
  const answers: Record<string, Array<{ value: string; probability: number }>> = {};
  for (const q of JEV_QUESTIONS) answers[q.id] = [{ value: 'unknown', probability: 0.7 }];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return fakeResponse(200, toolResponseBody(answers));
  };
  const provider = new AnthropicJevProvider('sk-test', 'claude-sonnet-5', fetchImpl);
  await provider.decideAll(assetState);

  const evidenceText: string = sentBody.messages[0].content;
  assert.ok(!evidenceText.includes('/Volumes/bryan'), 'absolute NAS path leaked into the Jev request');
  assert.ok(evidenceText.includes('hpit03_finals/clip1.mp4'), 'relative source path is legitimate evidence');
});

test('normalizes probabilities and drops malformed candidates', async () => {
  const answers: Record<string, Array<{ value?: string; probability?: number }>> = {};
  for (const q of JEV_QUESTIONS) answers[q.id] = [{ value: 'x', probability: 5 }, { value: '', probability: 0.5 }, { probability: 'nope' as any }];
  const fetchImpl = async () => fakeResponse(200, toolResponseBody(answers as any));
  const provider = new AnthropicJevProvider('sk-test', 'claude-sonnet-5', fetchImpl);

  const result = await provider.decideAll(assetState);
  assert.equal(result.pillar.length, 1, 'blank value and non-numeric probability are dropped');
  assert.equal(result.pillar[0].probability, 1, 'probability above 1 is clamped');
});

test('an open-ended question with no evidence still returns a recordable choice', async () => {
  const answers: Record<string, Array<{ value: string; probability: number }>> = {};
  for (const q of JEV_QUESTIONS) answers[q.id] = q.id === 'entities' ? [] : [{ value: 'unknown', probability: 0.7 }];
  const fetchImpl = async () => fakeResponse(200, toolResponseBody(answers));
  const provider = new AnthropicJevProvider('sk-test', 'claude-sonnet-5', fetchImpl);

  const result = await provider.decideAll(assetState);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].value, 'none-detected');
});

test('a non-OK response is a thrown error, not a silent empty result', async () => {
  const fetchImpl = async () => fakeResponse(500, { error: 'boom' }, 'internal error');
  const provider = new AnthropicJevProvider('sk-test', 'claude-sonnet-5', fetchImpl);
  await assert.rejects(() => provider.decideAll(assetState), /Jev request failed: 500/);
});

test('a response missing the forced tool call is a thrown error', async () => {
  const fetchImpl = async () => fakeResponse(200, { content: [{ type: 'text', text: 'no tool call' }] });
  const provider = new AnthropicJevProvider('sk-test', 'claude-sonnet-5', fetchImpl);
  await assert.rejects(() => provider.decideAll(assetState), /did not include the expected tool call/);
});

test('an unconfigured provider (no API key) refuses to call out', async () => {
  const fetchImpl = async () => { throw new Error('should never be called'); };
  const provider = new AnthropicJevProvider(undefined, 'claude-sonnet-5', fetchImpl);
  assert.equal(provider.configured, false);
  await assert.rejects(() => provider.decideAll(assetState), /ANTHROPIC_API_KEY is missing/);
});
