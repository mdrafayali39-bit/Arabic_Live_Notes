'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * StorageManager
 * Provides configurable, safe storage-root abstraction for local recordings,
 * databases, caches, and logs without hardcoding development paths.
 */
class StorageManager {
  constructor(basePath = null) {
    this.customRoot = null;
    this.defaultRoot = basePath || path.join(__dirname, '..', 'storage');
    this.initDirectories();
  }

  setRoot(newRoot) {
    if (newRoot && typeof newRoot === 'string') {
      this.customRoot = path.resolve(newRoot);
    } else {
      this.customRoot = null;
    }
    this.initDirectories();
  }

  getRoot() {
    return this.customRoot || this.defaultRoot;
  }

  getRecordingsRoot() {
    return path.join(this.getRoot(), 'recordings');
  }

  getDatabaseRoot() {
    return path.join(this.getRoot(), 'database');
  }

  getCacheRoot() {
    return path.join(this.getRoot(), 'cache');
  }

  getLogsRoot() {
    return path.join(this.getRoot(), 'logs');
  }

  /**
   * Sanitizes a recording ID to ensure it is a valid filename
   * and prevents path traversal attacks.
   */
  sanitizeId(id) {
    if (!id || typeof id !== 'string' || id.trim() === '') {
      throw new Error('Invalid recording ID: ID must be a non-empty string');
    }
    if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes(':')) {
      throw new Error(`Invalid recording ID: path traversal or illegal characters detected in "${id}"`);
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
      throw new Error(`Invalid recording ID format: "${id}"`);
    }
    return id;
  }

  getRecordingPath(id) {
    const cleanId = this.sanitizeId(id);
    return path.join(this.getRecordingsRoot(), cleanId);
  }

  initDirectories() {
    const dirs = [
      this.getRoot(),
      this.getRecordingsRoot(),
      this.getDatabaseRoot(),
      this.getCacheRoot(),
      this.getLogsRoot(),
    ];
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error(`[StorageManager] Failed to create directory ${dir}:`, err);
      }
    }
  }
}

module.exports = {
  StorageManager,
  storageManager: new StorageManager(),
};
