// Revision request persistence. Captures end-user feedback on a
// generated deliverable (e.g. "concept 2 is the closest but I want it
// in burgundy not red") so the AOG strategist can action it offline.

const { poll } = require('../config/dbconfig');

async function createRevision({ projectId, userEmail, serviceType, conceptIndex, notes }) {
  const trimmedNotes = String(notes || '').trim();
  if (!trimmedNotes) {
    throw Object.assign(new Error('Revision notes are required'), { status: 400 });
  }
  const insert = await poll.query(
    `INSERT INTO tbl_project_revisions
       (project_id, user_email, service_type, concept_index, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, service_type, concept_index, notes, state, created_at`,
    [
      Number.isInteger(projectId) ? projectId : null,
      userEmail || null,
      serviceType || null,
      Number.isInteger(conceptIndex) ? conceptIndex : null,
      trimmedNotes.slice(0, 2000),
    ]
  );
  return insert.rows[0];
}

async function listForProject({ projectId, userEmail }) {
  const params = [];
  const where = [];
  if (projectId) {
    params.push(projectId);
    where.push(`project_id = $${params.length}`);
  }
  if (userEmail) {
    params.push(userEmail);
    where.push(`user_email = $${params.length}`);
  }
  if (!where.length) return [];
  const rows = await poll.query(
    `SELECT id, project_id, service_type, concept_index, notes, state, created_at
       FROM tbl_project_revisions
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC LIMIT 50`,
    params
  );
  return rows || [];
}

module.exports = { createRevision, listForProject };
