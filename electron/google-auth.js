'use strict';

const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');
const { shell } = require('electron');
const { secureTokens } = require('./secure-tokens');

// Minimal scope required: only access to files created/opened by this app
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

// Public desktop OAuth client configuration (customizable in settings)
const DEFAULT_CLIENT_ID = '109823456789-alnclassroomdesktopapp.apps.googleusercontent.com';

function base64URLEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

class GoogleAuthManager {
  constructor() {
    this.clientId = DEFAULT_CLIENT_ID;
    this.pendingServer = null;
  }

  setClientId(clientId) {
    if (clientId) this.clientId = clientId;
  }

  getStatus() {
    const creds = secureTokens.loadTokenData();
    if (!creds || !creds.refreshToken) {
      return {
        connected: false,
        email: null,
        folderName: 'ArabicLiveNotes Recordings',
        backupEnabled: false,
      };
    }
    return {
      connected: true,
      email: creds.email || 'Connected Google Account',
      folderName: 'ArabicLiveNotes Recordings',
      backupEnabled: true,
      lastConnected: creds.connectedAt || null,
    };
  }

  async getAccessToken() {
    const creds = secureTokens.loadTokenData();
    if (!creds || !creds.refreshToken) return null;

    // Check if current access token is still valid
    const now = Date.now();
    if (creds.accessToken && creds.expiresAt && creds.expiresAt > now + 60000) {
      return creds.accessToken;
    }

    // Refresh token with Google OAuth endpoint (PKCE Desktop installed app)
    try {
      const body = new url.URLSearchParams({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
      });

      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error('[GoogleAuth] Token refresh failed with status:', resp.status);
        return null;
      }

      const data = await resp.json();
      const updatedCreds = {
        ...creds,
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      secureTokens.saveTokenData(updatedCreds);
      return data.access_token;
    } catch (err) {
      console.error('[GoogleAuth] Error refreshing token:', err.message || err);
      return null;
    }
  }

  startLoginFlow() {
    return new Promise((resolve, reject) => {
      if (this.pendingServer) {
        try { this.pendingServer.close(); } catch { /* ignore */ }
      }

      const { verifier, challenge } = generatePKCE();
      const state = crypto.randomBytes(32).toString('hex');

      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = url.parse(req.url, true);
          if (reqUrl.pathname !== '/callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }

          const { code, state: returnedState, error } = reqUrl.query;

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h3>Google Login Cancelled</h3><p>Authorization error.</p><p>You can close this window.</p>`);
            server.close();
            this.pendingServer = null;
            return reject(new Error(`Google login returned error: ${error}`));
          }

          if (!returnedState || returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h3>Security Validation Error</h3><p>OAuth state mismatch. Request aborted.</p>');
            server.close();
            this.pendingServer = null;
            return reject(new Error('OAuth state mismatch security error.'));
          }

          // Exchange code for tokens via PKCE authorization code flow (no client secret)
          const tokenBody = new url.URLSearchParams({
            client_id: this.clientId,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          });

          const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenBody.toString(),
          });

          if (!tokenResp.ok) {
            const errBody = await tokenResp.text();
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h3>Authorization Failed</h3><p>${errBody}</p>`);
            server.close();
            this.pendingServer = null;
            return reject(new Error(`Failed to exchange auth code: ${errBody}`));
          }

          const tokenData = await tokenResp.json();

          // Fetch user info for display (safe email only)
          let userEmail = 'Google Account';
          try {
            const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
              headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (userResp.ok) {
              const uInfo = await userResp.json();
              if (uInfo.email) userEmail = uInfo.email;
            }
          } catch { /* ignore */ }

          // Save refresh token securely in DPAPI
          secureTokens.saveTokenData({
            refreshToken: tokenData.refresh_token,
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
            email: userEmail,
            connectedAt: new Date().toISOString(),
          });

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>ArabicLiveNotes — Connected</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #10151c; color: #e8e6e1; text-align: center; padding: 50px 20px; }
              .card { background: #182029; border: 1px solid #2a3742; border-radius: 8px; max-width: 460px; margin: 0 auto; padding: 30px; }
              h2 { color: #4fb3a5; margin-top: 0; }
              p { color: #7a8794; line-height: 1.6; }
            </style>
            </head>
            <body>
              <div class="card">
                <h2>✓ Google Drive Connected</h2>
                <p>ArabicLiveNotes is now linked to <strong>${userEmail}</strong>.</p>
                <p>Your classroom recordings will be backed up to your <em>ArabicLiveNotes Recordings</em> folder in Google Drive.</p>
                <p>You can close this browser tab and return to the application.</p>
              </div>
            </body>
            </html>
          `);

          server.close();
          this.pendingServer = null;
          resolve(this.getStatus());
        } catch (err) {
          server.close();
          this.pendingServer = null;
          reject(err);
        }
      });

      server.listen(0, '127.0.0.1', () => {
        this.pendingServer = server;
        const port = server.address().port;
        redirectUri = `http://127.0.0.1:${port}/callback`;

        const authParams = new url.URLSearchParams({
          client_id: this.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: DRIVE_FILE_SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;
        shell.openExternal(authUrl);
      });

      let redirectUri = '';

      server.on('error', (err) => {
        this.pendingServer = null;
        reject(new Error(`Could not start OAuth loopback listener: ${err.message}`));
      });
    });
  }

  disconnect() {
    secureTokens.clearTokenData();
    return this.getStatus();
  }
}

module.exports = {
  DEFAULT_CLIENT_ID,
  DRIVE_FILE_SCOPE,
  generatePKCE,
  GoogleAuthManager,
  googleAuth: new GoogleAuthManager(),
};
