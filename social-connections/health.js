// Daily connection health probe.
//
// Pings every active connection against the platform that issued it.
// Meta tokens: GET /me — anything other than 200 flips the row to
// state='reauth_required'. Google tokens: try a refresh + channels.list
// — a refresh failure flips the same flag.
//
// We don't delete or blank the encrypted token on a probe failure
// because the user might still recover (e.g. they revoked then
// re-granted within the day). We just block publishing and surface a
// red "Reconnect required" banner in the Hub.

const axios = require('axios');
const cron = require('node-cron');
const { poll } = require('../config/dbconfig');
const tokens = require('../helper/social_tokens');
const oauthGoogle = require('./oauth_google');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TASK = '[social-connections:health]';
let task = null;

// Bounded concurrency: don't fire every connection in parallel against
// Meta or Google. 5 at a time keeps us comfortably under rate limits
// even on accounts with dozens of connected pages.
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor; cursor += 1;
      out[i] = await fn(items[i], i).catch((err) => ({ err }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function loadActiveConnections() {
  const rows = await poll.query(
    `SELECT id, user_email, platform, account_id, access_token_enc, refresh_token_enc, expires_at, state
       FROM tbl_social_connections
      WHERE state IN ('connected', 'reauth_required')`
  );
  return rows || [];
}

async function markValidated(id) {
  await poll.query(
    `UPDATE tbl_social_connections
        SET state = 'connected', last_validated_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id]
  );
}

async function markReauthRequired(id, reason) {
  await poll.query(
    `UPDATE tbl_social_connections
        SET state = 'reauth_required', updated_at = NOW(),
            meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('last_probe_error', $2::text, 'last_probe_at', to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
      WHERE id = $1`,
    [id, String(reason || 'unknown').slice(0, 200)]
  );
}

async function probeMeta(row) {
  let accessToken;
  try { accessToken = tokens.decrypt(row.access_token_enc); }
  catch (err) { return { ok: false, reason: 'decrypt_failed' }; }
  if (!accessToken) return { ok: false, reason: 'no_token' };
  try {
    // /me with the page token returns the page id; that's enough to
    // confirm the token is alive. We don't need any specific field.
    await axios.get(`${GRAPH_BASE}/me`, {
      params: { access_token: accessToken, fields: 'id' },
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    const data = err?.response?.data?.error;
    const code = data?.code;
    const sub = data?.error_subcode;
    return {
      ok: false,
      reason: data?.message || err.message,
      transient: code === 1 || code === 2 || code === 4 || code === 17, // generic + rate limits
      // 190 = invalid token, 102 = session expired, 463 = expired access token
      hard: code === 190 || code === 102 || code === 463 || sub === 458 || sub === 460,
    };
  }
}

async function probeGoogle(row) {
  let refreshToken;
  try { refreshToken = row.refresh_token_enc ? tokens.decrypt(row.refresh_token_enc) : null; }
  catch (err) { return { ok: false, reason: 'decrypt_failed' }; }
  if (!refreshToken) {
    // No refresh token means we can never silently keep the connection
    // alive past the 1-hour access-token TTL. Force reauth now.
    return { ok: false, reason: 'no_refresh_token', hard: true };
  }
  try {
    const creds = await oauthGoogle.refreshAccessToken(refreshToken);
    if (!creds?.access_token) return { ok: false, reason: 'refresh_returned_no_token', hard: true };
    return { ok: true };
  } catch (err) {
    const reason = err?.response?.data?.error || err.message;
    // Google returns 'invalid_grant' when the refresh token is revoked
    // or expired (90 days unused, or revoked from myaccount). That's
    // a hard failure; the user must re-grant consent.
    const hard = /invalid_grant|invalid_token|unauthorized/i.test(String(reason));
    return { ok: false, reason, hard };
  }
}

async function probeOne(row) {
  const probe = (row.platform === 'youtube') ? probeGoogle : probeMeta;
  const res = await probe(row);
  if (res.ok) {
    await markValidated(row.id);
    return { id: row.id, platform: row.platform, ok: true };
  }
  // Only flip to reauth_required on HARD failures (token revoked /
  // refresh failed). Transient network blips just leave the row at
  // whatever state it was in and we'll retry tomorrow.
  if (res.hard) {
    await markReauthRequired(row.id, res.reason);
  }
  return { id: row.id, platform: row.platform, ok: false, reason: res.reason, hard: !!res.hard };
}

async function runOnce() {
  const rows = await loadActiveConnections();
  if (!rows.length) return { checked: 0, failed: 0, reauthRequired: 0 };
  const results = await mapWithConcurrency(rows, 5, probeOne);
  const failed = results.filter((r) => !r?.ok).length;
  const reauthRequired = results.filter((r) => r?.hard).length;
  console.log(`${TASK} checked=${rows.length} failed=${failed} reauth_required=${reauthRequired}`);
  return { checked: rows.length, failed, reauthRequired };
}

function start() {
  if (task) return;
  if ((process.env.SOCIAL_HEALTH_PROBE || '').toLowerCase() === 'off') {
    console.log(`${TASK} disabled via SOCIAL_HEALTH_PROBE=off`);
    return;
  }
  // 03:17 daily. Off-peak so we don't compete with publish traffic,
  // and odd-numbered minutes to spread load across multi-instance
  // deploys that hit Meta from a shared IP.
  task = cron.schedule('17 3 * * *', () => {
    runOnce().catch((err) => console.error(`${TASK} run failed:`, err.message || err));
  }, { scheduled: true });
  console.log(`${TASK} started, runs daily at 03:17`);
}

function stop() {
  if (!task) return;
  task.stop();
  task = null;
}

module.exports = { start, stop, runOnce };
