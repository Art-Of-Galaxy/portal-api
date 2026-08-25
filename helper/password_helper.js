// Password hashing with Node's built-in scrypt (no new dependency).
//
// Stored format: "scrypt$<salt-hex>$<hash-hex>"
//
// Legacy compatibility: rows created before hashing landed hold the
// plaintext password. verify() transparently accepts those so existing
// users can still log in; callers should re-hash + persist on a
// successful legacy match (see upgradeIfLegacy usage in auth/service).

const crypto = require('crypto');

const KEY_LEN = 64;
const PREFIX = 'scrypt';

function hash(plain) {
  const pwd = String(plain ?? '');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pwd, salt, KEY_LEN).toString('hex');
  return `${PREFIX}$${salt}$${derived}`;
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(`${PREFIX}$`);
}

// Returns { ok: boolean, legacy: boolean }.
// legacy=true means the stored value was plaintext and matched: the
// caller should upgrade the row to the hashed format.
function verify(plain, stored) {
  const pwd = String(plain ?? '');
  const s = String(stored ?? '');
  if (!s) return { ok: false, legacy: false };

  if (isHashed(s)) {
    const [, salt, expectedHex] = s.split('$');
    if (!salt || !expectedHex) return { ok: false, legacy: false };
    const derived = crypto.scryptSync(pwd, salt, KEY_LEN);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return { ok: false, legacy: false };
    return { ok: crypto.timingSafeEqual(derived, expected), legacy: false };
  }

  // Legacy plaintext row. Constant-time compare on equal-length buffers.
  const a = Buffer.from(pwd);
  const b = Buffer.from(s);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, legacy: ok };
}

module.exports = { hash, verify, isHashed };
