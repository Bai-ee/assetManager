// One-off setup CLI: creates the TwelveLabs index the worker indexes videos
// into (TWELVELABS_INDEX_ID). Not run by the daemon or any automated path —
// an index is created once, by a human, before the worker is pointed at it.
//
// Optional: only for Marengo search (indexed-assets); not required for
// analysis. The worker's Jev evidence comes from Pegasus analyzeAsset, which
// needs no index — this CLI exists only if/when a search feature wants one.
//
// Usage: npm run archive:twelvelabs-index -- <index-name>

const BASE_URL = process.env.TWELVELABS_API_URL || 'https://api.twelvelabs.io/v1.3';
const MODEL_NAME = process.env.TWELVELABS_MODEL || 'marengo3.0';
const MODEL_OPTIONS = (process.env.TWELVELABS_MODEL_OPTIONS || 'visual,audio').split(',').map(s => s.trim()).filter(Boolean);

async function main() {
  const indexName = process.argv[2];
  if (!indexName) {
    console.error('Usage: npm run archive:twelvelabs-index -- <index-name>');
    process.exit(1);
  }
  const apiKey = process.env.TWELVELABS_API_KEY;
  if (!apiKey) {
    console.error('TWELVELABS_API_KEY is not set. Add it to .env.local before running this.');
    process.exit(1);
  }

  const response = await fetch(new URL('/indexes', BASE_URL), {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      index_name: indexName,
      models: [{ model_name: MODEL_NAME, model_options: MODEL_OPTIONS }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    console.error(`TwelveLabs index creation failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  const body = await response.json() as { id?: string; _id?: string };
  const indexId = body.id || body._id;
  if (!indexId) {
    console.error('TwelveLabs response did not include an index id:', JSON.stringify(body));
    process.exit(1);
  }
  console.log('Created TwelveLabs index:');
  console.log(JSON.stringify({ indexName, indexId, model: MODEL_NAME, modelOptions: MODEL_OPTIONS }, null, 2));
  console.log('\nSet TWELVELABS_INDEX_ID to this id in the worker .env.local.');
}

main().catch(error => { console.error(error); process.exit(1); });
