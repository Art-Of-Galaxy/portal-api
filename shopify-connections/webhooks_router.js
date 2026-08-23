// Shopify webhook routes.
//
// Mounted in app.js at /api/shopify/webhooks and deliberately placed
// ABOVE the global express.json(), because HMAC verification needs the
// unmodified request bytes. express.raw() with type '*/*' hands us a
// Buffer no matter what Content-Type Shopify sends.
//
// Register these URLs in the Partner Dashboard under
// App setup -> Compliance webhooks (and Webhooks for app/uninstalled):
//   .../api/shopify/webhooks/customers/data_request
//   .../api/shopify/webhooks/customers/redact
//   .../api/shopify/webhooks/shop/redact
//   .../api/shopify/webhooks/app/uninstalled

const express = require('express');
const router = express.Router();
const webhooks = require('./webhooks');

// 2mb is well above any compliance payload; app/uninstalled sends the
// full shop object and is still only a few kb.
router.use(express.raw({ type: '*/*', limit: '2mb' }));

router.post('/customers/data_request', webhooks.handle('customers/data_request'));
router.post('/customers/redact',       webhooks.handle('customers/redact'));
router.post('/shop/redact',            webhooks.handle('shop/redact'));
router.post('/app/uninstalled',        webhooks.handle('app/uninstalled'));

// Shopify only ever POSTs here. Answer anything else with 405 rather
// than letting it fall through to the SPA 404 handler.
router.all('/*splat', (_req, res) => res.status(405).json({ success: false, message: 'Method not allowed' }));

module.exports = router;
