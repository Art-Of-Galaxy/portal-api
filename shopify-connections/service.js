// Persist Shopify store connections per portal user.
// Tokens are AES-256-GCM encrypted via helper/social_tokens.

const { poll } = require('../config/dbconfig');
const tokens = require('../helper/social_tokens');

async function upsertConnection({
  userEmail, shopDomain, shopName, shopId,
  accessToken, scope, meta,
  defaultBlogId, defaultBlogTitle,
}) {
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!shopDomain) throw Object.assign(new Error('shop_domain is required'), { status: 400 });
  const enc = tokens.encrypt(accessToken);

  const result = await poll.query(
    `INSERT INTO tbl_shopify_connections
        (user_email, shop_domain, shop_name, shop_id, access_token_enc, scope, meta,
         default_blog_id, default_blog_title, last_validated_at, state)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(), 'connected')
      ON CONFLICT (user_email, shop_domain) DO UPDATE
        SET shop_name = EXCLUDED.shop_name,
            shop_id   = EXCLUDED.shop_id,
            access_token_enc = EXCLUDED.access_token_enc,
            scope = EXCLUDED.scope,
            meta  = EXCLUDED.meta,
            default_blog_id    = COALESCE(EXCLUDED.default_blog_id, tbl_shopify_connections.default_blog_id),
            default_blog_title = COALESCE(EXCLUDED.default_blog_title, tbl_shopify_connections.default_blog_title),
            last_validated_at  = NOW(),
            state              = 'connected',
            updated_at         = NOW()
      RETURNING id, user_email, shop_domain, shop_name, shop_id, scope, meta,
                default_blog_id, default_blog_title, state, created_at`,
    [
      userEmail, shopDomain,
      shopName || null,
      shopId ? String(shopId) : null,
      enc,
      scope || null,
      meta ? JSON.stringify(meta) : null,
      defaultBlogId || null,
      defaultBlogTitle || null,
    ]
  );
  return result.rows?.[0] || null;
}

async function listConnections({ userEmail }) {
  if (!userEmail) return [];
  const rows = await poll.query(
    `SELECT id, shop_domain, shop_name, shop_id, scope, meta,
            default_blog_id, default_blog_title,
            last_validated_at, state, created_at
       FROM tbl_shopify_connections
      WHERE user_email = $1 AND state IN ('connected', 'reauth_required')
      ORDER BY created_at ASC`,
    [userEmail]
  );
  return rows || [];
}

async function getConnectionWithToken({ userEmail, connectionId, shopDomain }) {
  const where = ['state = \'connected\''];
  const params = [];
  if (userEmail) { params.push(userEmail); where.push(`user_email = $${params.length}`); }
  if (connectionId) { params.push(connectionId); where.push(`id = $${params.length}`); }
  if (shopDomain) { params.push(shopDomain); where.push(`shop_domain = $${params.length}`); }
  const rows = await poll.query(
    `SELECT id, user_email, shop_domain, shop_name, shop_id, access_token_enc,
            scope, meta, default_blog_id, default_blog_title, state
       FROM tbl_shopify_connections
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );
  const row = (rows || [])[0];
  if (!row) return null;
  return {
    id: row.id,
    user_email: row.user_email,
    shop_domain: row.shop_domain,
    shop_name: row.shop_name,
    shop_id: row.shop_id,
    access_token: tokens.decrypt(row.access_token_enc),
    scope: row.scope,
    meta: row.meta || null,
    default_blog_id: row.default_blog_id,
    default_blog_title: row.default_blog_title,
    state: row.state,
  };
}

async function setDefaultBlog({ userEmail, connectionId, blogId, blogTitle }) {
  await poll.query(
    `UPDATE tbl_shopify_connections
        SET default_blog_id = $3, default_blog_title = $4, updated_at = NOW()
      WHERE id = $1 AND user_email = $2`,
    [connectionId, userEmail, blogId, blogTitle]
  );
}

async function disconnect({ userEmail, connectionId }) {
  if (!userEmail || !connectionId) throw Object.assign(new Error('Missing user_email or id'), { status: 400 });
  await poll.query(
    `UPDATE tbl_shopify_connections
        SET state = 'revoked', access_token_enc = '', updated_at = NOW()
      WHERE id = $1 AND user_email = $2`,
    [connectionId, userEmail]
  );
}

async function markReauthRequired(id, reason) {
  await poll.query(
    `UPDATE tbl_shopify_connections
        SET state = 'reauth_required', updated_at = NOW(),
            meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('last_probe_error', $2::text)
      WHERE id = $1`,
    [id, String(reason || 'unknown').slice(0, 200)]
  );
}

async function markValidated(id) {
  await poll.query(
    `UPDATE tbl_shopify_connections
        SET state = 'connected', last_validated_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id]
  );
}

// ---------------------------------------------------------------------
// Webhook-driven lifecycle. See webhooks.js.
// ---------------------------------------------------------------------

// shop/redact: erase everything tied to a store, 48h after uninstall.
//
// Deleting the connection row is what removes the store-identifying
// data (domain, name, shop id, encrypted admin token, contact email in
// meta). tbl_blog_autopilots cascades on that delete; tbl_blog_articles
// only ON DELETE SET NULL, so we scrub its Shopify columns first, while
// we still know which articles belonged to the store. The merchant's own
// drafted copy stays in their portal account: it is their content, not
// the store's, and it no longer references the shop.
async function redactShop({ shopDomain }) {
  if (!shopDomain) throw Object.assign(new Error('shop_domain is required'), { status: 400 });

  const conns = await poll.query(
    `SELECT id FROM tbl_shopify_connections WHERE shop_domain = $1`,
    [shopDomain]
  );
  const ids = (conns || []).map((r) => r.id);
  if (!ids.length) {
    return { connections_deleted: 0, autopilots_deleted: 0, articles_scrubbed: 0 };
  }

  const articles = await poll.query(
    `UPDATE tbl_blog_articles
        SET shopify_article_id = NULL,
            shopify_blog_id    = NULL,
            shopify_url        = NULL,
            shop_connection_id = NULL,
            status = CASE WHEN status IN ('scheduled', 'publishing') THEN 'draft' ELSE status END,
            updated_at = NOW()
      WHERE shop_connection_id = ANY($1::int[])`,
    [ids]
  );

  const autopilots = await poll.query(
    `DELETE FROM tbl_blog_autopilots WHERE shop_connection_id = ANY($1::int[])`,
    [ids]
  );

  const deleted = await poll.query(
    `DELETE FROM tbl_shopify_connections WHERE id = ANY($1::int[])`,
    [ids]
  );

  return {
    connections_deleted: deleted?.rowCount || 0,
    autopilots_deleted: autopilots?.rowCount || 0,
    articles_scrubbed: articles?.rowCount || 0,
  };
}

// app/uninstalled: the access token is dead the moment the store removes
// the app. Flip the connection to 'revoked' and blank the token so
// getConnectionWithToken (which filters state='connected') stops handing
// it to the publisher, and pause the autopilots so the hourly refill
// stops drafting for a store we can no longer publish to.
async function markUninstalled({ shopDomain }) {
  if (!shopDomain) throw Object.assign(new Error('shop_domain is required'), { status: 400 });

  const updated = await poll.query(
    `UPDATE tbl_shopify_connections
        SET state = 'revoked', access_token_enc = '', updated_at = NOW()
      WHERE shop_domain = $1 AND state <> 'revoked'
      RETURNING id`,
    [shopDomain]
  );
  const ids = (updated?.rows || []).map((r) => r.id);
  if (!ids.length) return { connections_revoked: 0, autopilots_paused: 0 };

  const paused = await poll.query(
    `UPDATE tbl_blog_autopilots
        SET status = 'paused', updated_at = NOW()
      WHERE shop_connection_id = ANY($1::int[]) AND status = 'active'`,
    [ids]
  );

  return { connections_revoked: ids.length, autopilots_paused: paused?.rowCount || 0 };
}

module.exports = {
  upsertConnection,
  listConnections,
  getConnectionWithToken,
  setDefaultBlog,
  disconnect,
  markReauthRequired,
  markValidated,
  redactShop,
  markUninstalled,
};
