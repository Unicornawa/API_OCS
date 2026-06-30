const http = require('http');
const { loadConfig } = require('./src/env');
const { CacheStore } = require('./src/cache');
const { askAi } = require('./src/ai');
const { buildOcsAnswererConfig } = require('./src/ocs-config');
const {
  createQuestionKey,
  formatAnswerForOcs,
  normalizeAiResult,
  normalizeQuestionPayload,
} = require('./src/normalize');
const {
  getRequestData,
  sendJson,
  sendText,
  setCorsHeaders,
} = require('./src/http-utils');

const config = loadConfig();
const cache = new CacheStore(config.cacheFile);

function getRequestToken(req, data) {
  const headerToken = req.headers['x-access-token'] || req.headers.authorization;
  const queryToken = data && (data.token || data.access_token);
  if (headerToken && String(headerToken).toLowerCase().startsWith('bearer ')) {
    return String(headerToken).slice(7).trim();
  }
  return headerToken || queryToken || '';
}

function checkAccess(req, data) {
  if (!config.accessToken) {
    return true;
  }
  return getRequestToken(req, data) === config.accessToken;
}

function getRecordAnswer(record) {
  return formatAnswerForOcs(record.answerList || record.answer);
}

async function handleAnswer(req, res) {
  const data = await getRequestData(req);
  if (!checkAccess(req, data)) {
    sendJson(res, 401, { code: 0, msg: 'invalid access token' });
    return;
  }

  const question = normalizeQuestionPayload(data);
  if (!question.title) {
    sendJson(res, 400, { code: 0, msg: 'missing title' });
    return;
  }

  const key = createQuestionKey(question);
  const existing = config.cacheEnabled ? cache.get(key) : undefined;
  const cachedAnswer = existing ? getRecordAnswer(existing) : '';
  if (existing && cachedAnswer && (!config.cacheOnlyConfirmed || existing.status === 'confirmed')) {
    cache.touch(key);
    sendJson(res, 200, {
      code: 1,
      question: existing.question.title,
      answer: cachedAnswer,
      answerList: existing.answerList || [existing.answer].filter(Boolean),
      explanation: existing.explanation || '',
      confidence: existing.confidence || 0,
      cached: true,
      key,
      status: existing.status || 'ai',
    });
    return;
  }

  try {
    const aiResponse = await askAi(config, question);
    const normalized = normalizeAiResult(aiResponse.content, question, {
      forceAnswer: config.forceAnswer,
    });
    const answer = formatAnswerForOcs(normalized.answerList);
    const record = {
      key,
      question,
      answer,
      answerList: normalized.answerList,
      answerText: normalized.answerText,
      type: normalized.type,
      explanation: normalized.explanation,
      confidence: normalized.confidence,
      needsReview: normalized.needsReview,
      status: normalized.needsReview ? 'review' : 'ai',
      model: config.model,
      raw: config.saveAiResults ? aiResponse.raw : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hits: 0,
    };

    if (config.cacheEnabled) {
      cache.set(key, record);
    }

    sendJson(res, 200, {
      code: 1,
      question: question.title,
      answer,
      answerList: normalized.answerList,
      answerText: normalized.answerText,
      explanation: normalized.explanation,
      confidence: normalized.confidence,
      cached: false,
      key,
      status: record.status,
      needsReview: normalized.needsReview,
    });
  } catch (error) {
    sendJson(res, 500, {
      code: 0,
      msg: error.message || String(error),
      question: question.title,
      key,
    });
  }
}

async function handleCacheList(req, res) {
  const data = await getRequestData(req);
  if (!checkAccess(req, data)) {
    sendJson(res, 401, { code: 0, msg: 'invalid access token' });
    return;
  }
  const limit = Number(data.limit || 100);
  sendJson(res, 200, {
    code: 1,
    count: cache.count(),
    items: cache.list(Number.isFinite(limit) && limit > 0 ? limit : 100),
  });
}

async function handleCacheReview(req, res) {
  const data = await getRequestData(req);
  if (!checkAccess(req, data)) {
    sendJson(res, 401, { code: 0, msg: 'invalid access token' });
    return;
  }
  if (!data.key) {
    sendJson(res, 400, { code: 0, msg: 'missing key' });
    return;
  }
  const current = cache.get(data.key);
  if (!current) {
    sendJson(res, 404, { code: 0, msg: 'cache item not found' });
    return;
  }
  const answerList = Array.isArray(data.answer)
    ? data.answer.map(String)
    : String(data.answer || '').split(/[|#,\n]/).map((item) => item.trim()).filter(Boolean);
  const next = {
    ...current,
    answer: formatAnswerForOcs(answerList.length > 0 ? answerList : current.answerList),
    answerList: answerList.length > 0 ? answerList : current.answerList,
    status: data.status || 'confirmed',
    note: data.note || current.note || '',
    updatedAt: new Date().toISOString(),
  };
  cache.set(data.key, next);
  sendJson(res, 200, { code: 1, item: next });
}

function handleOcsConfig(req, res) {
  const answerer = buildOcsAnswererConfig(config);
  sendJson(res, 200, { code: 1, answerer, text: JSON.stringify([answerer], null, 2) });
}

async function route(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (pathname === '/') {
      sendText(res, 200, 'OCS AI tiku adapter is running.');
      return;
    }
    if (pathname === '/health') {
      sendJson(res, 200, {
        code: 1,
        name: 'ocs-ai-tiku-adapter',
        model: config.model,
        cacheEnabled: config.cacheEnabled,
        cacheCount: cache.count(),
      });
      return;
    }
    if (pathname === '/ocs/config') {
      handleOcsConfig(req, res);
      return;
    }
    if (pathname === '/ocs/answer' || pathname === '/api/search' || pathname === '/search') {
      await handleAnswer(req, res);
      return;
    }
    if (pathname === '/cache') {
      await handleCacheList(req, res);
      return;
    }
    if (pathname === '/cache/review') {
      await handleCacheReview(req, res);
      return;
    }
    sendJson(res, 404, { code: 0, msg: 'not found' });
  } catch (error) {
    sendJson(res, 500, { code: 0, msg: error.message || String(error) });
  }
}

const server = http.createServer(route);

server.listen(config.port, config.host, () => {
  const answerer = buildOcsAnswererConfig(config);
  console.log(`OCS AI tiku adapter: http://${config.host}:${config.port}`);
  console.log(`Answer endpoint: ${config.publicBaseUrl}/ocs/answer`);
  console.log('AnswererWrapper:');
  console.log(JSON.stringify([answerer], null, 2));
});
