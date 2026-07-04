const crypto = require('crypto');
const { inferQuestionKind, stripQuestionPrefix } = require('./domain');

const TRUE_TEXT = '\u6B63\u786E';
const FALSE_TEXT = '\u9519\u8BEF';
const UNKNOWN_TEXT = '\u65E0\u6CD5\u786E\u5B9A';

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOptions(options) {
  if (!options) {
    return [];
  }
  if (Array.isArray(options)) {
    return options.map((item, index) => normalizeOptionItem(item, index)).filter(Boolean);
  }
  if (typeof options === 'object') {
    return Object.keys(options).map((key) => ({
      label: cleanText(key).toUpperCase(),
      text: cleanText(options[key]),
    })).filter((item) => item.label || item.text);
  }
  const raw = String(options).trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return normalizeOptions(parsed);
  } catch (_) {
    return splitOptionText(raw)
      .map((line, index) => normalizeOptionItem(line, index))
      .filter(Boolean);
  }
}

function splitOptionText(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    return lines;
  }

  const matches = [];
  const markerPattern = /(^|[\s\r\n])([A-Ha-h])[\.\)\u3001:\uFF1A]\s*/g;
  let match;
  while ((match = markerPattern.exec(text)) !== null) {
    matches.push({
      start: match.index + match[1].length,
      label: match[2].toUpperCase(),
    });
  }

  if (matches.length <= 1) {
    return lines;
  }

  return matches.map((item, index) => {
    const next = matches[index + 1];
    return text.slice(item.start, next ? next.start : text.length).trim();
  });
}

function normalizeOptionItem(item, index) {
  if (item === undefined || item === null) {
    return undefined;
  }
  if (typeof item === 'object') {
    const label = cleanText(item.label || item.key || item.value || String.fromCharCode(65 + index));
    const text = cleanText(item.text || item.title || item.name || item.content || item.option || '');
    return { label: label.toUpperCase(), text };
  }
  const text = cleanText(item);
  if (!text) {
    return undefined;
  }
  const matched = text.match(/^([A-Ha-h])[\.\)\u3001:\uFF1A\s]+(.+)$/);
  if (matched) {
    return { label: matched[1].toUpperCase(), text: cleanText(matched[2]) };
  }
  return { label: String.fromCharCode(65 + index), text };
}

function normalizeQuestionPayload(data) {
  const title = cleanText(data.title || data.question || data.name || '');
  return {
    title,
    cleanedTitle: cleanText(stripQuestionPrefix(title) || title),
    type: cleanText(data.type || data.questionType || ''),
    options: normalizeOptions(data.options || data.option || data.choices || ''),
    rawOptions: data.options || data.option || data.choices || '',
  };
}

function createQuestionKey(question) {
  const stable = {
    title: cleanText(question.title),
    type: cleanText(question.type),
    options: question.options.map((item) => ({
      label: cleanText(item.label),
      text: cleanText(item.text),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

function extractJson(text) {
  const content = String(text || '').trim();
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    return JSON.parse(fence[1]);
  }
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(content.slice(start, end + 1));
  }
  throw new Error('AI response is not valid JSON');
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[|#,\n\uFF0C\u3001]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitCompactOptionLabels(value, validLabels) {
  const text = String(value || '').trim().toUpperCase();
  if (!text || !validLabels.length) {
    return [];
  }
  if (/^[A-H]{2,}$/.test(text)) {
    return text.split('').filter((label) => validLabels.includes(label));
  }
  return [];
}

function getJudgeAnswerFromText(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) {
    return '';
  }
  if (/错误|不正确|不对|错|false|no|否/.test(text)) {
    return FALSE_TEXT;
  }
  if (/正确|对|true|yes|是/.test(text)) {
    return TRUE_TEXT;
  }
  return '';
}

function getJudgeAnswerFromOption(question, label) {
  const upper = cleanText(label).toUpperCase();
  const option = (question.options || []).find((item) => item.label === upper);
  if (!option) {
    return '';
  }
  return getJudgeAnswerFromText(option.text) || cleanText(option.text);
}

function normalizeAnswerListForQuestion(answerList, question) {
  const validLabels = (question.options || []).map((item) => item.label).filter(Boolean);
  if (validLabels.length === 0) {
    return answerList;
  }

  const normalized = [];
  for (const item of answerList) {
    const text = cleanText(item);
    const upper = text.toUpperCase();
    const compact = splitCompactOptionLabels(upper, validLabels);
    if (compact.length) {
      normalized.push(...compact);
      continue;
    }
    const prefixed = upper.match(/^(?:\u9009\u9879|\u7B2C)?\s*([A-H])(?:\s*[\.\)\u3001:\uFF1A]|\s*\u9879|\s*$)/);
    if (prefixed && validLabels.includes(prefixed[1])) {
      normalized.push(prefixed[1]);
      continue;
    }
    if (validLabels.includes(upper)) {
      normalized.push(upper);
      continue;
    }
    const byText = question.options.find((option) => option.text && cleanText(option.text) === text);
    if (byText) {
      normalized.push(byText.label);
    }
  }

  return Array.from(new Set(normalized));
}

function normalizeOptionAnalysis(value, question) {
  const validLabels = (question.options || []).map((item) => item.label).filter(Boolean);
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const label = cleanText(item.label || item.option || item.key || '').toUpperCase();
    if (!validLabels.includes(label)) {
      return undefined;
    }
    const correctValue = item.correct ?? item.isCorrect ?? item.verdict ?? item.result;
    const correctText = String(correctValue || '').toLowerCase();
    const correct = correctValue === true ||
      /true|yes|correct|\u6B63\u786E|\u5BF9|\u662F/.test(correctText);
    const confidence = Number(item.confidence);
    return {
      label,
      correct,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reason: cleanText(item.reason || item.explanation || ''),
    };
  }).filter(Boolean);
}

function pickSingleFromAnalysis(optionAnalysis, fallbackList) {
  const positive = optionAnalysis
    .filter((item) => item.correct)
    .sort((a, b) => b.confidence - a.confidence);
  if (positive[0]) {
    return [positive[0].label];
  }
  const ranked = optionAnalysis.slice().sort((a, b) => b.confidence - a.confidence);
  if (ranked[0]) {
    return [ranked[0].label];
  }
  return fallbackList.slice(0, 1);
}

function enforceAnswerShape(answerList, question, optionAnalysis) {
  const kind = inferQuestionKind(question);
  const validLabels = (question.options || []).map((item) => item.label).filter(Boolean);
  const originalList = Array.from(new Set(answerList));
  let list = originalList.slice();

  if (kind === 'judge') {
    for (const item of originalList) {
      const directAnswer = getJudgeAnswerFromText(item);
      if (directAnswer) {
        return { kind, answerList: [directAnswer] };
      }
      const optionAnswer = getJudgeAnswerFromOption(question, item);
      if (optionAnswer) {
        return { kind, answerList: [optionAnswer] };
      }
    }

    const positive = optionAnalysis
      .filter((item) => item.correct)
      .sort((a, b) => b.confidence - a.confidence);
    for (const item of positive) {
      const optionAnswer = getJudgeAnswerFromOption(question, item.label);
      if (optionAnswer) {
        return { kind, answerList: [optionAnswer] };
      }
    }

    const joinedAnswer = getJudgeAnswerFromText(originalList.join(' '));
    if (joinedAnswer) {
      return { kind, answerList: [joinedAnswer] };
    }

    return { kind, answerList: originalList.slice(0, 1) };
  }

  if (validLabels.length > 0) {
    list = list.filter((item) => validLabels.includes(String(item).toUpperCase()));
  }

  if (kind === 'single') {
    if (validLabels.length === 0 && list.every((item) => /^[A-H]$/i.test(String(item)))) {
      return { kind, answerList: [] };
    }
    return {
      kind,
      answerList: list.length > 1 ? pickSingleFromAnalysis(optionAnalysis, list) : list.slice(0, 1),
    };
  }

  if (kind === 'multiple') {
    if (validLabels.length === 0 && list.every((item) => /^[A-H]$/i.test(String(item)))) {
      return { kind, answerList: [] };
    }
    if (list.length > 0) {
      return { kind, answerList: list };
    }
    const positive = optionAnalysis.filter((item) => item.correct).map((item) => item.label);
    return { kind, answerList: Array.from(new Set(positive)) };
  }

  return { kind, answerList: answerList };
}

function looksLikeJudgeQuestion(question) {
  const type = `${question.type} ${question.title}`.toLowerCase();
  return /judge|true|false|tf|\u5224\u65AD|\u6B63\u8BEF|\u5BF9\u9519/.test(type);
}

function inferAnswerListFromText(content, question, forceAnswer) {
  const text = cleanText(content);
  const upper = text.toUpperCase();
  const validLabels = question.options.map((item) => item.label).filter(Boolean);

  if (validLabels.length > 0) {
    const compact = splitCompactOptionLabels(upper, validLabels);
    if (compact.length) {
      return Array.from(new Set(compact));
    }

    const labelMatches = Array.from(new Set((upper.match(/\b[A-H]\b/g) || [])
      .filter((label) => validLabels.includes(label))));
    if (labelMatches.length > 0) {
      return labelMatches;
    }

    const matchedOption = question.options.find((item) => {
      return item.text && text.includes(item.text);
    });
    if (matchedOption) {
      return [matchedOption.label];
    }

    return forceAnswer && validLabels[0] ? [validLabels[0]] : [];
  }

  if (looksLikeJudgeQuestion(question)) {
    if (/(\u6B63\u786E|\u5BF9|true|yes|\u662F)/i.test(text)) {
      return [TRUE_TEXT];
    }
    if (/(\u9519\u8BEF|\u9519|false|no|\u5426)/i.test(text)) {
      return [FALSE_TEXT];
    }
    return forceAnswer ? [TRUE_TEXT] : [];
  }

  const answerLine = text.match(/(?:answer|result|ans)\s*[:\uFF1A]\s*(.+)$/i);
  if (answerLine && answerLine[1]) {
    return [cleanText(answerLine[1]).slice(0, 200)];
  }

  if (text) {
    return [text.slice(0, 200)];
  }
  return forceAnswer ? [UNKNOWN_TEXT] : [];
}

function normalizeAiResult(content, question, options = {}) {
  const forceAnswer = Boolean(options.forceAnswer);
  let parsed;
  let parseError = '';
  try {
    parsed = extractJson(content);
  } catch (error) {
    parseError = error.message || String(error);
    const inferred = inferAnswerListFromText(content, question, forceAnswer);
    const shaped = enforceAnswerShape(
      normalizeAnswerListForQuestion(inferred, question),
      question,
      []
    );
    return {
      answerList: shaped.answerList,
      answerText: inferred,
      type: shaped.kind || question.type || '',
      inferredKind: shaped.kind,
      optionAnalysis: [],
      explanation: cleanText(content).slice(0, 500),
      confidence: shaped.answerList.length > 0 ? 0.35 : 0,
      needsReview: true,
      parseError,
    };
  }

  const answerList = asList(parsed.answer || parsed.answers || parsed.result);
  const answerText = asList(parsed.answerText || parsed.answer_text || parsed.text);
  const optionAnalysis = normalizeOptionAnalysis(
    parsed.optionAnalysis || parsed.option_analysis || parsed.optionsAnalysis || parsed.options,
    question
  );
  if (answerList.length === 0 && answerText.length > 0) {
    answerList.push(...answerText);
  }
  if (answerList.length === 0 && forceAnswer) {
    answerList.push(...inferAnswerListFromText(content, question, true));
  }
  if (answerList.length === 0 && forceAnswer) {
    answerList.push(UNKNOWN_TEXT);
  }
  const finalAnswerList = normalizeAnswerListForQuestion(answerList, question);
  const shaped = enforceAnswerShape(finalAnswerList.length > 0 ? finalAnswerList : answerList, question, optionAnalysis);
  const answerListForReturn = shaped.answerList;

  return {
    answerList: answerListForReturn,
    answerText,
    optionAnalysis,
    type: parsed.type || shaped.kind || question.type || '',
    inferredKind: shaped.kind,
    explanation: cleanText(parsed.explanation || parsed.reason || parsed.analysis || ''),
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    needsReview: Boolean(parsed.needsReview || parsed.needs_review || answerListForReturn.length === 0),
  };
}

function formatAnswerForOcs(answer) {
  const list = Array.isArray(answer) ? answer : asList(answer);
  if (list.length <= 1) {
    return list[0] || '';
  }
  if (list.every((item) => /^[A-H]$/i.test(item))) {
    return list.map((item) => item.toUpperCase()).join('');
  }
  return list.join('#');
}

module.exports = {
  cleanText,
  createQuestionKey,
  formatAnswerForOcs,
  normalizeAiResult,
  normalizeAnswerListForQuestion,
  normalizeOptions,
  splitOptionText,
  normalizeQuestionPayload,
  enforceAnswerShape,
};
