// File service: persist file metadata in tbl_files and list per user.
// Files come from two sources:
//   - 'upload'    -> the user uploaded a file via /api/files/upload
//   - 'generated' -> an AI service produced an output (e.g. logo design images)

const db_helper = require('../helper/db_helper');

function firstReturnedRow(result) {
  if (Array.isArray(result)) return result[0] || null;
  if (Array.isArray(result?.rows)) return result.rows[0] || null;
  return null;
}

function rowOrInsertId(result) {
  // dbconfig shim returns { insertId, rows: [...] } for INSERT ... RETURNING.
  if (result?.rows?.[0]) return result.rows[0];
  if (result && Array.isArray(result) && result[0]) return result[0];
  return null;
}

exports.recordFile = async ({
  projectId = null,
  projectName = null,
  fileName,
  url,
  userEmail = null,
  category = null,
  serviceType = null,
  source = 'upload',
  mimeType = null,
  sizeBytes = null,
}) => {
  if (!fileName || !url) {
    throw new Error('recordFile: fileName and url are required');
  }
  const db = await db_helper.get_db_connection();
  const sql = `
    INSERT INTO tbl_files
      (project_id, project_name, file_name, url, user_email, category, service_type, source, mime_type, size_bytes, is_delete)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    RETURNING id, project_id, project_name, file_name, url, user_email, category, service_type, source, mime_type, size_bytes, created_at
  `;
  const result = await db.query(sql, [
    projectId,
    projectName,
    fileName,
    url,
    userEmail,
    category,
    serviceType,
    source,
    mimeType,
    sizeBytes,
  ]);
  return rowOrInsertId(result);
};

exports.recordManyFiles = async (files = []) => {
  const out = [];
  for (const f of files) {
    out.push(await exports.recordFile(f));
  }
  return out;
};

exports.listFilesForUser = async ({ userEmail }) => {
  if (!userEmail) return [];
  const db = await db_helper.get_db_connection();
  const sql = `
    SELECT id, project_id, project_name, file_name, url, user_email, category,
           service_type, source, mime_type, size_bytes, created_at
    FROM tbl_files
    WHERE is_delete = 0
      AND (user_email IS NULL OR user_email = ?)
    ORDER BY created_at DESC, id DESC
  `;
  const rows = await db.query(sql, [userEmail]);
  if (!rows) return [];
  if (Array.isArray(rows)) return rows;
  return Array.isArray(rows.rows) ? rows.rows : [];
};

exports.softDeleteFile = async ({ id, userEmail }) => {
  const db = await db_helper.get_db_connection();
  const sql = `
    UPDATE tbl_files
       SET is_delete = 1
     WHERE id = ?
       AND (user_email IS NULL OR user_email = ?)
    RETURNING id
  `;
  const result = await db.query(sql, [id, userEmail || null]);
  return Boolean(firstReturnedRow(result));
};
