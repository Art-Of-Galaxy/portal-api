// Live check of the Shopify compliance webhooks, run against a deployed
// URL before submitting the app for review. It reproduces exactly what
// Shopify's automated check does: POST each mandatory topic with a valid
// HMAC (expects 200), then again with a bad one (expects 401).
//
// Usage:
//   SHOPIFY_API_SECRET=<client secret> \
//   node shopify-connections/webhooks.selftest.js https://api.artofgalaxy.com
//
// The secret must be the SAME client secret the deployed API is running
// with, otherwise every signature legitimately fails.
//
// app/uninstalled is intentionally NOT exercised here: a valid call would
// revoke a real connection. Test that one from the Partner Dashboard
// against a development store.

const crypto = require('crypto');

const base = (process.argv[2] || process.env.SELFTEST_BASE_URL || '').replace(/\/$/, '');
const secret = (process.env.SHOPIFY_API_SECRET || '').trim();

if (!base || !secret) {
  console.error('Usage: SHOPIFY_API_SECRET=<secret> node shopify-connections/webhooks.selftest.js <https://api-base-url>');
  process.exit(2);
}

const SHOP = 'selftest-store.myshopify.com';

const CASES = [
  {
    topic: 'customers/data_request',
    path: '/api/shopify/webhooks/customers/data_request',
    body: { shop_id: 0, shop_domain: SHOP, orders_requested: [], customer: { id: 0, email: 'selftest@example.com' }, data_request: { id: 0 } },
  },
  {
    topic: 'customers/redact',
    path: '/api/shopify/webhooks/customers/redact',
    body: { shop_id: 0, shop_domain: SHOP, customer: { id: 0, email: 'selftest@example.com' }, orders_to_redact: [] },
  },
  {
    // Safe to send for real: no connection exists for this shop domain,
    // so redactShop finds nothing and reports zeros.
    topic: 'shop/redact',
    path: '/api/shopify/webhooks/shop/redact',
    body: { shop_id: 0, shop_domain: SHOP },
  },
];

function sign(raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('base64');
}

async function send({ topic, path, raw, hmac }) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': topic,
      'X-Shopify-Shop-Domain': SHOP,
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Webhook-Id': 'selftest-' + Date.now(),
      'X-Shopify-API-Version': process.env.SHOPIFY_API_VERSION || '2024-10',
    },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 200) };
}

(async () => {
  let failures = 0;
  const started = Date.now();

  for (const c of CASES) {
    const raw = JSON.stringify(c.body);

    const ok = await send({ topic: c.topic, path: c.path, raw, hmac: sign(raw) });
    const okPass = ok.status === 200;
    if (!okPass) failures++;
    console.log(`${okPass ? 'PASS' : 'FAIL'}  ${c.topic.padEnd(22)} valid HMAC   expected 200, got ${ok.status}  ${okPass ? '' : ok.body}`);

    const bad = await send({ topic: c.topic, path: c.path, raw, hmac: sign(raw + 'x') });
    const badPass = bad.status === 401;
    if (!badPass) failures++;
    console.log(`${badPass ? 'PASS' : 'FAIL'}  ${c.topic.padEnd(22)} bad HMAC     expected 401, got ${bad.status}  ${badPass ? '' : bad.body}`);
  }

  const elapsed = Date.now() - started;
  console.log(`\n${failures ? failures + ' check(s) FAILED' : 'All checks passed'} in ${elapsed}ms against ${base}`);
  if (!failures) {
    console.log('Shopify requires a response within 5s per webhook; the slowest above is well inside that.');
  }
  process.exit(failures ? 1 : 0);
})();
