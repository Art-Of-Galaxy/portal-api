const express = require('express');
const router = express.Router();
const notioncontroller = require('./controller');
const passport = require('../config/passport');
const jwt = require('jsonwebtoken');

router.post('/get_projects', notioncontroller.get_projects);
router.post('/add_project', notioncontroller.add_project);
router.post('/generatelogo', notioncontroller.generateLogo);
router.post('/get_project_priority', notioncontroller.get_project_priority);
router.post('/get_project_status', notioncontroller.get_project_priority);
router.post('/add_task', notioncontroller.add_task);
router.post('/get_task', notioncontroller.get_task);
router.post('/save_file', notioncontroller.save_file);
router.post('/get_files', notioncontroller.get_files);
router.post('/get_project_by_id', notioncontroller.get_project_by_id);
router.post('/delete_project', notioncontroller.delete_project);

module.exports = router;
