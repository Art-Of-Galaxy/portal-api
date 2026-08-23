// Shopify webhook handlers.
//
// Two jobs:
//
//   1. The three mandatory privacy webhooks every public app must serve
//      before it passes Shopify app review:
//        customers/data_request, customers/redact, shop/redact
//      https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
//
//   2. app/uninstalled, so a store that removes the app stops being
//      hammered by the blog-engine publish cron with a dead token.
//
// Every request is authenticated by HMAC-SHA256 over the RAW request body
// using the app's client secret (SHOPIFY_API_SECRET), base64-encoded and
// compared against the X-Shopify-Hmac-Sha256 header. Anything that fails
// gets a 401: Shopify's automated app check deliberately sends a request
// with a bad signature and expects exactly that status back.
//
// IMPORTANT: webhooks_router mounts express.raw() and is wired into app.js
// BEFORE the global express.json(). Once express.json() has run, req.body
// is a parsed object and the exact bytes Shopify signed are gone;
// re-serializing them does not reproduce the same digest.

const crypto = require('crypto');
const service = require('./service');

// Timing-safe compare of the header signature against our own digest of
// the raw body. Returns false (never throws) on anything unexpected.
function verifyWebhookHmac(req) {
  const secret = (process.env.SHOPIFY_API_SECRET || '').trim();
  const header = req.get('X-Shopify-Hmac-Sha256') || '';
  const raw = req.body;
  if (!secret || !header || !Buffer.isBuffer(raw) || raw.length === 0) return false;
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(header, 'utf8');
  // timingSafeEqual throws on a length mismatch, so screen for it first.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parsePayload(req) {
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    return {};
  }
}

// The header is authoritative (it is covered by the HMAC); the payload
// field is a fallback for the topics that carry it under another name.
function shopDomainOf(req, payload) {
  return String(
    req.get('X-Shopify-Shop-Domain')
    || payload?.shop_domain
    || payload?.myshopify_domain
    || ''
  ).trim().toLowerCase();
}

// ---------------------------------------------------------------------
// Topic handlers. Each returns a small summary object that gets logged.
// Throwing makes the route reply 500 so Shopify retries.
// ---------------------------------------------------------------------

// GDPR/CCPA data export request from a shop customer.
//
// The Blog Engine never receives, requests or stores Shopify customer
// records: we hold the merchant's own store connection plus articles the
// merchant wrote. So there is no customer data to hand back. We log the
// request (the merchant has 30 days to respond to the shopper) and ack.
async function customersDataRequest({ shopDomain, payload }) {
  console.log('[shopify-webhook] customers/data_request', {
    shop: shopDomain,
    shopify_customer_id: payload?.customer?.id || null,
    data_request_id: payload?.data_request?.id || null,
    stored_customer_records: 0,
  });
  return { stored_customer_records: 0 };
}

// Erase a specific shop customer. Same reasoning as above: we store no
// Shopify customer records, so this is a no-op we acknowledge.
async function customersRedact({ shopDomain, payload }) {
  console.log('[shopify-webhook] customers/redact', {
    shop: shopDomain,
    shopify_customer_id: payload?.customer?.id || null,
    orders_to_redact: Array.isArray(payload?.orders_to_redact) ? payload.orders_to_redact.length : 0,
    deleted_customer_records: 0,
  });
  return { deleted_customer_records: 0 };
}

// Sent 48 hours after a store uninstalls the app. Erase everything we
// hold about that store: the connection row (and its encrypted admin
// token), its autopilots, and the Shopify identifiers stamped onto any
// articles we published for it.
async function shopRedact({ shopDomain }) {
  if (!shopDomain) return { skipped: 'no_shop_domain' };
  const result = await service.redactShop({ shopDomain });
  console.log('[shopify-webhook] shop/redact', { shop: shopDomain, ...result });
  return result;
}

// Not a compliance webhook, but the reason stale tokens pile up: without
// it a connection stays state='connected' forever with a token the store
// already revoked, and the publish cron keeps retrying against it.
async function appUninstalled({ shopDomain }) {
  if (!shopDomain) return { skipped: 'no_shop_domain' };
  const result = await service.markUninstalled({ shopDomain });
  console.log('[shopify-webhook] app/uninstalled', { shop: shopDomain, ...result });
  return result;
}

const HANDLERS = {
  'customers/data_request': customersDataRequest,
  'customers/redact': customersRedact,
  'shop/redact': shopRedact,
  'app/uninstalled': appUninstalled,
};

// Express handler factory. `topic` is the Shopify topic this route is
// registered for; we also check the X-Shopify-Topic header matches so a
// valid signature for one topic cannot be replayed against another.
function handle(topic) {
  return async function webhookRoute(req, res) {
    if (!verifyWebhookHmac(req)) {
      console.warn('[shopify-webhook] rejected: bad hmac', {
        topic,
        shop: req.get('X-Shopify-Shop-Domain') || null,
        webhook_id: req.get('X-Shopify-Webhook-Id') || null,
      });
      return res.status(401).json({ success: false, message: 'Invalid HMAC signature' });
    }

    const headerTopic = (req.get('X-Shopify-Topic') || '').trim().toLowerCase();
    if (headerTopic && headerTopic !== topic) {
      console.warn('[shopify-webhook] rejected: topic mismatch', { expected: topic, got: headerTopic });
      return res.status(401).json({ success: false, message: 'Topic mismatch' });
    }

    const payload = parsePayload(req);
    const shopDomain = shopDomainOf(req, payload);

    try {
      // Awaited on purpose: a 500 tells Shopify to retry, and these are
      // all single-digit-millisecond queries, well inside the 5s budget.
      await HANDLERS[topic]({ shopDomain, payload, req });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error(`[shopify-webhook] ${topic} failed:`, err.message || err);
      return res.status(500).json({ success: false, message: 'Webhook processing failed' });
    }
  };
}

module.exports = { verifyWebhookHmac, handle, HANDLERS };
