const http = require('http');
const { loadConfig } = require('./src/env');
const { CacheStore } = require('./src/cache');
const { askAiOnce } = require('./src/ai');
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

function candidateKey(answerList) {
  return formatAnswerForOcs(answerList || []);
}

function summarizeCandidate(candidate) {
  return {
    answer: candidate.answer,
    confidence: candidate.normalized.confidence,
    needsReview: candidate.normalized.needsReview,
    explanation: candidate.normalized.explanation,
    parseError: candidate.normalized.parseError || '',
    source: candidate.source,
  };
}

function chooseBestCandidate(candidates) {
  const grouped = new Map();
  const nonVerifierAnswers = new Set(
    candidates
      .filter((candidate) => candidate.source !== 'verifier' && candidate.answer)
      .map((candidate) => candidate.answer)
  );
  for (const candidate of candidates) {
    if (!candidate.answer) {
      continue;
    }
    const current = grouped.get(candidate.answer) || {
      answer: candidate.answer,
      score: 0,
      votes: 0,
      confidenceTotal: 0,
      candidate,
    };
    const sourceWeight = candidate.source === 'verifier'
      ? nonVerifierAnswers.has(candidate.answer) ? 2.5 : 0.8
      : 1;
    const parsePenalty = candidate.normalized.parseError ? -0.5 : 0;
    const confidence = Number(candidate.normalized.confidence || 0);
    current.score += sourceWeight + confidence + parsePenalty;
    current.votes += sourceWeight;
    current.confidenceTotal += confidence;
    if (confidence > Number(current.candidate.normalized.confidence || 0) || candidate.source === 'verifier') {
      current.candidate = candidate;
    }
    grouped.set(candidate.answer, current);
  }

  const ranked = Array.from(grouped.values()).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.confidenceTotal - a.confidenceTotal;
  });
  return ranked[0] ? ranked[0].candidate : undefined;
}

async function askWithCandidates(config, question) {
  const attempts = [];
  const errors = [];
  const count = Math.max(1, config.ensembleCount || 1);
  for (let index = 0; index < count; index += 1) {
    const temperature = index === 0 ? config.temperature : Math.max(config.temperature, Math.min(0.35, 0.1 * index));
    try {
      const aiResponse = await askAiOnce(config, question, { temperature });
      const normalized = normalizeAiResult(aiResponse.content, question, {
        forceAnswer: config.forceAnswer,
      });
      attempts.push({
        source: `attempt-${index + 1}`,
        aiResponse,
        normalized,
        answer: candidateKey(normalized.answerList),
      });
    } catch (error) {
      errors.push(`attempt-${index + 1}: ${error.message || String(error)}`);
    }
  }

  const nonEmpty = attempts.filter((candidate) => candidate.answer);
  if (config.verifyAnswer && nonEmpty.length > 0) {
    try {
      const verifierResponse = await askAiOnce(config, question, {
        temperature: 0,
        candidates: nonEmpty.map(summarizeCandidate),
      });
      const normalized = normalizeAiResult(verifierResponse.content, question, {
        forceAnswer: config.forceAnswer,
      });
      attempts.push({
        source: 'verifier',
        aiResponse: verifierResponse,
        normalized,
        answer: candidateKey(normalized.answerList),
      });
    } catch (error) {
      errors.push(`verifier: ${error.message || String(error)}`);
    }
  }

  const best = chooseBestCandidate(attempts);
  if (!best) {
    throw new Error(`AI did not produce any usable answer candidate. ${errors.join('; ')}`);
  }
  return {
    best,
    candidates: attempts.map(summarizeCandidate),
    errors,
  };
}

function buildFallbackResult(question, error) {
  const normalized = normalizeAiResult('', question, {
    forceAnswer: true,
  });
  return {
    answer: formatAnswerForOcs(normalized.answerList),
    answerList: normalized.answerList,
    explanation: error ? `Fallback after AI API error: ${error.message || String(error)}` : 'Fallback answer',
    confidence: 0.01,
    needsReview: true,
  };
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
    const result = await askWithCandidates(config, question);
    const aiResponse = result.best.aiResponse;
    const normalized = result.best.normalized;
    const answer = formatAnswerForOcs(normalized.answerList);
    const lowQualityFallback = !aiResponse.content || normalized.parseError || normalized.confidence < config.cacheMinConfidence;
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
      status: lowQualityFallback ? 'fallback' : normalized.needsReview ? 'review' : 'ai',
      model: config.model,
      raw: config.saveAiResults ? {
        selected: aiResponse.raw,
        candidates: result.candidates,
        errors: result.errors,
      } : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hits: 0,
    };

    if (config.cacheEnabled && !lowQualityFallback) {
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
      parseError: normalized.parseError || '',
      candidates: result.candidates,
      candidateErrors: result.errors,
    });
  } catch (error) {
    if (!config.forceAnswer) {
      sendJson(res, 500, {
        code: 0,
        msg: error.message || String(error),
        question: question.title,
        key,
      });
      return;
    }

    const fallback = buildFallbackResult(question, error);
    const record = {
      key,
      question,
      answer: fallback.answer,
      answerList: fallback.answerList,
      answerText: fallback.answerList,
      type: question.type || '',
      explanation: fallback.explanation,
      confidence: fallback.confidence,
      needsReview: true,
      status: 'fallback',
      model: config.model,
      raw: config.saveAiResults ? { error: error.message || String(error) } : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hits: 0,
    };

    sendJson(res, 200, {
      code: 1,
      question: question.title,
      answer: fallback.answer,
      answerList: fallback.answerList,
      answerText: fallback.answerList,
      explanation: fallback.explanation,
      confidence: fallback.confidence,
      cached: false,
      key,
      status: 'fallback',
      needsReview: true,
      msg: error.message || String(error),
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
