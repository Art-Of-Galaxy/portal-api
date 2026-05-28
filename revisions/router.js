const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/', controller.create);
router.get('/', controller.list);

module.exports = router;
