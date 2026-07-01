const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadConfig } = require('../src/env');
const { formatAnswerForOcs } = require('../src/normalize');

const config = loadConfig();
const datasetPath = path.resolve(process.cwd(), process.argv[2] || 'data/eval.json');

function normalizeExpected(value) {
  const text = Array.isArray(value) ? formatAnswerForOcs(value) : String(value || '');
  return text
    .toUpperCase()
    .replace(/[|#,\s，、]/g, '')
    .trim();
}

function requestAnswer(item) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      title: item.title || item.question,
      type: item.type || '',
      options: item.options || '',
    });
    const req = http.request({
      method: 'POST',
      host: config.host,
      port: config.port,
      path: '/ocs/answer',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: config.timeoutMs + 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text), text });
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${text.slice(0, 300)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    console.error('Expected JSON array: [{"title":"...","type":"single","options":"A. ...\\nB. ...","answer":"A"}]');
    process.exitCode = 1;
    return;
  }

  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  if (!Array.isArray(dataset) || dataset.length === 0) {
    throw new Error('Dataset must be a non-empty JSON array');
  }

  let correct = 0;
  const rows = [];
  for (let index = 0; index < dataset.length; index += 1) {
    const item = dataset[index];
    const expected = normalizeExpected(item.answer || item.expected);
    const response = await requestAnswer(item);
    const actual = normalizeExpected(response.json && response.json.answer);
    const ok = expected && actual === expected;
    if (ok) {
      correct += 1;
    }
    rows.push({
      index: index + 1,
      ok,
      expected,
      actual,
      status: response.json && response.json.status,
      confidence: response.json && response.json.confidence,
      title: String(item.title || item.question || '').slice(0, 80),
    });
    console.log(`${ok ? 'OK ' : 'BAD'} ${index + 1}/${dataset.length} expected=${expected} actual=${actual}`);
  }

  const accuracy = correct / dataset.length;
  console.log('');
  console.log(`Accuracy: ${(accuracy * 100).toFixed(2)}% (${correct}/${dataset.length})`);
  if (accuracy < 0.9) {
    console.log('Below 90%. Inspect BAD rows and cache/raw candidate details before changing prompts again.');
  }

  const outPath = path.join(config.rootDir, 'data', `eval-result-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ accuracy, correct, total: dataset.length, rows }, null, 2), 'utf8');
  console.log(`Wrote: ${outPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
