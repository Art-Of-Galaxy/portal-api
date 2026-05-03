const db_helper = require('../helper/db_helper');
const auth_helper = require('../helper/auth_helper');
const jwt = require('jsonwebtoken');


// services/project.service.js

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

exports.get_project_priority = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let sql = `SELECT * FROM project_priority`;
      let db_poll = await db_helper.get_db_connection();

      db_poll.query(sql, async (err, result) => {
        if (err) {
          console.error('Error executing query:', err);
          return reject({ success: false, message: 'Database error', error: err.message });
        }

        if (result.length > 0) {
          console.log('Project priorities fetched successfully');
          return resolve({ success: true, data: result });
        }

        console.log('No project priorities found');
        return resolve({ success: false, message: 'No project priorities found' });
      });
    } catch (error) {
      console.error('Error fetching project priority:', error);
      return reject({ success: false, message: 'Unexpected error', error: error.message });
    }
  });
};

exports.get_project_status = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let sql = `SELECT * FROM project_status`;
      let db_poll = await db_helper.get_db_connection();

      db_poll.query(sql, async (err, result) => {
        if (err) {
          console.error('Error executing query:', err);
          return reject({ success: false, message: 'Database error', error: err.message });
        }

        if (result.length > 0) {
          console.log('Project statuses fetched successfully');
          return resolve({ success: true, data: result });
        }

        console.log('No project statuses found');
        return resolve({ success: false, message: 'No project statuses found' });
      });
    } catch (error) {
      console.error('Error fetching project status:', error);
      return reject({ success: false, message: 'Unexpected error', error: error.message });
    }
  });
};
exports.add_project = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let db_poll = await db_helper.get_db_connection();

      console.log('Adding project with data:', req.body);

      const userEmail = normalizeEmail(req.body?.user_email || req.headers?.['x-user-email']);

      // Corrected insert query with 11 placeholders
      const insertSql = `
        INSERT INTO tbl_projects 
        (project_name, assignee, assign_to, due_date, tags, status, priority, org_id, created_date, is_delete, user_email) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `;

      db_poll.query(insertSql, [
        req.body.name,          // project_name
        req.body.ownerId,       // assignee
        req.body.assign_to,     // assign_to
        req.body.endDate,       // due_date
        req.body.tags,          // tags
        req.body.status,        // status
        req.body.priority,      // priority
        1,                      // org_id (hardcoded)
        req.body.startDate,     // created_date
        0,                     // is_delete (default set)
        userEmail || null      // project owner
      ], async (insertErr, insertResult) => {
        if (insertErr) {
          console.error('Error inserting project:', insertErr);
          return reject({ success: false, message: 'Project creation failed', error: insertErr.message });
        }

        const newProjectId = insertResult.insertId;
        console.log('New project inserted with ID:', newProjectId);

        resolve({
          success: true,
          message: 'Project inserted successfully',
          projectId: newProjectId
        });
      });
    } catch (err) {
      console.error('Unexpected error:', err);
      reject({ success: false, message: 'Unexpected error', error: err.message });
    }
  });
};

exports.get_projects = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let db_poll = await db_helper.get_db_connection();
      const userEmail = normalizeEmail(
        (req && req.body && req.body.user_email) ||
        (req && req.headers && req.headers['x-user-email'])
      );

      const sql = `SELECT
  p.id,
  p.project_name,
  p.assignee,
  p.assign_to,
  p.due_date,
  p.tags,
  p.status,
  CASE p.status
    WHEN 1 THEN 'In Progress'
    WHEN 2 THEN 'Pending'
    WHEN 3 THEN 'Done'
    ELSE 'Not set'
  END AS status_label,
  p.priority,
  CASE p.priority
    WHEN 3 THEN 'High'
    WHEN 2 THEN 'Medium'
    WHEN 1 THEN 'Low'
    ELSE 'Not set'
  END AS priority_label,
  p.org_id,
  p.created_date,
  p.is_delete,
  p.category,
  p.service_type,
  p.user_email,
  p.model,
  u.name
FROM tbl_projects AS p
LEFT JOIN users AS u ON p.assign_to = u.id
WHERE p.is_delete = 0
  AND p.user_email IS NOT NULL
  AND LOWER(p.user_email) = LOWER(?)
ORDER BY p.id DESC;
`;

      db_poll.query(sql, [userEmail || null], async (err, result) => {
        if (err) {
          console.error('Error executing query:', err);
          return reject({ success: false, message: 'Database error', error: err.message });
        }

        if (result.length > 0) {
          console.log('Projects fetched successfully');
          return resolve({ success: true, data: result });
        }

        console.log('No projects found');
        return resolve({ success: true, data: [] });
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
      return reject({ success: false, message: 'Unexpected error', error: error.message });
    }
  });
}

exports.get_project_by_id = async ({ id, userEmail }) => {
  const db_poll = await db_helper.get_db_connection();
  const normalizedEmail = normalizeEmail(userEmail);
  const sql = `SELECT
    p.id,
    p.project_name,
    p.status,
    CASE p.status WHEN 1 THEN 'In Progress' WHEN 2 THEN 'Pending' WHEN 3 THEN 'Done' ELSE 'Not set' END AS status_label,
    p.priority,
    CASE p.priority WHEN 3 THEN 'High' WHEN 2 THEN 'Medium' WHEN 1 THEN 'Low' ELSE 'Not set' END AS priority_label,
    p.created_date,
    p.due_date,
    p.tags,
    p.category,
    p.service_type,
    p.user_email,
    p.model,
    p.input_data,
    p.output_data
  FROM tbl_projects AS p
  WHERE p.id = ?
    AND p.is_delete = 0
    AND p.user_email IS NOT NULL
    AND LOWER(p.user_email) = LOWER(?)
  LIMIT 1`;

  const rows = await db_poll.query(sql, [id, normalizedEmail || null]);
  return rows && rows.length ? rows[0] : null;
};

// Soft-delete a project. Scoped to the requesting user so a malicious caller
// can't delete somebody else's row by guessing an id. Files associated with
// the project are intentionally LEFT in place (they remain in My Files) —
// callers can delete files individually from the My Files page.
exports.delete_project = async ({ id, userEmail }) => {
  if (!id) return false;
  const db_poll = await db_helper.get_db_connection();
  const normalizedEmail = normalizeEmail(userEmail);
  const sql = `
    UPDATE tbl_projects
       SET is_delete = 1
     WHERE id = ?
       AND is_delete = 0
       AND user_email IS NOT NULL
       AND LOWER(user_email) = LOWER(?)
    RETURNING id
  `;
  const result = await db_poll.query(sql, [id, normalizedEmail || null]);
  if (!result) return false;
  if (Array.isArray(result)) return result.length > 0;
  if (Array.isArray(result.rows)) return result.rows.length > 0;
  return false;
};

// Insert a service-request project (called by brand-guidelines and future tool flows).
// Returns the new project id.
exports.save_service_request = async ({
  projectName,
  category,
  serviceType,
  userEmail,
  inputData,
  outputData,
  model,
}) => {
  const db_poll = await db_helper.get_db_connection();
  const normalizedEmail = normalizeEmail(userEmail);
  const insertSql = `
    INSERT INTO tbl_projects
      (project_name, category, service_type, user_email, input_data, output_data, model,
       status, priority, org_id, created_date, is_delete)
    VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, 1, 2, 1, CURRENT_DATE, 0)
    RETURNING id
  `;
  const result = await db_poll.query(insertSql, [
    projectName,
    category,
    serviceType,
    normalizedEmail || null,
    inputData ? JSON.stringify(inputData) : null,
    outputData ? JSON.stringify(outputData) : null,
    model || null,
  ]);
  return result.insertId;
};

exports.add_task = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let db_poll = await db_helper.get_db_connection();
      const { projectId, name,assign_to, endDate, status, priority } = req.body;

      console.log('Adding task with data:', req.body);

      // Insert new task
      const insertSql = `
        INSERT INTO tbl_tasks 
        (project_id, task_name, assignee, assign_to, due_date, status, priority) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `;

      db_poll.query(insertSql, [
        projectId,
        name,
        0,
        assign_to,
        endDate,
        status,
        priority
      ], async (insertErr, insertResult) => {
        if (insertErr) {
          console.error('Error inserting task:', insertErr);
          return reject({ success: false, message: 'Task creation failed', error: insertErr.message });
        }

        const newTaskId = insertResult.insertId;
        console.log('New task inserted with ID:', newTaskId);

        resolve({
          success: true,
          message: 'Task added successfully',
          taskId: newTaskId
        });
      });
    } catch (err) {
      console.error('Unexpected error:', err);
      reject({ success: false, message: 'Unexpected error', error: err.message });
    }
  });
}

exports.get_task = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let db_poll = await db_helper.get_db_connection();
      const { projectId } = req.body;

      console.log('Fetching tasks for project ID:', projectId);

      // Fetch tasks for the given project
      const sql = `SELECT 
      tbl_tasks.id, 
      tbl_projects.project_name, 
      tbl_tasks.task_name, 
      tbl_tasks.assignee, 
      users.name AS assign_to, 
      tbl_tasks.due_date, 
      CASE tbl_tasks.status WHEN 1 THEN 'In Progress' WHEN 2 THEN 'Pending' WHEN 3 THEN 'Done' ELSE 'Unknown' END AS status,
      CASE tbl_tasks.priority WHEN 1 THEN 'Low' WHEN 2 THEN 'Medium' WHEN 3 THEN 'High' ELSE 'Unknown' END AS priority
      FROM tbl_tasks
      LEFT JOIN tbl_projects ON tbl_projects.id = tbl_tasks.project_id
      LEFT JOIN users ON users.id = tbl_tasks.assign_to
      WHERE tbl_tasks.project_id = ?
      `;
      db_poll.query(sql, [projectId], async (err, result) => {
        if (err) {
          console.error('Error executing query:', err);
          return reject({ success: false, message: 'Database error', error: err.message });
        }

        if (result.length > 0) {
          console.log('Tasks fetched successfully');
          return resolve({ success: true, data: result });
        }

        console.log('No tasks found for project ID:', projectId);
        return resolve({ success: false, message: 'No tasks found for this project' });
      });
    } catch (error) {
      console.error('Error fetching tasks:', error);
      return reject({ success: false, message: 'Unexpected error', error: error.message });
    }
  });
}
exports.save_file = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let db_poll = await db_helper.get_db_connection();
      const { Company_name, File } = req.body;

      // console.log('Saving file for task ID:', taskId);

      // Insert new file record
      const insertSql = `
        INSERT INTO tbl_files 
        (project_name, file_name, url) 
        VALUES ('logo Design', ?, ?)
        RETURNING id
      `;

      db_poll.query(insertSql, [
        Company_name,
        File
      ], async (insertErr, insertResult) => {
        if (insertErr) {
          console.error('Error inserting file record:', insertErr);
          return reject({ success: false, message: 'File save failed', error: insertErr.message });
        }

        const newFileId = insertResult.insertId;
        console.log('New file record inserted with ID:', newFileId);

        resolve({
          success: true,
          message: 'File saved successfully',
          fileId: newFileId
        });
      });
    } catch (err) {
      console.error('Unexpected error:', err);
      reject({ success: false, message: 'Unexpected error', error: err.message });
    }
  });
}
exports.get_files = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {
      let db_poll = await db_helper.get_db_connection();

      console.log('Fetching all files');

      // Fetch all files
      const sql = `SELECT * FROM tbl_files`;
      db_poll.query(sql, async (err, result) => {
        if (err) {
          console.error('Error executing query:', err);
          return reject({ success: false, message: 'Database error', error: err.message });
        }

        if (result.length > 0) {
          console.log('Files fetched successfully');
          return resolve({ success: true, data: result });
        }

        console.log('No files found');
        return resolve({ success: false, message: 'No files found' });
      });
    } catch (error) {
      console.error('Error fetching files:', error);
      return reject({ success: false, message: 'Unexpected error', error: error.message });
    }
  });
} 

