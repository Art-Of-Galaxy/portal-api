const express = require('express');
const router = express.Router();
const controller = require('./controller');

// Start OAuth: returns the authorize URL so the frontend can window.open.
router.post('/start/:platform', controller.start);

// OAuth callbacks (the user's browser lands here via the Meta / Google
// redirect, we exchange the code and redirect them back to the portal UI).
router.get('/callback/meta', controller.callbackMeta);
router.get('/callback/google', controller.callbackGoogle);
router.get('/callback/instagram', controller.callbackInstagram);

// List the calling user's connected accounts.
router.get('/', controller.list);

// Revoke a single connection.
router.delete('/:id', controller.destroy);

module.exports = router;
