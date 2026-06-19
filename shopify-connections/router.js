const express = require('express');
const router = express.Router();
const controller = require('./controller');

router.post('/start',           controller.start);
router.get('/callback',         controller.callback);
router.get('/',                 controller.list);
router.get('/:id/blogs',        controller.listBlogs);
router.patch('/:id',            controller.patch);
router.delete('/:id',           controller.destroy);

module.exports = router;
