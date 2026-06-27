// Instagram Business Login OAuth wrapper.
//
// This is the post-2024 Instagram Login flow that bypasses Facebook
// entirely. The user authorizes on instagram.com and we get a token
// scoped to one Instagram Business / Creator account at a time.
//
// Reuses the same META_APP_ID / META_APP_SECRET as the Facebook Login
// flow (the credentials are shared at the Meta app level), but uses a
// separate redirect URI so the callback handler can route correctly.
//
// Required env:
//   META_APP_ID
//   META_APP_SECRET
//   INSTAGRAM_OAUTH_REDIRECT_URI   e.g. https://api.artofgalaxy.com/api/social-connections/callback/instagram
//
// One OAuth completion creates ONE row in tbl_social_connections,
// marked with meta.source='instagram-oauth' so the publisher knows to
// hit graph.instagram.com instead of graph.facebook.com.

const axios = require('axios');
const crypto = require('crypto');

const GRAPH_BASE = 'https://graph.instagram.com';
const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';

// Scopes for the Instagram Business Login flow.
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];

function getEnv() {
  // Allow optional INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET overrides for
  // setups that have a separate Instagram-only app, but default to the
  // Meta app credentials which is the common case.
  const appId = (process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID || '').trim();
  const appSecret = (process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || '').trim();
  const redirectUri = (process.env.INSTAGRAM_OAUTH_REDIRECT_URI || '').trim();
  if (!appId || !appSecret || !redirectUri) {
    const err = new Error('Instagram OAuth is not configured. Set INSTAGRAM_OAUTH_REDIRECT_URI (and META_APP_ID/META_APP_SECRET, or their INSTAGRAM_* overrides).');
    err.status = 503;
    throw err;
  }
  return { appId, appSecret, redirectUri };
}

// Same HMAC-signed state pattern as the Meta and Shopify flows. Keys
// the OAuth round to a specific user so the callback can't be hijacked.
function signState(payload) {
  const { appSecret } = getEnv();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', appSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  try {
    const { appSecret } = getEnv();
    const expected = crypto.createHmac('sha256', appSecret).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function buildAuthorizationUrl({ userEmail }) {
  const { appId, redirectUri } = getEnv();
  const state = signState({ user_email: userEmail, ts: Date.now(), n: crypto.randomBytes(8).toString('hex') });
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// Step 1: code -> short-lived access token (~1 hour). The Instagram
// Login API returns a body keyed by user_id (the IG Business account
// id), not "id" or "userId". Long-lived swap happens in step 2.
async function exchangeCodeForToken(code) {
  const { appId, appSecret, redirectUri } = getEnv();
  const form = new URLSearchParams();
  form.set('client_id', appId);
  form.set('client_secret', appSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', code);
  const res = await axios.post(TOKEN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
  });
  const { access_token, user_id, permissions } = res.data || {};
  if (!access_token || !user_id) throw new Error('Instagram did not return access_token + user_id');
  return { access_token, user_id: String(user_id), permissions };
}

// Step 2: short-lived (1h) -> long-lived (60d). The long-lived token
// can be refreshed up to 60 days from when it was last used.
async function exchangeForLongLivedToken(shortToken) {
  const { appSecret } = getEnv();
  const res = await axios.get(`${GRAPH_BASE}/access_token`, {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: appSecret,
      access_token: shortToken,
    },
    timeout: 15_000,
  });
  const { access_token, expires_in } = res.data || {};
  if (!access_token) throw new Error('Instagram did not return a long-lived token');
  return { access_token, expires_in };
}

// After OAuth we want the username + name + avatar for the UI row.
async function fetchSelf(longToken) {
  const res = await axios.get(`${GRAPH_BASE}/v22.0/me`, {
    params: {
      fields: 'user_id,username,name,account_type,profile_picture_url',
      access_token: longToken,
    },
    timeout: 15_000,
  });
  return res.data || {};
}

module.exports = {
  SCOPES,
  buildAuthorizationUrl,
  verifyState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchSelf,
};
