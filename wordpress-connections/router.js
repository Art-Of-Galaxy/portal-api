const express = require('express');
const router = express.Router();
const c = require('./controller');

router.post('/',                  c.connect);
router.get('/',                   c.list);
router.get('/:id/categories',     c.listCategories);
router.patch('/:id',              c.patch);
router.patch('/:id/primary',      c.setPrimary);
router.delete('/:id',             c.destroy);

module.exports = router;
