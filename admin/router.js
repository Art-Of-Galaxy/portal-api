const express = require('express');
const router = express.Router();
const controller = require('./controller');
const { requireAdmin } = require('./middleware');

// Public — admin login. Everything else is gated.
router.post('/login', controller.login);

router.use(requireAdmin);

router.get('/me', controller.me);
router.get('/stats', controller.stats);

router.get('/users', controller.listUsers);
router.get('/users/:id', controller.getUser);
router.put('/users/:id/admin', controller.setUserAdmin);
router.put('/users/:id/active', controller.setUserActive);

router.get('/projects', controller.listProjects);
router.get('/projects/:id', controller.getProject);
router.put('/projects/:id', controller.updateProject);
router.delete('/projects/:id', controller.deleteProject);

router.get('/files', controller.listFiles);
router.delete('/files/:id', controller.deleteFile);

module.exports = router;
