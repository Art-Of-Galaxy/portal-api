const express = require('express');
const path = require('path');
const multer = require('multer');
const multerS3 = require('multer-s3');
const controller = require('./controller');
const s3 = require('../helper/s3_storage');

// Pick the storage backend at module load. We don't read env vars again per
// request, so toggling AWS keys requires a restart.
function buildStorage() {
  if (s3.isConfigured()) {
    return multerS3({
      s3: s3.getClient(),
      bucket: s3.getBucket(),
      // Pick the Content-Type from the key extension first (authoritative,
      // since we control the key), and fall back to multer-s3's content-type
      // sniffing of the upload stream. This avoids storing octet-stream when
      // the browser doesn't send a useful mimetype.
      contentType(_req, file, cb) {
        const desired =
          s3.contentTypeFromExt(file.originalname?.split('.').pop()) ||
          file.mimetype ||
          'application/octet-stream';
        cb(null, desired);
      },
      // Force inline rendering — without this some browsers see an unfamiliar
      // Content-Type and download the file instead of displaying it.
      contentDisposition: 'inline',
      cacheControl: 'public, max-age=31536000, immutable',
      key(_req, file, cb) {
        const key = s3.keyForUpload({
          prefix: 'uploads',
          originalName: file.originalname,
          contentType: file.mimetype,
        });
        cb(null, key);
      },
    });
  }

  // Local-disk fallback for dev. Multer's destination callback runs per
  // request, so the mkdir is lazy and per-request — safe on serverless too
  // (won't crash module load if the dir isn't writable).
  return multer.diskStorage({
    async destination(_req, _file, cb) {
      try {
        const dir = await controller.ensureUploadsDir();
        if (!dir) {
          return cb(new Error('Upload directory is not writable on this host.'));
        }
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
      const stamp = Date.now().toString(36);
      const rand = Math.random().toString(36).slice(2, 8);
      cb(null, `${stamp}-${rand}${ext}`);
    },
  });
}

const upload = multer({
  storage: buildStorage(),
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

// Maintenance — gated by MAINTENANCE_SECRET env var. See controller for
// usage. Intentionally underscore-prefixed so it's obviously not part of
// the user-facing API.
router.post('/_repair-content-types', controller.repairContentTypes);

module.exports = router;
