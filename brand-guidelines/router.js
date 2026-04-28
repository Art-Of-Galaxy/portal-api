const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/generate', controller.generate);
router.get('/models', controller.listModels);

module.exports = router;
