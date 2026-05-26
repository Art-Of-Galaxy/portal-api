// Quiz draft persistence. The "Fill it out yourself" flow saves a draft
// after every step so the user can close the tab and come back later
// (across devices, since this is Postgres-backed).

const { poll } = require('../config/dbconfig');

const ALLOWED_SERVICES = new Set([
  'logo_design',
  'brand_guidelines',
  'rebranding',
  'ecommerce_mockups',
]);

function assertService(service) {
  if (!ALLOWED_SERVICES.has(service)) {
    throw Object.assign(new Error('Unknown service for quiz draft'), { status: 400 });
  }
}

async function findOrCreateActive({ userEmail, service }) {
  assertService(service);

  // Prefer the most recent in_progress draft for this user + service so the
  // user picks up where they left off. SELECT goes through the poll
  // wrapper which unwraps to a raw rows array (see config/dbconfig.js).
  if (userEmail) {
    const existing = await poll.query(
      `SELECT id, user_email, service, step, brief, state, project_id, created_at, updated_at
         FROM tbl_quiz_drafts
        WHERE user_email = $1 AND service = $2 AND state = 'in_progress'
        ORDER BY updated_at DESC LIMIT 1`,
      [userEmail, service]
    );
    if (existing?.length) return existing[0];
  }

  const insert = await poll.query(
    `INSERT INTO tbl_quiz_drafts (user_email, service, step, brief, state)
     VALUES ($1, $2, 1, '{}'::jsonb, 'in_progress')
     RETURNING id, user_email, service, step, brief, state, project_id, created_at, updated_at`,
    [userEmail || null, service]
  );
  return insert.rows[0];
}

async function loadDraft(id) {
  // SELECT goes through the poll wrapper which returns the raw rows array.
  const rows = await poll.query(
    `SELECT id, user_email, service, step, brief, state, project_id, created_at, updated_at
       FROM tbl_quiz_drafts WHERE id = $1`,
    [id]
  );
  return rows?.[0] || null;
}

async function updateDraft({ id, step, brief }) {
  const draft = await loadDraft(id);
  if (!draft) throw Object.assign(new Error('Draft not found'), { status: 404 });
  // Spreading a nullish value is a no-op, so the optional `|| {}` guards
  // weren't doing anything useful.
  const mergedBrief = { ...draft.brief, ...brief };
  const nextStep = Number.isInteger(step) ? step : draft.step;
  const r = await poll.query(
    `UPDATE tbl_quiz_drafts
        SET step = $2, brief = $3::jsonb, updated_at = NOW()
      WHERE id = $1
      RETURNING id, user_email, service, step, brief, state, project_id, created_at, updated_at`,
    [id, nextStep, JSON.stringify(mergedBrief)]
  );
  return r.rows[0];
}

async function completeDraft({ id, projectId }) {
  await poll.query(
    `UPDATE tbl_quiz_drafts
        SET state = 'completed', project_id = COALESCE($2, project_id), updated_at = NOW()
      WHERE id = $1`,
    [id, projectId || null]
  );
}

module.exports = {
  findOrCreateActive,
  loadDraft,
  updateDraft,
  completeDraft,
};
