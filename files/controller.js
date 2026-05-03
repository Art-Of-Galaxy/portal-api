const fs = require('fs');
const path = require('path');
const fileService = require('./service');

const UPLOADS_PUBLIC_PATH = '/uploads';

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

    const url = publicUrlForUploadedFile(req, req.file.filename);

    const record = await fileService.recordFile({
      projectId,
      projectName: safeString(req.body?.project_name),
      fileName: req.file.originalname || req.file.filename,
      url,
      userEmail,
      category: safeString(req.body?.category),
      serviceType: safeString(req.body?.service_type),
      source: 'upload',
      mimeType: req.file.mimetype || null,
      sizeBytes: req.file.size || null,
    });

    return res.status(200).json({
      success: true,
      file: record,
      url,
    });
  } catch (err) {
    console.error('files/upload error:', err);
    // Best-effort cleanup of the orphaned file on disk if persistence failed.
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

// Helper used by other services to expose the uploads dir path.
function uploadsRootDir() {
  return path.join(__dirname, '..', 'uploads');
}

module.exports = {
  upload,
  list,
  remove,
  uploadsRootDir,
};
