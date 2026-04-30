const { poll } = require('./dbconfig');

async function ensureDatabaseSchema() {
  await poll.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255),
      dob DATE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await poll.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(100);`);
  await poll.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;`);
  await poll.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_data JSONB;`);

  await poll.query(`
    CREATE TABLE IF NOT EXISTS project_priority (
      id INTEGER PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE
    );
  `);

  await poll.query(`
    CREATE TABLE IF NOT EXISTS project_status (
      id INTEGER PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE
    );
  `);

  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_projects (
      id SERIAL PRIMARY KEY,
      project_name VARCHAR(255) NOT NULL,
      assignee VARCHAR(255),
      assign_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date DATE,
      tags VARCHAR(255),
      status INTEGER NOT NULL DEFAULT 2,
      priority INTEGER NOT NULL DEFAULT 1,
      org_id INTEGER NOT NULL DEFAULT 1,
      created_date DATE,
      is_delete INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Idempotent ALTERs: extend tbl_projects with service-request fields.
  await poll.query(`ALTER TABLE tbl_projects ADD COLUMN IF NOT EXISTS category VARCHAR(100);`);
  await poll.query(`ALTER TABLE tbl_projects ADD COLUMN IF NOT EXISTS service_type VARCHAR(100);`);
  await poll.query(`ALTER TABLE tbl_projects ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);`);
  await poll.query(`ALTER TABLE tbl_projects ADD COLUMN IF NOT EXISTS input_data JSONB;`);
  await poll.query(`ALTER TABLE tbl_projects ADD COLUMN IF NOT EXISTS output_data JSONB;`);
  await poll.query(`ALTER TABLE tbl_projects ADD COLUMN IF NOT EXISTS model VARCHAR(100);`);

  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES tbl_projects(id) ON DELETE CASCADE,
      task_name VARCHAR(255) NOT NULL,
      assignee INTEGER,
      assign_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date DATE,
      status INTEGER NOT NULL DEFAULT 2,
      priority INTEGER NOT NULL DEFAULT 1
    );
  `);

  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_files (
      id SERIAL PRIMARY KEY,
      project_name VARCHAR(255),
      file_name VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await poll.query(`
    INSERT INTO project_priority (id, name)
    VALUES
      (1, 'Low'),
      (2, 'Medium'),
      (3, 'High')
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name;
  `);

  await poll.query(`
    INSERT INTO project_status (id, name)
    VALUES
      (1, 'In Progress'),
      (2, 'Pending'),
      (3, 'Done')
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name;
  `);
}

module.exports = {
  ensureDatabaseSchema,
};
