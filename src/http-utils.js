const querystring = require('querystring');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, payload) {
  setCorsHeaders(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(contentType, body) {
  if (!body) {
    return {};
  }
  const type = String(contentType || '').toLowerCase();
  if (type.includes('application/json')) {
    return JSON.parse(body);
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return querystring.parse(body);
  }
  try {
    return JSON.parse(body);
  } catch (_) {
    return { title: body };
  }
}

async function getRequestData(req) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const query = Object.fromEntries(url.searchParams.entries());
  if (req.method === 'GET' || req.method === 'HEAD') {
    return query;
  }
  const body = await readBody(req, 1024 * 1024);
  return {
    ...query,
    ...parseBody(req.headers['content-type'], body),
  };
}

module.exports = {
  getRequestData,
  sendJson,
  sendText,
  setCorsHeaders,
};
