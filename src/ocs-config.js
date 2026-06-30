function buildOcsAnswererConfig(config) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.accessToken) {
    headers['X-Access-Token'] = config.accessToken;
  }

  const directHandler = [
    'return (res) => {',
    '  if (!res || res.code !== 1) return [res && res.msg ? res.msg : "AI service error", undefined];',
    '  return [res.question, res.answer];',
    '}',
  ].join('\n');

  const reviewHandler = [
    'return (res) => {',
    '  if (!res || res.code !== 1) return [res && res.msg ? res.msg : "AI service error", undefined];',
    '  return undefined;',
    '}',
  ].join('\n');

  return {
    name: 'Local AI Tiku',
    homepage: `${config.publicBaseUrl}/health`,
    url: `${config.publicBaseUrl}/ocs/answer`,
    method: 'post',
    contentType: 'json',
    type: config.requestType,
    headers,
    data: {
      title: '${title}',
      type: '${type}',
      options: '${options}',
    },
    handler: config.answerMode === 'review' ? reviewHandler : directHandler,
  };
}

module.exports = {
  buildOcsAnswererConfig,
};
