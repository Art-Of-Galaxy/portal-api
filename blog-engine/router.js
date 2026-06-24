const express = require('express');
const router = express.Router();
const c = require('./controller');

// Article CRUD + generation
router.post('/generate',           c.generate);
router.post('/save',               c.save);
router.post('/bulk',               c.bulk);
router.post('/:id/publish',        c.publishNow);
router.get('/library',             c.library);
router.get('/stats',               c.stats);
router.get('/articles/:id',        c.getArticle);

// Autopilot
router.post('/autopilot',          c.createOrUpdateAutopilot);
router.get('/autopilot',           c.listAutopilots);
router.patch('/autopilot/:id',     c.patchAutopilot);
router.delete('/autopilot/:id',    c.destroyAutopilot);

// Ops + cron (called by Vercel Cron Jobs; auth via CRON_SECRET)
router.post('/run-scheduler',      c.runScheduler);
router.get('/cron/publish',        c.cronPublishTick);
router.get('/cron/autopilot',      c.cronAutopilotTick);
router.get('/scheduler-health',    c.schedulerHealth);

module.exports = router;
