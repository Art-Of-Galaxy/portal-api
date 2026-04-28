const Cryptojs = require('crypto-js');

const secretKey = process.env.SECRET_KEY;

async function encrypt(text) {
  if (!text) return null;
  const ciphertext = Cryptojs.AES.encrypt(text.toString(), secretKey).toString();
  return ciphertext;
}

async function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const bytes = Cryptojs.AES.decrypt(ciphertext, secretKey);
  const originalText = bytes.toString(Cryptojs.enc.Utf8);
  return originalText;
}

module.exports = {
  encrypt,
  decrypt
};
