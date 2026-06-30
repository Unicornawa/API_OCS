const path = require('path');
const { loadConfig } = require('../src/env');
const { ensureDir, writeJsonAtomic } = require('../src/cache');
const { buildOcsAnswererConfig } = require('../src/ocs-config');

const config = loadConfig();
const answerer = buildOcsAnswererConfig(config);
const outputDir = path.join(config.rootDir, 'config');
const jsonPath = path.join(outputDir, 'ocs-answerer.json');
const textPath = path.join(outputDir, 'ocs-answerer.txt');
const text = JSON.stringify([answerer], null, 2);

ensureDir(outputDir);
writeJsonAtomic(jsonPath, [answerer]);
require('fs').writeFileSync(textPath, text, 'utf8');

console.log(text);
console.log('');
console.log(`Wrote: ${jsonPath}`);
console.log(`Wrote: ${textPath}`);
