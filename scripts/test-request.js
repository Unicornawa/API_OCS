const http = require('http');
const { loadConfig } = require('../src/env');

const config = loadConfig();
const body = JSON.stringify({
  title: '地理学的对象是什么？',
  type: 'single',
  options: 'A. 地理环境\nB. 地理法则\nC. 经济规律\nD. 人口数量',
  token: config.accessToken || undefined,
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
}, (res) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    console.log(Buffer.concat(chunks).toString('utf8'));
  });
});

req.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

req.write(body);
req.end();
