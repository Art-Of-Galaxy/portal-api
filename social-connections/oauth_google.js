// Google OAuth wrapper for YouTube (Shorts) publishing.
//
// Required env:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URI  (e.g. https://portal.aog.example/api/social-connections/callback/google)
//
// Tokens issued by Google: access_token (~1 hour) + refresh_token (long
// lived). We persist both and refresh the access token before each
// publish in publish/youtube.js.

const { google } = require('googleapis');
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

function getEnv() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error('Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI.');
    err.status = 503;
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

function makeOauthClient() {
  const { clientId, clientSecret, redirectUri } = getEnv();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Same state signing scheme as Meta: HMAC the user identity into the
// state param so the callback can route to the right user.
function signState(payload) {
  const { clientSecret } = getEnv();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', clientSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  try {
    const { clientSecret } = getEnv();
    const expected = crypto.createHmac('sha256', clientSecret).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function buildAuthorizationUrl({ userEmail }) {
  const oauth2 = makeOauthClient();
  const state = signState({ user_email: userEmail, ts: Date.now(), n: crypto.randomBytes(8).toString('hex') });
  return oauth2.generateAuthUrl({
    access_type: 'offline',         // needed to get a refresh_token
    prompt: 'consent',              // force refresh_token on every grant
    scope: SCOPES,
    state,
  });
}

async function exchangeCodeForTokens(code) {
  const oauth2 = makeOauthClient();
  const { tokens } = await oauth2.getToken(code);
  return tokens;
}

async function refreshAccessToken(refreshToken) {
  const oauth2 = makeOauthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  return credentials;
}

async function fetchOwnChannel(accessToken) {
  const oauth2 = makeOauthClient();
  oauth2.setCredentials({ access_token: accessToken });
  const yt = google.youtube({ version: 'v3', auth: oauth2 });
  const res = await yt.channels.list({ part: ['id', 'snippet'], mine: true });
  return res.data?.items?.[0] || null;
}

module.exports = {
  SCOPES,
  buildAuthorizationUrl,
  verifyState,
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchOwnChannel,
};
