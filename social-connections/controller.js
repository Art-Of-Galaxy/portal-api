// REST endpoints for connecting / disconnecting social platforms.
//
// Flow:
//   POST  /api/social-connections/start/:platform  -> { authorize_url }
//   GET   /api/social-connections/callback/meta    -> upserts connections, redirects to /social/connections
//   GET   /api/social-connections/callback/google  -> upserts YouTube connection, redirects
//   GET   /api/social-connections                  -> list current user's connections (no tokens)
//   DELETE /api/social-connections/:id             -> revoke

const service = require('./service');
const oauthMeta = require('./oauth_meta');
const oauthGoogle = require('./oauth_google');
const oauthInstagram = require('./oauth_instagram');

// Where the frontend lives. After OAuth Meta/Google redirects back, we
// in turn redirect the BROWSER to the portal connections page so the
// user lands somewhere sensible. Configurable so we can point this at
// a staging UI without code changes.
function frontendBase() {
  return (process.env.PORTAL_UI_BASE || 'http://localhost:5173').replace(/\/$/, '');
}

function landingUrl(query) {
  const qs = new URLSearchParams(query || {}).toString();
  return `${frontendBase()}/new-projects/social/connections${qs ? `?${qs}` : ''}`;
}

function getUserEmail(req) {
  return (
    req.headers['x-user-email']
    || req.body?.user_email
    || req.query?.user_email
    || ''
  ).toString().trim().toLowerCase();
}

// ---------- start / callback ----------

async function start(req, res) {
  try {
    const platform = String(req.params.platform || '').toLowerCase();
    const userEmail = getUserEmail(req);
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'user_email is required to start OAuth.' });
    }
    // Two separate Meta-side flows:
    //   - 'meta' / 'facebook' => Facebook Login for Business, Pages only
    //   - 'instagram'         => Instagram Business Login at instagram.com,
    //                            IG account only (no FB Page link required)
    if (platform === 'meta' || platform === 'facebook') {
      const url = oauthMeta.buildAuthorizationUrl({ userEmail });
      return res.status(200).json({ success: true, platform: 'meta', authorize_url: url });
    }
    if (platform === 'instagram') {
      const url = oauthInstagram.buildAuthorizationUrl({ userEmail });
      return res.status(200).json({ success: true, platform: 'instagram', authorize_url: url });
    }
    if (platform === 'youtube' || platform === 'google') {
      const url = oauthGoogle.buildAuthorizationUrl({ userEmail });
      return res.status(200).json({ success: true, platform: 'google', authorize_url: url });
    }
    return res.status(400).json({ success: false, message: `Unknown platform: ${platform}` });
  } catch (err) {
    console.error('social-connections/start error:', err);
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message || 'Failed to start OAuth' });
  }
}

// Meta callback creates connection rows for every Page + each linked IG.
async function callbackMeta(req, res) {
  try {
    const { code, state, error: errParam, error_description } = req.query || {};
    if (errParam) {
      console.warn('[meta-callback] user denied:', errParam, error_description);
      return res.redirect(landingUrl({ status: 'denied', error: errParam }));
    }
    if (!code) {
      return res.redirect(landingUrl({ status: 'error', error: 'missing_code' }));
    }
    const verified = oauthMeta.verifyState(state);
    if (!verified?.user_email) {
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state' }));
    }
    const userEmail = verified.user_email;

    // short -> long lived user token, then enumerate Pages
    const short = await oauthMeta.exchangeCodeForToken(code);
    const long = await oauthMeta.exchangeForLongLivedToken(short.access_token);
    const pages = await oauthMeta.fetchUserPages(long.access_token);

    // Track how many Pages had a linked Instagram Business account so
    // we can surface "you connected Pages but no IG was linked" on the
    // Connections page. Most common cause is the user's IG is still a
    // Personal account (must be Business/Creator) or not yet linked to
    // any Page they admin.
    const created = [];
    let pagesWithIg = 0;
    let pagesWithoutIg = 0;
    for (const page of pages) {
      const pageToken = page.access_token;
      const fbConn = await service.upsertConnection({
        userEmail,
        platform: 'facebook',
        accountId: String(page.id),
        accountHandle: page.username || null,
        accountName: page.name || null,
        accessToken: pageToken,
        scope: oauthMeta.SCOPES.join(','),
        meta: { source: 'meta-oauth', user_token_expires_in: long.expires_in },
        expiresAt: null,
      });
      created.push(fbConn);

      let ig = null;
      try { ig = await oauthMeta.fetchPageInstagram(page.id, pageToken); }
      catch (e) { console.warn('[meta-callback] fetchPageInstagram failed:', e.message); }
      if (ig?.ig_user_id) {
        pagesWithIg += 1;
        const igConn = await service.upsertConnection({
          userEmail,
          platform: 'instagram',
          accountId: String(ig.ig_user_id),
          accountHandle: ig.username || null,
          accountName: ig.name || null,
          // For IG publishing we use the PAGE token (Instagram Graph API
          // pattern). The IG user id identifies which IG to publish to.
          accessToken: pageToken,
          scope: oauthMeta.SCOPES.join(','),
          meta: { source: 'meta-oauth', linked_page_id: page.id, avatar: ig.avatar || null },
          expiresAt: null,
        });
        created.push(igConn);
      } else {
        pagesWithoutIg += 1;
      }
    }

    // Surface "Pages connected but no IG" so the Connections page can
    // show a banner explaining how to convert IG to Business.
    const queryOut = { status: 'ok', connected: String(created.length) };
    if (pages.length && pagesWithIg === 0) {
      queryOut.ig_missing = '1';
      queryOut.pages_without_ig = String(pagesWithoutIg);
    }
    return res.redirect(landingUrl(queryOut));
  } catch (err) {
    console.error('social-connections/callback-meta error:', err.response?.data || err.message || err);
    return res.redirect(landingUrl({ status: 'error', error: 'meta_callback_failed' }));
  }
}

async function callbackGoogle(req, res) {
  try {
    const { code, state, error: errParam } = req.query || {};
    if (errParam) {
      return res.redirect(landingUrl({ status: 'denied', error: errParam }));
    }
    if (!code) {
      return res.redirect(landingUrl({ status: 'error', error: 'missing_code' }));
    }
    const verified = oauthGoogle.verifyState(state);
    if (!verified?.user_email) {
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state' }));
    }
    const userEmail = verified.user_email;
    const tokens = await oauthGoogle.exchangeCodeForTokens(code);
    const channel = await oauthGoogle.fetchOwnChannel(tokens.access_token);
    if (!channel?.id) {
      return res.redirect(landingUrl({ status: 'error', error: 'no_channel' }));
    }
    await service.upsertConnection({
      userEmail,
      platform: 'youtube',
      accountId: String(channel.id),
      accountHandle: channel.snippet?.customUrl || channel.snippet?.title || null,
      accountName: channel.snippet?.title || null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      scope: oauthGoogle.SCOPES.join(' '),
      meta: { source: 'google-oauth', thumbnails: channel.snippet?.thumbnails || null },
      expiresAt: tokens.expiry_date ? new Date(Number(tokens.expiry_date)) : null,
    });
    return res.redirect(landingUrl({ status: 'ok', connected: '1' }));
  } catch (err) {
    console.error('social-connections/callback-google error:', err?.response?.data || err.message || err);
    return res.redirect(landingUrl({ status: 'error', error: 'google_callback_failed' }));
  }
}

// Instagram Business Login callback: returns ONE Instagram account per
// OAuth round. Stored with meta.source='instagram-oauth' so the
// publisher knows to hit graph.instagram.com.
async function callbackInstagram(req, res) {
  try {
    const { code, state, error: errParam, error_description } = req.query || {};
    if (errParam) {
      console.warn('[ig-callback] user denied:', errParam, error_description);
      return res.redirect(landingUrl({ status: 'denied', error: errParam }));
    }
    if (!code) {
      return res.redirect(landingUrl({ status: 'error', error: 'missing_code' }));
    }
    const verified = oauthInstagram.verifyState(state);
    if (!verified?.user_email) {
      return res.redirect(landingUrl({ status: 'error', error: 'bad_state' }));
    }
    const userEmail = verified.user_email;

    const short = await oauthInstagram.exchangeCodeForToken(code);
    const long = await oauthInstagram.exchangeForLongLivedToken(short.access_token);
    let me = {};
    try { me = await oauthInstagram.fetchSelf(long.access_token); }
    catch (e) { console.warn('[ig-callback] fetchSelf failed:', e.message); }

    const expiresAt = long.expires_in
      ? new Date(Date.now() + Number(long.expires_in) * 1000)
      : null;

    await service.upsertConnection({
      userEmail,
      platform: 'instagram',
      accountId: String(me.user_id || short.user_id),
      accountHandle: me.username || null,
      accountName: me.name || me.username || null,
      accessToken: long.access_token,
      scope: oauthInstagram.SCOPES.join(','),
      meta: {
        source: 'instagram-oauth',
        account_type: me.account_type || null,
        avatar: me.profile_picture_url || null,
      },
      expiresAt,
    });

    return res.redirect(landingUrl({ status: 'ok', connected: '1' }));
  } catch (err) {
    console.error('social-connections/callback-instagram error:', err?.response?.data || err.message || err);
    return res.redirect(landingUrl({ status: 'error', error: 'instagram_callback_failed' }));
  }
}

// ---------- list / disconnect ----------

async function list(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'user_email is required' });
    }
    const connections = await service.listConnections({ userEmail });
    return res.status(200).json({ success: true, connections });
  } catch (err) {
    console.error('social-connections/list error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
}

async function destroy(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'user_email is required' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid connection id' });
    }
    await service.disconnect({ userEmail, connectionId: id });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('social-connections/destroy error:', err);
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message || 'Internal error' });
  }
}

module.exports = { start, callbackMeta, callbackGoogle, callbackInstagram, list, destroy };
