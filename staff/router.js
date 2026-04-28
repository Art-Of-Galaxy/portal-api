const express = require('express');
const router = express.Router();
const staffController = require('./controller');
const passport = require('../config/passport');
const jwt = require('jsonwebtoken');

router.post('/add', staffController.add);
router.post('/get', staffController.get);

module.exports = router;