const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/generate', controller.generate);
router.get('/models', controller.listModels);
// Render a single HTML doc on demand from the persisted spec.
router.post('/render-doc', controller.renderDoc);
// Stream a zip containing rendered HTML docs and/or fetched image URLs.
router.post('/zip', controller.downloadZip);

module.exports = router;
