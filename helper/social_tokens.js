// AES-256-GCM encryption for stored social-platform tokens.
//
// We never want plaintext OAuth access tokens sitting in the DB. The key
// lives in SOCIAL_TOKEN_ENCRYPTION_KEY as a 32-byte hex string (64 hex
// chars). Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Format on disk: "<iv-hex>:<authTag-hex>:<ciphertext-hex>".
// We can rotate the key by adding a key id prefix later; v1 keeps it
// simple with a single active key.

const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_LEN = 12;        // 96 bits is the recommended GCM IV size
const TAG_LEN = 16;       // 128-bit auth tag

function getKey() {
  const raw = (process.env.SOCIAL_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    const err = new Error('SOCIAL_TOKEN_ENCRYPTION_KEY is not set. Run: node -e "console.log(require(\\"crypto\\").randomBytes(32).toString(\\"hex\\"))" and put the result in your env.');
    err.status = 503;
    throw err;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    const err = new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
    err.status = 503;
    throw err;
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(packed) {
  if (!packed) return null;
  const parts = String(packed).split(':');
  if (parts.length !== 3) {
    throw new Error('Encrypted token is in an unexpected format.');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Encrypted token IV or auth tag length is wrong.');
  }
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return pt.toString('utf8');
}

// Convenience: returns true if the encryption key is configured. The
// connections backend uses this to short-circuit OAuth flows with a
// clear "503 Token encryption is not configured" error instead of
// throwing during a request.
function isConfigured() {
  try { getKey(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, isConfigured };
