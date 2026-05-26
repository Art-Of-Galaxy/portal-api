const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/', controller.start);
router.get('/:id', controller.get);
router.patch('/:id', controller.patch);
router.post('/:id/complete', controller.complete);

module.exports = router;
