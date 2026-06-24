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

  // ---------- Social Media Management ----------

  // Connected platform accounts. Tokens are AES-256-GCM encrypted at rest
  // via helper/social_tokens.js; we never store plaintext.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_social_connections (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      account_id VARCHAR(128) NOT NULL,
      account_handle VARCHAR(128),
      account_name VARCHAR(255),
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT,
      scope TEXT,
      meta JSONB,
      expires_at TIMESTAMP,
      last_validated_at TIMESTAMP,
      state VARCHAR(16) NOT NULL DEFAULT 'connected',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (user_email, platform, account_id)
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_social_conn_user ON tbl_social_connections (user_email, state);`);

  // Each generated piece of content. brief_json holds the user's input,
  // spec_json holds the Claude output, assets_json holds the generated
  // image/video URLs.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_social_posts (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      project_id INTEGER,
      content_type VARCHAR(32) NOT NULL,
      brief_json JSONB,
      spec_json JSONB,
      assets_json JSONB,
      caption TEXT,
      hashtags TEXT,
      platforms TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'draft',
      scheduled_for TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      batch_parent_id INTEGER REFERENCES tbl_social_posts(id) ON DELETE SET NULL,
      metrics_json JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_social_posts_user_state ON tbl_social_posts (user_email, status, updated_at DESC);`);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_social_posts_due ON tbl_social_posts (status, scheduled_for) WHERE status = 'scheduled';`);

  // Audit log: one row per publish attempt per platform. The scheduler
  // reads recent failures to back off and to surface "x failed to publish"
  // chips in the UI.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_social_post_runs (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES tbl_social_posts(id) ON DELETE CASCADE,
      platform VARCHAR(32) NOT NULL,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMP,
      state VARCHAR(16) NOT NULL DEFAULT 'running',
      platform_post_id VARCHAR(255),
      error_code VARCHAR(64),
      error_message TEXT
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_social_post_runs_post ON tbl_social_post_runs (post_id, started_at DESC);`);

  // ---------- Shopify Blog Engine ----------

  // Connected Shopify stores. Same token-encryption pattern as
  // tbl_social_connections (helper/social_tokens.js handles the crypto).
  // Each user can connect many stores; (user_email, shop_domain) is the
  // de-dup key. The Admin API token issued by Shopify on app install
  // does NOT expire on its own, but we keep state + last_validated_at
  // so the health probe can flip it to 'reauth_required' if the store
  // ever uninstalls the app.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_shopify_connections (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      shop_domain VARCHAR(255) NOT NULL,
      shop_name VARCHAR(255),
      shop_id VARCHAR(64),
      access_token_enc TEXT NOT NULL,
      scope TEXT,
      meta JSONB,
      default_blog_id VARCHAR(64),
      default_blog_title VARCHAR(255),
      last_validated_at TIMESTAMP,
      state VARCHAR(16) NOT NULL DEFAULT 'connected',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (user_email, shop_domain)
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_shopify_conn_user ON tbl_shopify_connections (user_email, state);`);

  // One row per generated article. brief_json is the user's input,
  // spec_json is Claude's structured output, assets_json holds the
  // featured image URL + any user-uploaded inline images. Status flow:
  // draft -> scheduled -> publishing -> published / failed. The
  // scheduler atomically claims rows where status='scheduled' AND
  // scheduled_for <= NOW().
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_blog_articles (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      shop_connection_id INTEGER REFERENCES tbl_shopify_connections(id) ON DELETE SET NULL,
      autopilot_id INTEGER,
      mode VARCHAR(32) NOT NULL DEFAULT 'single',
      keyword VARCHAR(255),
      brief_json JSONB,
      spec_json JSONB,
      assets_json JSONB,
      title TEXT,
      handle VARCHAR(255),
      meta_title TEXT,
      meta_description TEXT,
      tags TEXT,
      seo_score INTEGER,
      word_count INTEGER,
      status VARCHAR(16) NOT NULL DEFAULT 'draft',
      scheduled_for TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      shopify_article_id VARCHAR(64),
      shopify_blog_id VARCHAR(64),
      shopify_url TEXT,
      error_code VARCHAR(64),
      error_message TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_blog_articles_user_status ON tbl_blog_articles (user_email, status, updated_at DESC);`);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_blog_articles_due ON tbl_blog_articles (status, scheduled_for) WHERE status = 'scheduled';`);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_blog_articles_autopilot ON tbl_blog_articles (autopilot_id) WHERE autopilot_id IS NOT NULL;`);

  // Autopilot configs: a keyword bank + cadence + voice tied to a
  // shop. The scheduler keeps the queue full by drafting a new article
  // every time the running queued+scheduled count drops below the
  // 'queue depth' goal. One autopilot per (user_email, shop_connection_id)
  // for v1.
  await poll.query(`
    CREATE TABLE IF NOT EXISTS tbl_blog_autopilots (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(255) NOT NULL,
      shop_connection_id INTEGER NOT NULL REFERENCES tbl_shopify_connections(id) ON DELETE CASCADE,
      blog_id VARCHAR(64),
      blog_title VARCHAR(255),
      keywords_json JSONB NOT NULL,
      cadence VARCHAR(16) NOT NULL,
      publish_time VARCHAR(16) NOT NULL DEFAULT '08:00',
      timezone VARCHAR(64) DEFAULT 'UTC',
      voice_json JSONB,
      intent VARCHAR(32),
      length VARCHAR(16),
      queue_depth INTEGER NOT NULL DEFAULT 5,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      next_publish_at TIMESTAMPTZ,
      last_drafted_at TIMESTAMPTZ,
      published_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await poll.query(`CREATE INDEX IF NOT EXISTS idx_blog_autopilots_active ON tbl_blog_autopilots (status, next_publish_at) WHERE status = 'active';`);

  // Idempotent timezone migration. Earlier versions of these tables stored
  // scheduled_for / published_at / next_publish_at as TIMESTAMP (no zone).
  // The API + UI have always sent UTC ISO strings, so the stored values
  // are naive UTC. Convert them to TIMESTAMPTZ so reads come back as
  // proper UTC and pg's NOW() comparison works correctly. The
  // `USING ... AT TIME ZONE 'UTC'` clause tells postgres to treat the
  // existing naive value as UTC, which matches what we've been writing.
  // ALTER is a no-op once the column is already TIMESTAMPTZ.
  const tzCols = [
    ['tbl_social_posts',   'scheduled_for'],
    ['tbl_social_posts',   'published_at'],
    ['tbl_blog_articles',  'scheduled_for'],
    ['tbl_blog_articles',  'published_at'],
    ['tbl_blog_autopilots','next_publish_at'],
    ['tbl_blog_autopilots','last_drafted_at'],
  ];
  for (const [table, col] of tzCols) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await poll.query(
        `ALTER TABLE ${table}
            ALTER COLUMN ${col} TYPE TIMESTAMPTZ
            USING ${col} AT TIME ZONE 'UTC'`
      );
    } catch (err) {
      // pg throws if the table doesn't exist yet (first-boot ordering) or
      // if it's already TIMESTAMPTZ on some drivers. Both are harmless.
      if (!/does not exist|cannot be cast/i.test(err.message || '')) {
        console.warn(`[schema] ${table}.${col} TZ migration skipped:`, err.message || err);
      }
    }
  }
}

module.exports = {
  ensureDatabaseSchema,
};
