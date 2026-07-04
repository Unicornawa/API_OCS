const http = require('http');
const https = require('https');
const { detectDomain, inferQuestionKind } = require('./domain');

function buildChatEndpoint(apiBaseUrl) {
  if (/\/chat\/completions\/?$/.test(apiBaseUrl)) {
    return apiBaseUrl.replace(/\/+$/, '');
  }
  return `${apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function postJson(urlString, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const transport = url.protocol === 'http:' ? http : https;
    const request = transport.request({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = undefined;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`AI API HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        resolve({ json, text });
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`AI API timeout after ${timeoutMs}ms`));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function getDomainRules(domain) {
  const common = [
    'Ignore question id prefixes such as JBXZ02-10A*. They are identifiers, not answer clues.',
    'For choice questions, judge every option independently before choosing the final answer.',
    'Return only option labels that exist in Options.',
    'Do not choose a label just because that letter appears in the question id, title, or reasoning.',
    'If two options look similar, compare exact wording and scope words such as always, only, all, not, usually.',
    'If the title asks for incorrect/not true/not belong/except (\u9519\u8BEF, \u4E0D\u6B63\u786E, \u4E0D\u5C5E\u4E8E, \u9664\u5916, except), select the option(s) that satisfy that negative request, not the true statements.',
  ];
  const rules = {
    definition: [
      'This is likely a concept or definition question.',
      'Prefer textbook-standard definitions over casual wording.',
      'For "which statement is correct/incorrect" questions, evaluate each statement literally.',
    ],
    math: [
      'This is likely a mathematics question.',
      'Carry out algebra, calculus, probability, or geometry reasoning before selecting options.',
      'For numeric answers, compute first, then match the computed result to the closest option text.',
      'Pay attention to domains, signs, units, edge cases, and "not correct" wording.',
    ],
    physics: [
      'This is likely a physics question.',
      'Identify the physical model, list the relevant formula or law, then compare each option.',
      'Check units, direction, limiting cases, and whether the statement is conditional.',
      'For conceptual physics, use standard definitions from mechanics, thermodynamics, electromagnetism, optics, and modern physics.',
      'For contact angle/wetting questions: smaller contact angle generally means better wetting; contact angle below 90 degrees is commonly treated as wetting.',
    ],
    general: [
      'This is a general course question.',
      'Use the provided options and avoid relying on hidden context.',
    ],
  };
  return [...common, ...(rules[domain] || rules.general)];
}

function getHardQuestionRules(domain) {
  if (!['math', 'physics'].includes(domain)) {
    return [];
  }
  return [
    'This is a high-risk calculation/concept question. Work out the solution internally before choosing any option.',
    'Check signs, units, dimensions, boundary cases, and negative wording before the final answer.',
    'For numeric questions, compute the target quantity first, then match it to the closest equivalent option.',
    'For formula questions, verify that each symbol and condition matches the question, not just a familiar-looking formula.',
    'Keep the final JSON compact: brief explanation only, no step-by-step derivation.',
  ];
}

function buildPrompt(question, config, opts = {}) {
  const domain = opts.domain || detectDomain(question);
  const kind = inferQuestionKind(question);
  const optionsText = question.options.length
    ? question.options.map((item) => `${item.label}. ${item.text}`).join('\n')
    : '(no options)';
  const forceAnswerRules = config.forceAnswer
    ? [
        'You must return the most likely answer even when uncertain.',
        'If uncertain, set confidence below 0.5 and needsReview to true, but keep answer non-empty.',
        'Only return an empty answer if the question title itself is empty or unreadable.',
      ]
    : [
        'If the question lacks enough information, return an empty answer array and set needsReview to true.',
      ];
  const verifierContext = opts.candidates && opts.candidates.length
    ? [
        '',
        'Candidate answers from independent attempts:',
        JSON.stringify(opts.candidates),
        'Re-evaluate from scratch. If a candidate is wrong, reject it. Return the final corrected answer.',
      ]
    : [];
  return [
    'You must answer course questions accurately. Output valid JSON only. Do not output Markdown.',
    'JSON schema: {"answer":["A"],"answerText":["option text"],"type":"single|multiple|judge|blank|short","optionAnalysis":[{"label":"A","correct":true,"confidence":0.9,"reason":"brief"}],"confidence":0.0,"explanation":"brief reason","needsReview":false}.',
    'answer must be an array.',
    'For single-choice questions, return exactly one option label, such as ["A"].',
    'For multiple-choice questions, return all correct option labels, such as ["A","C"].',
    'For true/false questions, return ["\\u6B63\\u786E"] or ["\\u9519\\u8BEF"].',
    'For fill-in or short-answer questions, return concise text.',
    ...forceAnswerRules,
    ...getDomainRules(domain),
    ...getHardQuestionRules(domain),
    `The adapter inferred question kind as: ${kind}. Obey this unless the given question type clearly contradicts it.`,
    'For choice questions, optionAnalysis must contain every provided option label exactly once.',
    'For single-choice questions, exactly one optionAnalysis item should be correct=true.',
    'For multiple-choice questions, every and only correct option should have correct=true.',
    ...verifierContext,
    '',
    `Detected domain: ${domain}`,
    `Inferred question kind: ${kind}`,
    `Question type: ${question.type || 'unknown'}`,
    `Original title: ${question.title}`,
    `Clean title: ${question.cleanedTitle || question.title}`,
    `Options:\n${optionsText}`,
  ].join('\n');
}

function buildPayload(config, question, opts = {}) {
  const payload = {
    model: config.model,
    temperature: opts.temperature !== undefined ? opts.temperature : config.temperature,
    max_tokens: config.maxTokens,
    messages: [
      {
        role: 'system',
        content: 'You are a rigorous university course question solver. You must solve carefully, match final answers to the provided options, and return JSON only.',
      },
      {
        role: 'user',
        content: buildPrompt(question, config, opts),
      },
    ],
  };
  if (config.jsonMode) {
    payload.response_format = { type: 'json_object' };
  }
  if (config.thinkingType) {
    payload.thinking = { type: config.thinkingType };
  }
  return payload;
}

function extractContent(response, config) {
  const choice = response.json && response.json.choices && response.json.choices[0];
  const message = choice && choice.message;
  const content = String((message && message.content) || choice && choice.text || '').trim();
  const reasoningContent = String((message && (message.reasoning_content || message.reasoning)) || '').trim();
  if (!choice) {
    throw new Error(`AI API response missing choices[0]: ${response.text.slice(0, 500)}`);
  }
  if (!content && config.useReasoningContent) {
    return {
      content: reasoningContent,
      raw: response.json,
      reasoningContent,
      usedReasoningContent: true,
    };
  }
  return {
    content,
    raw: response.json,
    reasoningContent,
  };
}

async function askAiOnce(config, question, opts = {}) {
  const endpoint = buildChatEndpoint(config.apiBaseUrl);
  const headers = {};
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const response = await postJson(endpoint, headers, buildPayload(config, question, opts), config.timeoutMs);
  return extractContent(response, config);
}

async function askAi(config, question, opts = {}) {
  return askAiOnce(config, question, opts);
}

module.exports = {
  askAi,
  askAiOnce,
  buildChatEndpoint,
  buildPayload,
  buildPrompt,
  detectDomain,
};
