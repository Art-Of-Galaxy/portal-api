const express = require('express');
const router = express.Router();
const controller = require('./controller');

// Resume / list / inspect
router.get('/sessions', controller.listSessions);
router.get('/sessions/:id', controller.getSession);

// Start a fresh conversation for a given service ("logo_design" today,
// "global" for the dashboard-wide assistant, more as we add them).
router.post('/sessions', controller.startSession);

// Push the user's latest message and get the assistant's next reply.
router.post('/sessions/:id/turn', controller.turn);

// Mark the session as completed once the brief has been handed off to a
// generator service (project_id is the resulting tbl_projects row).
router.post('/sessions/:id/complete', controller.complete);

module.exports = router;
