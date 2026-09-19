'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { safeStorage } = require('electron');
const { storageManager } = require('./storage-manager');

/**
 * SecureTokenManager
 * Stores OAuth refresh tokens and credentials using Electron's native safeStorage
 * (backed by Windows DPAPI / macOS Keychain / Linux Secret Service).
 *
 * FAILS CLOSED: Never stores credentials in plaintext if encryption is unavailable.
 */
class SecureTokenManager {
  constructor(storage = storageManager) {
    this.storage = storage;
  }

  _credPath() {
    return path.join(this.storage.getDatabaseRoot(), 'auth.enc');
  }

  isAvailable() {
    try {
      return typeof safeStorage !== 'undefined' && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  saveTokenData(data) {
    if (!this.isAvailable()) {
      throw new Error(
        'Secure token storage is unavailable on this OS. Plaintext fallback is disabled for security.'
      );
    }

    const json = JSON.stringify(data);
    const encrypted = safeStorage.encryptString(json);
    fs.writeFileSync(this._credPath(), encrypted);
    return true;
  }

  loadTokenData() {
    const p = this._credPath();
    if (!fs.existsSync(p)) return null;

    if (!this.isAvailable()) {
      throw new Error(
        'Secure token storage is unavailable. Cannot decrypt stored credentials.'
      );
    }

    try {
      const encrypted = fs.readFileSync(p);
      const decryptedJson = safeStorage.decryptString(encrypted);
      return JSON.parse(decryptedJson);
    } catch (err) {
      console.error('[SecureTokenManager] Failed to decrypt credentials:', err);
      return null;
    }
  }

  clearTokenData() {
    const p = this._credPath();
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        console.error('[SecureTokenManager] Failed to delete credentials file:', err);
      }
    }
    return true;
  }
}

module.exports = {
  SecureTokenManager,
  secureTokens: new SecureTokenManager(),
};
