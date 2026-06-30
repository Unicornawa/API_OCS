const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function boolValue(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig() {
  const fileEnv = parseEnvFile(path.join(rootDir, '.env'));
  const env = { ...fileEnv, ...process.env };
  const host = env.TIKU_HOST || '127.0.0.1';
  const port = numberValue(env.TIKU_PORT, 8787);
  const publicBaseUrl = (env.TIKU_PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/+$/, '');
  return {
    rootDir,
    host,
    port,
    publicBaseUrl,
    accessToken: env.TIKU_ACCESS_TOKEN || '',
    requestType: ['fetch', 'GM_xmlhttpRequest'].includes(env.TIKU_REQUEST_TYPE)
      ? env.TIKU_REQUEST_TYPE
      : 'fetch',
    apiBaseUrl: (env.AI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env.AI_API_KEY || env.OPENAI_API_KEY || '',
    model: env.AI_MODEL || 'gpt-4o-mini',
    temperature: numberValue(env.AI_TEMPERATURE, 0),
    maxTokens: numberValue(env.AI_MAX_TOKENS, 700),
    timeoutMs: numberValue(env.AI_TIMEOUT_MS, 45000),
    forceAnswer: boolValue(env.AI_FORCE_ANSWER, true),
    cacheEnabled: boolValue(env.TIKU_CACHE_ENABLED, true),
    cacheOnlyConfirmed: boolValue(env.TIKU_CACHE_ONLY_CONFIRMED, false),
    saveAiResults: boolValue(env.TIKU_SAVE_AI_RESULTS, true),
    answerMode: env.TIKU_ANSWER_MODE || 'direct',
    cacheFile: env.TIKU_CACHE_FILE || path.join(rootDir, 'data', 'cache.json'),
  };
}

module.exports = {
  loadConfig,
  rootDir,
};
