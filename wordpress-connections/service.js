// DB layer for tbl_wordpress_connections. Encrypts the Application
// Password at rest with helper/social_tokens (AES-256-GCM). Mirrors the
// shape of shopify-connections/service.js so the publishing code feels
// the same across providers.

const { poll } = require('../config/dbconfig');
const tokens = require('../helper/social_tokens');
const wpApi = require('./wp_api');

async function upsertConnection({
  userEmail,
  siteUrl,
  siteName,
  username,
  appPassword,
  siteInfo,
  defaultCategoryId,
  defaultCategoryName,
}) {
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!siteUrl) throw Object.assign(new Error('site_url is required'), { status: 400 });
  if (!username) throw Object.assign(new Error('username is required'), { status: 400 });
  if (!appPassword) throw Object.assign(new Error('app_password is required'), { status: 400 });

  const canonicalUrl = wpApi.normalizeSiteUrl(siteUrl);
  const passEnc = tokens.encrypt(appPassword);

  const result = await poll.query(
    `INSERT INTO tbl_wordpress_connections
        (user_email, site_url, site_name, username, app_password_enc, site_info,
         default_category_id, default_category_name, last_validated_at, state)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), 'connected')
      ON CONFLICT (user_email, site_url, username) DO UPDATE
        SET site_name = EXCLUDED.site_name,
            app_password_enc = EXCLUDED.app_password_enc,
            site_info = EXCLUDED.site_info,
            default_category_id = COALESCE(EXCLUDED.default_category_id, tbl_wordpress_connections.default_category_id),
            default_category_name = COALESCE(EXCLUDED.default_category_name, tbl_wordpress_connections.default_category_name),
            last_validated_at = NOW(),
            state = 'connected',
            updated_at = NOW()
      RETURNING id, site_url, site_name, username, state, created_at`,
    [
      userEmail,
      canonicalUrl,
      siteName || null,
      username,
      passEnc,
      siteInfo ? JSON.stringify(siteInfo) : null,
      defaultCategoryId || null,
      defaultCategoryName || null,
    ]
  );
  const row = result.rows?.[0] || null;
  // Auto-elect first connection per user as primary so the publisher
  // always has somewhere to send. Same pattern as social-connections.
  if (row?.id) {
    await poll.query(
      `UPDATE tbl_wordpress_connections
          SET is_primary = TRUE, updated_at = NOW()
        WHERE id = $1
          AND NOT EXISTS (
            SELECT 1 FROM tbl_wordpress_connections x
             WHERE x.user_email = $2
               AND x.state = 'connected'
               AND x.is_primary = TRUE
               AND x.id <> $1
          )`,
      [row.id, userEmail]
    );
  }
  return row;
}

async function listConnections({ userEmail }) {
  if (!userEmail) return [];
  const rows = await poll.query(
    `SELECT id, site_url, site_name, username, site_info,
            default_category_id, default_category_name,
            is_primary, last_validated_at, state, created_at
       FROM tbl_wordpress_connections
      WHERE user_email = $1 AND state = 'connected'
      ORDER BY is_primary DESC, created_at ASC`,
    [userEmail]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    site_url: r.site_url,
    site_name: r.site_name,
    username: r.username,
    site_info: r.site_info || null,
    default_category_id: r.default_category_id,
    default_category_name: r.default_category_name,
    is_primary: Boolean(r.is_primary),
    last_validated_at: r.last_validated_at,
    state: r.state,
    created_at: r.created_at,
  }));
}

// Internal: fetch a single connection with the decrypted app password.
// Only the publisher + category-list endpoints need this.
async function getConnectionWithToken({ userEmail, connectionId }) {
  if (!connectionId) return null;
  const params = [connectionId];
  let where = 'id = $1 AND state = \'connected\'';
  if (userEmail) { params.push(userEmail); where += ` AND user_email = $${params.length}`; }
  const rows = await poll.query(
    `SELECT id, user_email, site_url, site_name, username, app_password_enc,
            site_info, default_category_id, default_category_name, is_primary
       FROM tbl_wordpress_connections
      WHERE ${where}
      LIMIT 1`,
    params
  );
  const row = (rows || [])[0];
  if (!row) return null;
  return {
    id: row.id,
    user_email: row.user_email,
    site_url: row.site_url,
    site_name: row.site_name,
    username: row.username,
    app_password: tokens.decrypt(row.app_password_enc),
    site_info: row.site_info || null,
    default_category_id: row.default_category_id,
    default_category_name: row.default_category_name,
    is_primary: Boolean(row.is_primary),
  };
}

async function setDefaultCategory({ userEmail, connectionId, categoryId, categoryName }) {
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!connectionId) throw Object.assign(new Error('connection_id is required'), { status: 400 });
  await poll.query(
    `UPDATE tbl_wordpress_connections
        SET default_category_id = $1,
            default_category_name = $2,
            updated_at = NOW()
      WHERE id = $3 AND user_email = $4`,
    [categoryId || null, categoryName || null, connectionId, userEmail]
  );
}

async function setPrimaryConnection({ userEmail, connectionId }) {
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!connectionId) throw Object.assign(new Error('connection_id is required'), { status: 400 });
  const rows = await poll.query(
    `SELECT id FROM tbl_wordpress_connections
      WHERE id = $1 AND user_email = $2 AND state = 'connected' LIMIT 1`,
    [connectionId, userEmail]
  );
  if (!(rows || [])[0]) throw Object.assign(new Error('Connection not found'), { status: 404 });
  await poll.query(
    `UPDATE tbl_wordpress_connections
        SET is_primary = FALSE, updated_at = NOW()
      WHERE user_email = $1 AND id <> $2`,
    [userEmail, connectionId]
  );
  await poll.query(
    `UPDATE tbl_wordpress_connections
        SET is_primary = TRUE, updated_at = NOW()
      WHERE id = $1`,
    [connectionId]
  );
}

async function disconnect({ userEmail, connectionId }) {
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!connectionId) throw Object.assign(new Error('connection_id is required'), { status: 400 });
  await poll.query(
    `UPDATE tbl_wordpress_connections
        SET state = 'revoked',
            app_password_enc = '',
            updated_at = NOW()
      WHERE id = $1 AND user_email = $2`,
    [connectionId, userEmail]
  );
}

async function markReauthRequired({ connectionId }) {
  await poll.query(
    `UPDATE tbl_wordpress_connections SET state = 'reauth_required', updated_at = NOW() WHERE id = $1`,
    [connectionId]
  );
}

module.exports = {
  upsertConnection,
  listConnections,
  getConnectionWithToken,
  setDefaultCategory,
  setPrimaryConnection,
  disconnect,
  markReauthRequired,
};
