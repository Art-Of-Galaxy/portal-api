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
  await poll.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;`);
  await poll.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_last_login_at TIMESTAMP;`);

  // Bootstrap promotion: if ADMIN_BOOTSTRAP_EMAIL is set, flip that user's
  // is_admin flag on startup. Remove the env var afterwards. Safe to run
  // repeatedly — it just no-ops if the user already exists and is admin.
  const bootstrapEmail = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  if (bootstrapEmail) {
    await poll.query(
      `UPDATE users SET is_admin = TRUE WHERE LOWER(email) = LOWER(?)`,
      [bootstrapEmail]
    );
  }

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

  // tbl_files now serves both uploaded files and AI-generated outputs.
  // These idempotent ALTERs add per-user, per-project, and per-category context
  // so the My Files page can group them.
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES tbl_projects(id) ON DELETE SET NULL;`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS user_email VARCHAR(255);`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS category VARCHAR(100);`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS service_type VARCHAR(100);`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS source VARCHAR(20);`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100);`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS size_bytes BIGINT;`);
  await poll.query(`ALTER TABLE tbl_files ADD COLUMN IF NOT EXISTS is_delete INTEGER NOT NULL DEFAULT 0;`);

  // AI Strategist conversations. One row per chat session (per user, per
  // service like "logo_design" or "global"). Brief holds the running
  // structured intake the AI is building turn by turn. project_id is set
  // once the user clicks "Generate" and we hand the brief to the relevant
  // generator service.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_strategist_sessions (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255),
      service VARCHAR(64) NOT NULL,
      title VARCHAR(255),
      brief JSONB NOT NULL DEFAULT '{}'::jsonb,
      checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
      ready_to_generate BOOLEAN NOT NULL DEFAULT FALSE,
      state VARCHAR(32) NOT NULL DEFAULT 'in_progress',
      project_id INTEGER REFERENCES tbl_projects(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_strategist_sessions_user ON tbl_strategist_sessions (user_email, service, updated_at DESC);`);

  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_strategist_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES tbl_strategist_sessions(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL,
      content TEXT NOT NULL,
      suggestions JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_strategist_messages_session ON tbl_strategist_messages (session_id, id);`);
  // Inline attachments (images, files, deep-link cards) the assistant
  // produced via tool calls during this turn. Rendered as cards under the
  // bubble in the chat UI.
  await poll.query(`ALTER TABLE tbl_strategist_messages ADD COLUMN IF NOT EXISTS attachments JSONB;`);

  // Revision requests on generated outputs. The "Request revision"
  // button on the Logo Design result page (and any future service
  // result page) posts here with the user's notes + which concept they
  // want changed. The AOG strategist picks these up offline to action.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_project_revisions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES tbl_projects(id) ON DELETE SET NULL,
      user_email VARCHAR(255),
      service_type VARCHAR(64),
      concept_index INTEGER,
      notes TEXT NOT NULL,
      state VARCHAR(32) NOT NULL DEFAULT 'open',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_revisions_project ON tbl_project_revisions (project_id, created_at DESC);`);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_revisions_user ON tbl_project_revisions (user_email, created_at DESC);`);

  // Usage / credits tracking. One row per billable event (LLM turn,
  // image generation). The Header navbar reads aggregates from this; the
  // operator can later turn raw token counts into a "credits" abstraction
  // by tweaking the math in the usage service.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_usage (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255),
      kind VARCHAR(32) NOT NULL,
      model VARCHAR(100),
      service VARCHAR(64),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      units INTEGER NOT NULL DEFAULT 0,
      credits NUMERIC(10, 2) NOT NULL DEFAULT 0,
      meta JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_usage_user ON tbl_usage (user_email, created_at DESC);`);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_usage_kind ON tbl_usage (kind, created_at DESC);`);

  // Multi-step quiz drafts (so the "Fill it out yourself" flow can be
  // resumed across reloads / devices). Same brief shape as the strategist
  // sessions so the two flows can hand off to each other.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_quiz_drafts (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255),
      service VARCHAR(64) NOT NULL,
      step INTEGER NOT NULL DEFAULT 1,
      brief JSONB NOT NULL DEFAULT '{}'::jsonb,
      state VARCHAR(32) NOT NULL DEFAULT 'in_progress',
      project_id INTEGER REFERENCES tbl_projects(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_quiz_drafts_user ON tbl_quiz_drafts (user_email, service, updated_at DESC);`);

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
