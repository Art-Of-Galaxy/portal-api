// REST endpoints for connecting/managing Shopify stores.
//
//   POST  /api/shopify-connections/start          { shop_domain }
//   GET   /api/shopify-connections/callback       OAuth callback
//   GET   /api/shopify-connections                 list user's stores
//   GET   /api/shopify-connections/:id/blogs       list blogs in a store
//   PATCH /api/shopify-connections/:id             set default blog
//   DELETE /api/shopify-connections/:id            disconnect

const oauth = require('./oauth');
const adminApi = require('./admin_api');
const service = require('./service');

function frontendBase() {
  return (process.env.PORTAL_UI_BASE || 'http://localhost:5173').replace(/\/$/, '');
}
function landingUrl(query) {
  const qs = new URLSearchParams(query || {}).toString();
  return `${frontendBase()}/new-projects/ai-integrations/shopify-blog/connections${qs ? `?${qs}` : ''}`;
}
function getUserEmail(req) {
  return (
    req.headers['x-user-email']
    || req.body?.user_email
    || req.query?.user_email
    || ''
  ).toString().trim().toLowerCase();
}

async function start(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const { shop_domain } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!shop_domain) return res.status(400).json({ success: false, message: 'shop_domain is required' });
    const { url, shop } = oauth.buildAuthorizationUrl({ shopDomain: shop_domain, userEmail });
    return res.status(200).json({ success: true, authorize_url: url, shop });
  } catch (err) {
    console.error('shopify-connections/start error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to start' });
  }
}

async function callback(req, res) {
  try {
    const { shop, code, state } = req.query || {};
    if (!shop || !code) {
      console.warn('[shopify-callback] missing_code', { hasShop: !!shop, hasCode: !!code });
      return res.redirect(landingUrl({ status: 'error', error: 'missing_code' }));
    }
    if (!oauth.verifyShopifyHmac(req.query)) {
      console.warn('[shopify-callback] bad_hmac', { shop });
      return res.redirect(landingUrl({ status: 'error', error: 'bad_hmac' }));
    }
    const verified = oauth.verifyState(state);
    if (!verified) {
      console.warn('[shopify-callback] bad_state: hmac_failed (SHOPIFY_API_SECRET likely differs between /start and /callback, or state truncated)');
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state', sub: 'sig' }));
    }
    if (!verified.user_email) {
      console.warn('[shopify-callback] bad_state: missing user_email in state');
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state', sub: 'no_email' }));
    }
    if (!verified.shop) {
      console.warn('[shopify-callback] bad_state: missing shop in state');
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state', sub: 'no_shop' }));
    }
    if (verified.shop !== shop) {
      console.warn('[shopify-callback] bad_state: shop mismatch', { stateShop: verified.shop, callbackShop: shop });
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state', sub: 'shop_mismatch' }));
    }
    const userEmail = verified.user_email;

    const { access_token, scope } = await oauth.exchangeCodeForToken({ shop, code });

    // Probe the shop + auto-pick the first blog as default so the user
    // doesn't have to before they create their first article.
    let shopInfo = null;
    let blogs = [];
    try { shopInfo = await adminApi.getShop({ shop, accessToken: access_token }); }
    catch (e) { console.warn('[shopify-callback] getShop failed:', e.message); }
    try { blogs = await adminApi.listBlogs({ shop, accessToken: access_token }); }
    catch (e) { console.warn('[shopify-callback] listBlogs failed:', e.message); }
    const defaultBlog = blogs[0] || null;

    await service.upsertConnection({
      userEmail,
      shopDomain: shop,
      shopName: shopInfo?.name || null,
      shopId: shopInfo?.id || null,
      accessToken: access_token,
      scope: scope || null,
      meta: { primary_domain: shopInfo?.primaryDomain?.host || null, email: shopInfo?.email || null },
      defaultBlogId: defaultBlog?.id || null,
      defaultBlogTitle: defaultBlog?.title || null,
    });

    return res.redirect(landingUrl({ status: 'ok', shop }));
  } catch (err) {
    console.error('shopify-connections/callback error:', err.response?.data || err.message || err);
    return res.redirect(landingUrl({ status: 'error', error: 'callback_failed' }));
  }
}

async function list(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const connections = await service.listConnections({ userEmail });
    return res.status(200).json({ success: true, connections });
  } catch (err) {
    console.error('shopify-connections/list error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
}

async function listBlogs(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid connection id' });
    const conn = await service.getConnectionWithToken({ userEmail, connectionId: id });
    if (!conn) return res.status(404).json({ success: false, message: 'Connection not found' });
    const blogs = await adminApi.listBlogs({ shop: conn.shop_domain, accessToken: conn.access_token });
    return res.status(200).json({ success: true, blogs });
  } catch (err) {
    console.error('shopify-connections/listBlogs error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Internal error' });
  }
}

async function patch(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    const { blog_id, blog_title } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    await service.setDefaultBlog({ userEmail, connectionId: id, blogId: blog_id || null, blogTitle: blog_title || null });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
}

async function destroy(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    await service.disconnect({ userEmail, connectionId: id });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Internal error' });
  }
}

module.exports = { start, callback, list, listBlogs, patch, destroy };
