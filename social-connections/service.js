// Social-platform connections: persist OAuth tokens for Instagram,
// Facebook, and YouTube against a portal user. Tokens are stored
// AES-256-GCM encrypted via helper/social_tokens.
//
// We unify both providers behind one shape so the publisher modules
// and the frontend can iterate connections without caring whether the
// underlying API is Meta Graph or Google YouTube Data v3.

const { poll } = require('../config/dbconfig');
const tokens = require('../helper/social_tokens');

const ALLOWED_PLATFORMS = new Set(['instagram', 'facebook', 'youtube']);

function assertPlatform(p) {
  if (!ALLOWED_PLATFORMS.has(p)) {
    throw Object.assign(new Error(`Unknown platform: ${p}`), { status: 400 });
  }
}

// Insert-or-update a connection. Postgres ON CONFLICT against the
// (user_email, platform, account_id) unique key so re-running OAuth on
// the same account just refreshes its tokens + expiry.
async function upsertConnection({
  userEmail,
  platform,
  accountId,
  accountHandle,
  accountName,
  accessToken,
  refreshToken,
  scope,
  meta,
  expiresAt,
}) {
  assertPlatform(platform);
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!accountId) throw Object.assign(new Error('account_id is required'), { status: 400 });

  const accessEnc = tokens.encrypt(accessToken);
  const refreshEnc = refreshToken ? tokens.encrypt(refreshToken) : null;

  const result = await poll.query(
    `INSERT INTO tbl_social_connections
        (user_email, platform, account_id, account_handle, account_name,
         access_token_enc, refresh_token_enc, scope, meta, expires_at,
         last_validated_at, state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NOW(), 'connected')
      ON CONFLICT (user_email, platform, account_id) DO UPDATE
        SET account_handle = EXCLUDED.account_handle,
            account_name   = EXCLUDED.account_name,
            access_token_enc  = EXCLUDED.access_token_enc,
            refresh_token_enc = EXCLUDED.refresh_token_enc,
            scope             = EXCLUDED.scope,
            meta              = EXCLUDED.meta,
            expires_at        = EXCLUDED.expires_at,
            last_validated_at = NOW(),
            state             = 'connected',
            updated_at        = NOW()
      RETURNING id, platform, account_id, account_handle, account_name, state, expires_at, created_at`,
    [
      userEmail,
      platform,
      String(accountId),
      accountHandle || null,
      accountName || null,
      accessEnc,
      refreshEnc,
      scope || null,
      meta ? JSON.stringify(meta) : null,
      expiresAt || null,
    ]
  );
  return result.rows?.[0] || null;
}

// List connections for a user. Tokens are never returned over the wire.
async function listConnections({ userEmail }) {
  if (!userEmail) return [];
  const rows = await poll.query(
    `SELECT id, platform, account_id, account_handle, account_name,
            scope, meta, expires_at, last_validated_at, state, created_at
       FROM tbl_social_connections
      WHERE user_email = $1 AND state = 'connected'
      ORDER BY platform ASC, created_at ASC`,
    [userEmail]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    platform: r.platform,
    account_id: r.account_id,
    account_handle: r.account_handle,
    account_name: r.account_name,
    scope: r.scope,
    meta: r.meta || null,
    expires_at: r.expires_at,
    last_validated_at: r.last_validated_at,
    state: r.state,
    created_at: r.created_at,
  }));
}

// Internal helper: fetch a connection's decrypted tokens. Only the
// publisher modules call this; we don't expose it via HTTP.
async function getConnectionWithTokens({ userEmail, platform, connectionId }) {
  const where = ['state = \'connected\''];
  const params = [];
  if (userEmail) { params.push(userEmail); where.push(`user_email = $${params.length}`); }
  if (platform)  { params.push(platform);  where.push(`platform = $${params.length}`); }
  if (connectionId) { params.push(connectionId); where.push(`id = $${params.length}`); }

  const rows = await poll.query(
    `SELECT id, user_email, platform, account_id, account_handle, account_name,
            access_token_enc, refresh_token_enc, scope, meta, expires_at, state
       FROM tbl_social_connections
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
    platform: row.platform,
    account_id: row.account_id,
    account_handle: row.account_handle,
    account_name: row.account_name,
    access_token: tokens.decrypt(row.access_token_enc),
    refresh_token: row.refresh_token_enc ? tokens.decrypt(row.refresh_token_enc) : null,
    scope: row.scope,
    meta: row.meta || null,
    expires_at: row.expires_at,
    state: row.state,
  };
}

// Soft delete (state='revoked'). Keeps the row for audit. Tokens are
// blanked so a leak of the encryption key can't replay a removed
// connection.
async function disconnect({ userEmail, connectionId }) {
  if (!userEmail) throw Object.assign(new Error('user_email is required'), { status: 400 });
  if (!connectionId) throw Object.assign(new Error('connection_id is required'), { status: 400 });
  await poll.query(
    `UPDATE tbl_social_connections
        SET state = 'revoked',
            access_token_enc = '',
            refresh_token_enc = NULL,
            updated_at = NOW()
      WHERE id = $1 AND user_email = $2`,
    [connectionId, userEmail]
  );
}

module.exports = {
  ALLOWED_PLATFORMS: Array.from(ALLOWED_PLATFORMS),
  upsertConnection,
  listConnections,
  getConnectionWithTokens,
  disconnect,
};
