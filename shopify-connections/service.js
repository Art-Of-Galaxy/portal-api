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

module.exports = {
  upsertConnection,
  listConnections,
  getConnectionWithToken,
  setDefaultBlog,
  disconnect,
  markReauthRequired,
  markValidated,
};
