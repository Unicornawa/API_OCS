const crypto = require('crypto');

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
    return raw
      .split(/\r?\n|(?=\b[A-H][\.\)\u3001:\uFF1A]\s*)/)
      .map((line, index) => normalizeOptionItem(line, index))
      .filter(Boolean);
  }
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
  return {
    title: cleanText(data.title || data.question || data.name || ''),
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

function looksLikeJudgeQuestion(question) {
  const type = `${question.type} ${question.title}`.toLowerCase();
  return /judge|true|false|tf|\u5224\u65AD|\u6B63\u8BEF|\u5BF9\u9519/.test(type);
}

function inferAnswerListFromText(content, question, forceAnswer) {
  const text = cleanText(content);
  const upper = text.toUpperCase();
  const validLabels = question.options.map((item) => item.label).filter(Boolean);

  if (validLabels.length > 0) {
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
    return {
      answerList: inferred,
      answerText: inferred,
      type: question.type || '',
      explanation: cleanText(content).slice(0, 500),
      confidence: inferred.length > 0 ? 0.35 : 0,
      needsReview: true,
      parseError,
    };
  }

  const answerList = asList(parsed.answer || parsed.answers || parsed.result);
  const answerText = asList(parsed.answerText || parsed.answer_text || parsed.text);
  if (answerList.length === 0 && answerText.length > 0) {
    answerList.push(...answerText);
  }
  if (answerList.length === 0 && forceAnswer) {
    answerList.push(...inferAnswerListFromText(content, question, true));
  }
  if (answerList.length === 0 && forceAnswer) {
    answerList.push(UNKNOWN_TEXT);
  }

  return {
    answerList,
    answerText,
    type: parsed.type || question.type || '',
    explanation: cleanText(parsed.explanation || parsed.reason || parsed.analysis || ''),
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    needsReview: Boolean(parsed.needsReview || parsed.needs_review || answerList.length === 0),
  };
}

function formatAnswerForOcs(answer) {
  const list = Array.isArray(answer) ? answer : asList(answer);
  if (list.length <= 1) {
    return list[0] || '';
  }
  return list.join('#');
}

module.exports = {
  cleanText,
  createQuestionKey,
  formatAnswerForOcs,
  normalizeAiResult,
  normalizeOptions,
  normalizeQuestionPayload,
};
