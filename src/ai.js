const http = require('http');
const https = require('https');

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

function buildPrompt(question, config) {
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
  return [
    'Answer the question and output JSON only. Do not output Markdown.',
    'JSON fields: answer, answerText, type, confidence, explanation, needsReview.',
    'answer must be an array.',
    'For single-choice questions, return labels such as ["A"].',
    'For multiple-choice questions, return labels such as ["A","C"].',
    'For true/false questions, return ["\\u6B63\\u786E"] or ["\\u9519\\u8BEF"].',
    'For fill-in or short-answer questions, return a concise textual answer.',
    ...forceAnswerRules,
    '',
    `Question type: ${question.type || 'unknown'}`,
    `Question title: ${question.title}`,
    `Options:\n${optionsText}`,
  ].join('\n');
}

async function askAi(config, question) {
  const endpoint = buildChatEndpoint(config.apiBaseUrl);
  const headers = {};
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const payload = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    messages: [
      {
        role: 'system',
        content: 'You are a rigorous university course question assistant. Return concise structured answers. When unsure, still provide the most likely candidate if force-answer is requested, and mark needsReview.',
      },
      {
        role: 'user',
        content: buildPrompt(question, config),
      },
    ],
  };
  const response = await postJson(endpoint, headers, payload, config.timeoutMs);
  const choice = response.json && response.json.choices && response.json.choices[0];
  const message = choice && choice.message;
  const content = [
    message && message.content,
    message && message.reasoning_content,
    message && message.reasoning,
    choice && choice.text,
  ].map((value) => String(value || '').trim()).find(Boolean) || '';

  if (!choice) {
    throw new Error(`AI API response missing choices[0]: ${response.text.slice(0, 500)}`);
  }
  return {
    content,
    raw: response.json,
  };
}

module.exports = {
  askAi,
  buildChatEndpoint,
  buildPrompt,
};
