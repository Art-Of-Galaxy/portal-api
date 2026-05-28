const service = require('./service');

function userEmailFrom(req) {
  return (
    req.body?.user_email ||
    req.query?.user_email ||
    req.headers?.['x-user-email'] ||
    null
  );
}

async function create(req, res) {
  try {
    const { project_id: projectId, service_type: serviceType, concept_index: conceptIndex, notes } = req.body || {};
    const row = await service.createRevision({
      projectId: Number(projectId) || null,
      userEmail: userEmailFrom(req),
      serviceType: serviceType || null,
      conceptIndex: Number.isInteger(Number(conceptIndex)) ? Number(conceptIndex) : null,
      notes,
    });
    return res.status(200).json({ success: true, revision: row });
  } catch (err) {
    console.error('revisions/create error:', err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function list(req, res) {
  try {
    const projectId = Number(req.query?.project_id) || null;
    const rows = await service.listForProject({
      projectId,
      userEmail: userEmailFrom(req),
    });
    return res.status(200).json({ success: true, revisions: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = { create, list };
