// Meta Login (Instagram + Facebook) OAuth wrapper.
//
// Required env:
//   META_APP_ID
//   META_APP_SECRET
//   META_OAUTH_REDIRECT_URI   (e.g. https://portal.aog.example/api/social-connections/callback/meta)
//
// One OAuth completion can create MULTIPLE rows in tbl_social_connections:
//   - one row per Facebook Page the user grants
//   - one row per Instagram Business Account linked to one of those Pages
//
// Tokens issued here are short-lived (~1 hour). We immediately swap them
// for a long-lived user token (~60 days), and for Pages we store the
// page-specific access token (which does NOT expire as long as the user
// access token is valid).

const axios = require('axios');
const crypto = require('crypto');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// Scopes for the v1 publish path. Requires App Review for non-tester use.
// Meta migrated the Instagram permission names mid-2024 to the
// "Instagram Business" naming under the Use Cases system. The old
// instagram_basic / instagram_content_publish names are rejected with
// "Invalid Scopes" on apps created under the new Use Cases UI.
const SCOPES = [
  // Pages permissions, still under the classic names. Granted by the
  // "Manage everything on your Page" use case in the Meta dashboard.
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  // Instagram Business API permissions, new names. Granted by the
  // "Manage messaging & content on Instagram" use case.
  'instagram_business_basic',
  'instagram_business_content_publish',
  // Business: granted by either the Page or the Instagram use case.
  'business_management',
];

function getEnv() {
  const appId = (process.env.META_APP_ID || '').trim();
  const appSecret = (process.env.META_APP_SECRET || '').trim();
  const redirectUri = (process.env.META_OAUTH_REDIRECT_URI || '').trim();
  if (!appId || !appSecret || !redirectUri) {
    const err = new Error('Meta OAuth is not configured. Set META_APP_ID, META_APP_SECRET, META_OAUTH_REDIRECT_URI.');
    err.status = 503;
    throw err;
  }
  return { appId, appSecret, redirectUri };
}

// Sign + pack a state payload so the callback can verify the request
// belongs to the user who started OAuth. We use HMAC-SHA256 with the
// app secret as the key; nothing secret goes in the state payload itself.
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
    state,
    response_type: 'code',
    scope: SCOPES.join(','),
  });
  return `${DIALOG_BASE}?${params.toString()}`;
}

// Step 1: code -> short-lived user access token
async function exchangeCodeForToken(code) {
  const { appId, appSecret, redirectUri } = getEnv();
  const url = `${GRAPH_BASE}/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    },
  });
  const { access_token, token_type, expires_in } = res.data || {};
  if (!access_token) throw new Error('Meta did not return an access_token');
  return { access_token, token_type, expires_in };
}

// Step 2: swap the short-lived token for a long-lived one (~60 days)
async function exchangeForLongLivedToken(shortToken) {
  const { appId, appSecret } = getEnv();
  const url = `${GRAPH_BASE}/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
  });
  const { access_token, expires_in } = res.data || {};
  if (!access_token) throw new Error('Meta did not return a long-lived access_token');
  return { access_token, expires_in };
}

// Step 3: fetch Pages the user manages. Each Page has its own non-expiring
// access token (assuming user token stays valid). We persist these
// page tokens, not the user token, for posting.
async function fetchUserPages(userAccessToken) {
  const url = `${GRAPH_BASE}/me/accounts`;
  const res = await axios.get(url, {
    params: { access_token: userAccessToken, fields: 'id,name,username,access_token' },
  });
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

// Step 4: for each Page, look up the linked Instagram Business Account.
// Returns { ig_user_id, username } when the Page has one, else null.
async function fetchPageInstagram(pageId, pageAccessToken) {
  const url = `${GRAPH_BASE}/${pageId}`;
  const res = await axios.get(url, {
    params: {
      access_token: pageAccessToken,
      fields: 'instagram_business_account{id,username,name,profile_picture_url}',
    },
  });
  const ig = res.data?.instagram_business_account;
  return ig?.id ? { ig_user_id: ig.id, username: ig.username || null, name: ig.name || null, avatar: ig.profile_picture_url || null } : null;
}

module.exports = {
  SCOPES,
  buildAuthorizationUrl,
  verifyState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchUserPages,
  fetchPageInstagram,
};
