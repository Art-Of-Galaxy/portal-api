const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/generate', controller.generate);
router.get('/modes', controller.listModes);

module.exports = router;
