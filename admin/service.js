// Admin service — read-heavy queries that join across users, projects, files.
// Writes are kept minimal: status/priority/role updates plus soft delete.

const db_helper = require('../helper/db_helper');

function asRows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

function firstRow(result) {
  const rows = asRows(result);
  return rows.length ? rows[0] : null;
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// ----- Auth -----

exports.findAdminByCredentials = async ({ email, password }) => {
  const db = await db_helper.get_db_connection();
  const sql = `
    SELECT id, name, email, profile_photo_url, is_admin
    FROM users
    WHERE LOWER(email) = LOWER(?)
      AND password = ?
      AND is_admin = TRUE
    LIMIT 1
  `;
  const result = await db.query(sql, [normalizeEmail(email), password]);
  return firstRow(result);
};

exports.markAdminLogin = async (email) => {
  const db = await db_helper.get_db_connection();
  await db.query(
    `UPDATE users SET admin_last_login_at = NOW() WHERE LOWER(email) = LOWER(?)`,
    [normalizeEmail(email)]
  );
};

// ----- Dashboard stats -----

exports.getStats = async () => {
  const db = await db_helper.get_db_connection();

  const totals = firstRow(
    await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users)::int AS users_total,
        (SELECT COUNT(*) FROM users WHERE is_admin = TRUE)::int AS admins_total,
        (SELECT COUNT(*) FROM tbl_projects WHERE is_delete = 0)::int AS projects_total,
        (SELECT COUNT(*) FROM tbl_files WHERE is_delete = 0)::int AS files_total
    `)
  ) || {};

  const recentProjects = asRows(
    await db.query(`
      SELECT id, project_name, category, service_type, user_email, status, created_date, model
      FROM tbl_projects
      WHERE is_delete = 0
      ORDER BY id DESC
      LIMIT 10
    `)
  );

  const byService = asRows(
    await db.query(`
      SELECT
        COALESCE(service_type, 'other') AS service_type,
        COUNT(*)::int AS count
      FROM tbl_projects
      WHERE is_delete = 0
      GROUP BY 1
      ORDER BY 2 DESC
    `)
  );

  const byCategory = asRows(
    await db.query(`
      SELECT
        COALESCE(category, 'Uncategorised') AS category,
        COUNT(*)::int AS count
      FROM tbl_projects
      WHERE is_delete = 0
      GROUP BY 1
      ORDER BY 2 DESC
    `)
  );

  // Projects per day for the last 14 days.
  const timeline = asRows(
    await db.query(`
      SELECT
        TO_CHAR(created_date, 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS count
      FROM tbl_projects
      WHERE is_delete = 0
        AND created_date >= CURRENT_DATE - INTERVAL '13 days'
      GROUP BY 1
      ORDER BY 1
    `)
  );

  return {
    totals: {
      users: totals.users_total || 0,
      admins: totals.admins_total || 0,
      projects: totals.projects_total || 0,
      files: totals.files_total || 0,
    },
    recent_projects: recentProjects,
    by_service_type: byService,
    by_category: byCategory,
    timeline,
  };
};

// ----- Users -----

exports.listUsers = async ({ search = '' } = {}) => {
  const db = await db_helper.get_db_connection();
  const trimmed = String(search || '').trim();
  const pattern = trimmed ? `%${trimmed.toLowerCase()}%` : null;

  const sql = `
    SELECT
      u.id, u.name, u.email, u.phone, u.profile_photo_url,
      u.is_admin, u.active, u.created_at, u.updated_at, u.admin_last_login_at,
      u.onboarding_data,
      (SELECT COUNT(*) FROM tbl_projects p
         WHERE p.is_delete = 0 AND LOWER(p.user_email) = LOWER(u.email))::int AS project_count,
      (SELECT COUNT(*) FROM tbl_files f
         WHERE f.is_delete = 0 AND LOWER(f.user_email) = LOWER(u.email))::int AS file_count
    FROM users u
    WHERE (?::text IS NULL OR LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ?)
    ORDER BY u.id DESC
  `;
  return asRows(await db.query(sql, [pattern, pattern, pattern]));
};

exports.getUserById = async (id) => {
  const db = await db_helper.get_db_connection();
  const user = firstRow(
    await db.query(
      `SELECT id, name, email, phone, dob, profile_photo_url, is_admin, active,
              created_at, updated_at, admin_last_login_at, onboarding_data
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [id]
    )
  );
  if (!user) return null;

  const projects = asRows(
    await db.query(
      `SELECT id, project_name, category, service_type, status, priority, model,
              created_date, due_date, tags
       FROM tbl_projects
       WHERE is_delete = 0
         AND LOWER(user_email) = LOWER(?)
       ORDER BY id DESC`,
      [user.email]
    )
  );

  const files = asRows(
    await db.query(
      `SELECT id, file_name, url, category, service_type, source, mime_type,
              size_bytes, project_id, created_at
       FROM tbl_files
       WHERE is_delete = 0
         AND LOWER(user_email) = LOWER(?)
       ORDER BY id DESC`,
      [user.email]
    )
  );

  return { ...user, projects, files };
};

exports.setUserAdmin = async ({ id, isAdmin }) => {
  const db = await db_helper.get_db_connection();
  const result = await db.query(
    `UPDATE users SET is_admin = ?, updated_at = NOW()
     WHERE id = ?
     RETURNING id, email, is_admin`,
    [Boolean(isAdmin), id]
  );
  return firstRow(result);
};

exports.setUserActive = async ({ id, active }) => {
  const db = await db_helper.get_db_connection();
  const result = await db.query(
    `UPDATE users SET active = ?, updated_at = NOW()
     WHERE id = ?
     RETURNING id, email, active`,
    [active ? 1 : 0, id]
  );
  return firstRow(result);
};

// ----- Projects -----

exports.listProjects = async ({
  search = '',
  category = null,
  serviceType = null,
  userEmail = null,
  status = null,
} = {}) => {
  const db = await db_helper.get_db_connection();
  const trimmed = String(search || '').trim();
  const pattern = trimmed ? `%${trimmed.toLowerCase()}%` : null;
  const sql = `
    SELECT
      p.id, p.project_name, p.category, p.service_type, p.user_email,
      p.status,
      CASE p.status WHEN 1 THEN 'In Progress' WHEN 2 THEN 'Pending' WHEN 3 THEN 'Done' ELSE 'Not set' END AS status_label,
      p.priority,
      CASE p.priority WHEN 3 THEN 'High' WHEN 2 THEN 'Medium' WHEN 1 THEN 'Low' ELSE 'Not set' END AS priority_label,
      p.model, p.created_date, p.due_date, p.tags,
      u.name AS user_name
    FROM tbl_projects p
    LEFT JOIN users u ON LOWER(u.email) = LOWER(p.user_email)
    WHERE p.is_delete = 0
      AND (?::text IS NULL OR LOWER(p.category) = LOWER(?))
      AND (?::text IS NULL OR LOWER(p.service_type) = LOWER(?))
      AND (?::text IS NULL OR LOWER(p.user_email) = LOWER(?))
      AND (?::int  IS NULL OR p.status = ?)
      AND (?::text IS NULL OR LOWER(p.project_name) LIKE ? OR LOWER(p.user_email) LIKE ?)
    ORDER BY p.id DESC
  `;
  return asRows(
    await db.query(sql, [
      category, category,
      serviceType, serviceType,
      userEmail, userEmail,
      status === null ? null : Number(status), status === null ? null : Number(status),
      pattern, pattern, pattern,
    ])
  );
};

exports.getProjectById = async (id) => {
  const db = await db_helper.get_db_connection();
  const project = firstRow(
    await db.query(
      `SELECT
         p.id, p.project_name, p.category, p.service_type, p.user_email,
         p.status, p.priority, p.model, p.created_date, p.due_date, p.tags,
         p.input_data, p.output_data,
         u.name AS user_name, u.profile_photo_url AS user_photo
       FROM tbl_projects p
       LEFT JOIN users u ON LOWER(u.email) = LOWER(p.user_email)
       WHERE p.id = ?
         AND p.is_delete = 0
       LIMIT 1`,
      [id]
    )
  );
  if (!project) return null;

  const files = asRows(
    await db.query(
      `SELECT id, file_name, url, category, service_type, source, mime_type, size_bytes, created_at
       FROM tbl_files
       WHERE is_delete = 0 AND project_id = ?
       ORDER BY id DESC`,
      [id]
    )
  );

  return { ...project, files };
};

exports.updateProject = async ({ id, status, priority }) => {
  const db = await db_helper.get_db_connection();
  const sql = `
    UPDATE tbl_projects
       SET status = COALESCE(?, status),
           priority = COALESCE(?, priority)
     WHERE id = ?
       AND is_delete = 0
     RETURNING id, status, priority
  `;
  const result = await db.query(sql, [
    status === undefined || status === null ? null : Number(status),
    priority === undefined || priority === null ? null : Number(priority),
    id,
  ]);
  return firstRow(result);
};

exports.deleteProject = async (id) => {
  const db = await db_helper.get_db_connection();
  const result = await db.query(
    `UPDATE tbl_projects SET is_delete = 1 WHERE id = ? AND is_delete = 0 RETURNING id`,
    [id]
  );
  return Boolean(firstRow(result));
};

// ----- Files -----

exports.listFiles = async ({
  search = '',
  category = null,
  serviceType = null,
  source = null,
  userEmail = null,
} = {}) => {
  const db = await db_helper.get_db_connection();
  const trimmed = String(search || '').trim();
  const pattern = trimmed ? `%${trimmed.toLowerCase()}%` : null;
  const sql = `
    SELECT
      f.id, f.file_name, f.url, f.category, f.service_type, f.source,
      f.mime_type, f.size_bytes, f.project_id, f.user_email, f.created_at,
      u.name AS user_name
    FROM tbl_files f
    LEFT JOIN users u ON LOWER(u.email) = LOWER(f.user_email)
    WHERE f.is_delete = 0
      AND (?::text IS NULL OR LOWER(f.category) = LOWER(?))
      AND (?::text IS NULL OR LOWER(f.service_type) = LOWER(?))
      AND (?::text IS NULL OR LOWER(f.source) = LOWER(?))
      AND (?::text IS NULL OR LOWER(f.user_email) = LOWER(?))
      AND (?::text IS NULL OR LOWER(f.file_name) LIKE ?)
    ORDER BY f.id DESC
  `;
  return asRows(
    await db.query(sql, [
      category, category,
      serviceType, serviceType,
      source, source,
      userEmail, userEmail,
      pattern, pattern,
    ])
  );
};

exports.deleteFile = async (id) => {
  const db = await db_helper.get_db_connection();
  const result = await db.query(
    `UPDATE tbl_files SET is_delete = 1 WHERE id = ? AND is_delete = 0 RETURNING id`,
    [id]
  );
  return Boolean(firstRow(result));
};
