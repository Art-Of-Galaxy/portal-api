const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const controller = require('./controller');

const UPLOAD_ROOT = controller.uploadsRootDir();
if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    cb(null, `${stamp}-${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter(_req, _file, cb) {
    // Accept any file type for now; tighten later if needed.
    cb(null, true);
  },
});

const router = express.Router();

router.post('/upload', upload.single('file'), controller.upload);
router.get('/', controller.list);
router.delete('/:id', controller.remove);

module.exports = router;
