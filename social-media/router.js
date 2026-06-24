const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/generate',           controller.generate);
router.post('/save',               controller.save);
router.post('/:id/publish',        controller.publishNow);
router.get('/library',             controller.library);
router.get('/stats',               controller.stats);
router.post('/run-scheduler',      controller.runScheduler);
router.get('/cron/publish',        controller.cronPublishTick);
router.get('/scheduler-health',    controller.schedulerHealth);
// Single-post fetch — Hub cards link here so the Create flow can
// jump straight to Preview / Schedule instead of re-running the brief.
// Declared LAST so '/library' and '/stats' aren't shadowed by '/:id'.
router.get('/posts/:id',           controller.getPost);

module.exports = router;
