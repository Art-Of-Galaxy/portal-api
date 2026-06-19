// Shopify Public App OAuth.
//
// One-time setup on partners.shopify.com:
//   1. Create a Public App (in any Partner organization)
//   2. App URL: https://portal.artofgalaxy.com/new-projects/ai-integrations/shopify-blog
//   3. Allowed redirection URL:
//      https://api.artofgalaxy.com/api/shopify-connections/callback
//   4. Request scopes: write_content, read_content, write_files, read_files
//   5. Copy the Client ID + Client Secret into env:
//        SHOPIFY_API_KEY
//        SHOPIFY_API_SECRET
//        SHOPIFY_OAUTH_REDIRECT_URI
//        SHOPIFY_API_VERSION   (default 2024-10)
//
// The user enters their shop domain on the portal ("herbana.life" or
// "herbana.myshopify.com"). We bounce them to Shopify, they approve,
// Shopify redirects back with a code, we exchange it for a permanent
// admin API access token scoped to that shop and store it encrypted.

const axios = require('axios');
const crypto = require('crypto');

const SCOPES = ['write_content', 'read_content', 'write_files', 'read_files'];

function getEnv() {
  const apiKey = (process.env.SHOPIFY_API_KEY || '').trim();
  const apiSecret = (process.env.SHOPIFY_API_SECRET || '').trim();
  const redirectUri = (process.env.SHOPIFY_OAUTH_REDIRECT_URI || '').trim();
  if (!apiKey || !apiSecret || !redirectUri) {
    const err = new Error('Shopify OAuth is not configured. Set SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_OAUTH_REDIRECT_URI.');
    err.status = 503;
    throw err;
  }
  return { apiKey, apiSecret, redirectUri };
}

// Normalize whatever the user typed into the canonical
// "<storename>.myshopify.com" host Shopify expects.
function normalizeShopDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Custom domain like "herbana.life" → we can't infer the .myshopify host.
  // Shopify accepts only *.myshopify.com on OAuth, so the user has to
  // give us their .myshopify domain (we surface this in the UI hint).
  if (!s.endsWith('.myshopify.com')) {
    if (s.includes('.')) {
      // assume the user pasted a custom domain; reject so they re-enter
      const err = new Error('Please enter your Shopify domain in the form yourstore.myshopify.com');
      err.status = 400;
      throw err;
    }
    s = `${s}.myshopify.com`;
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) {
    const err = new Error('That does not look like a valid Shopify domain.');
    err.status = 400;
    throw err;
  }
  return s;
}

// Signed state so the callback can verify the request belongs to the
// user who started OAuth. HMAC-SHA256 over a base64url-encoded payload.
function signState(payload) {
  const { apiSecret } = getEnv();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', apiSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  try {
    const { apiSecret } = getEnv();
    const expected = crypto.createHmac('sha256', apiSecret).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Shopify also signs callback params with HMAC for tamper detection;
// validate before trusting any of the query params.
function verifyShopifyHmac(query) {
  const { apiSecret } = getEnv();
  const { hmac, signature, ...rest } = query || {};
  if (!hmac) return false;
  const sorted = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const computed = crypto.createHmac('sha256', apiSecret).update(sorted).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computed));
  } catch {
    return false;
  }
}

function buildAuthorizationUrl({ shopDomain, userEmail }) {
  const { apiKey, redirectUri } = getEnv();
  const shop = normalizeShopDomain(shopDomain);
  const state = signState({ user_email: userEmail, shop, ts: Date.now(), n: crypto.randomBytes(8).toString('hex') });
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: SCOPES.join(','),
    redirect_uri: redirectUri,
    state,
  });
  return { url: `https://${shop}/admin/oauth/authorize?${params.toString()}`, shop };
}

async function exchangeCodeForToken({ shop, code }) {
  const { apiKey, apiSecret } = getEnv();
  const res = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id: apiKey,
    client_secret: apiSecret,
    code,
  }, { timeout: 15_000 });
  const { access_token, scope } = res.data || {};
  if (!access_token) throw new Error('Shopify did not return an access_token');
  return { access_token, scope };
}

module.exports = {
  SCOPES,
  normalizeShopDomain,
  buildAuthorizationUrl,
  verifyState,
  verifyShopifyHmac,
  exchangeCodeForToken,
};
