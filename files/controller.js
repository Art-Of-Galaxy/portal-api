const fs = require('fs');
const os = require('os');
const path = require('path');
const fileService = require('./service');
const s3 = require('../helper/s3_storage');

const UPLOADS_PUBLIC_PATH = '/uploads';

// Vercel / AWS Lambda mount the bundle at /var/task as a read-only filesystem.
// The only writable place there is the OS tmpdir (/tmp). Pick the writable
// path at runtime so the module can load on serverless without crashing.
//
// Note: on serverless, /tmp is ephemeral and per-instance. Files uploaded
// here will disappear between cold starts and aren't shared between lambda
// instances. For production persistence, point UPLOAD_DIR at a mounted
// volume, or migrate to object storage (Vercel Blob / S3 / Cloudinary).
const IS_SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);

function uploadsRootDir() {
  if (process.env.UPLOAD_DIR) return process.env.UPLOAD_DIR;
  if (IS_SERVERLESS) return path.join(os.tmpdir(), 'aog-uploads');
  return path.join(__dirname, '..', 'uploads');
}

let ensureDirPromise = null;
function ensureUploadsDir() {
  if (!ensureDirPromise) {
    ensureDirPromise = new Promise((resolve) => {
      const dir = uploadsRootDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
        resolve(dir);
      } catch (err) {
        // Don't crash the process — uploads will fail with a clear error
        // when the endpoint is hit, but the rest of the API stays up.
        console.error(`[files] could not create uploads dir at ${dir}:`, err.message);
        resolve(null);
      }
    });
  }
  return ensureDirPromise;
}

function publicUrlForUploadedFile(req, filename) {
  // We return a relative URL so it works regardless of the host the API is on.
  // The frontend prefixes it with VITE_PUBLIC_API_URL's origin when rendering.
  return `${UPLOADS_PUBLIC_PATH}/${filename}`;
}

function safeString(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

async function upload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const userEmail =
      safeString(req.user?.email) ||
      safeString(req.headers['x-user-email']) ||
      safeString(req.body?.user_email);

    const projectIdRaw = req.body?.project_id;
    const projectId = projectIdRaw && /^\d+$/.test(String(projectIdRaw)) ? Number(projectIdRaw) : null;

    // multer-s3 sets `location` (full https URL) and `key` (S3 object key).
    // multer disk storage sets `filename` (basename in the uploads dir).
    const url = req.file.location || publicUrlForUploadedFile(req, req.file.filename);

    const record = await fileService.recordFile({
      projectId,
      projectName: safeString(req.body?.project_name),
      fileName: req.file.originalname || req.file.filename || req.file.key,
      url,
      userEmail,
      category: safeString(req.body?.category),
      serviceType: safeString(req.body?.service_type),
      source: 'upload',
      mimeType: req.file.mimetype || req.file.contentType || null,
      sizeBytes: req.file.size || null,
    });

    return res.status(200).json({
      success: true,
      file: record,
      url,
    });
  } catch (err) {
    console.error('files/upload error:', err);
    // Best-effort cleanup of the orphaned file on local disk if persistence
    // failed. multer-s3 doesn't expose a path; cleanup of orphaned S3 objects
    // is intentionally skipped to keep this code path simple.
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function list(req, res) {
  try {
    const userEmail =
      safeString(req.user?.email) ||
      safeString(req.headers['x-user-email']) ||
      safeString(req.query?.user_email);

    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'Missing user email.' });
    }

    const files = await fileService.listFilesForUser({ userEmail });
    return res.status(200).json({ success: true, files });
  } catch (err) {
    console.error('files/list error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function remove(req, res) {
  try {
    const userEmail =
      safeString(req.user?.email) ||
      safeString(req.headers['x-user-email']) ||
      safeString(req.body?.user_email);

    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing file id.' });
    }
    const ok = await fileService.softDeleteFile({ id, userEmail });
    if (!ok) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('files/remove error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

// One-shot maintenance: fix Content-Type / Content-Disposition on existing
// S3 objects that were uploaded before the upload pipeline knew how to set
// them correctly. Safe to re-run.
//
// Usage:
//   POST /api/files/_repair-content-types
//   body: { secret: "<MAINTENANCE_SECRET env value>", prefix?: "generated/", dry_run?: true }
async function repairContentTypes(req, res) {
  try {
    const expected = process.env.MAINTENANCE_SECRET;
    if (!expected) {
      return res.status(503).json({
        success: false,
        message: 'MAINTENANCE_SECRET is not configured on the server.',
      });
    }
    const supplied = req.body?.secret || req.headers['x-maintenance-secret'];
    if (supplied !== expected) {
      return res.status(401).json({ success: false, message: 'Invalid maintenance secret.' });
    }
    if (!s3.isConfigured()) {
      return res.status(400).json({ success: false, message: 'S3 is not configured.' });
    }

    const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : '';
    const dryRun = Boolean(req.body?.dry_run);

    const result = await s3.repairContentTypes({ prefix, dryRun });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('files/repair-content-types error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = {
  upload,
  list,
  remove,
  repairContentTypes,
  uploadsRootDir,
  ensureUploadsDir,
  IS_SERVERLESS,
};
