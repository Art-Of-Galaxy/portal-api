const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/generate',           controller.generate);
router.post('/save',               controller.save);
router.post('/:id/publish',        controller.publishNow);
router.get('/library',             controller.library);
router.get('/stats',               controller.stats);
router.post('/run-scheduler',      controller.runScheduler);

module.exports = router;
