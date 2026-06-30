const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

class CacheStore {
  constructor(filePath) {
    this.filePath = filePath;
    ensureDir(path.dirname(filePath));
    this.data = readJson(filePath, { version: 1, items: {} });
    if (!this.data.items) {
      this.data.items = {};
    }
  }

  get(key) {
    return this.data.items[key];
  }

  set(key, value) {
    this.data.items[key] = value;
    this.save();
  }

  touch(key) {
    const item = this.data.items[key];
    if (!item) {
      return;
    }
    item.hits = (item.hits || 0) + 1;
    item.lastHitAt = new Date().toISOString();
    this.save();
  }

  list(limit) {
    return Object.values(this.data.items)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }

  count() {
    return Object.keys(this.data.items).length;
  }

  save() {
    writeJsonAtomic(this.filePath, this.data);
  }
}

module.exports = {
  CacheStore,
  ensureDir,
  readJson,
  writeJsonAtomic,
};
