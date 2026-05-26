const service = require('./service');

function userEmailFrom(req) {
  return (
    req.body?.user_email ||
    req.query?.user_email ||
    req.headers?.['x-user-email'] ||
    null
  );
}

async function start(req, res) {
  try {
    const { service: domain } = req.body || {};
    const draft = await service.findOrCreateActive({
      userEmail: userEmailFrom(req),
      service: domain,
    });
    return res.status(200).json({ success: true, draft });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function get(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid draft id' });
    }
    const draft = await service.loadDraft(id);
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    return res.status(200).json({ success: true, draft });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function patch(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid draft id' });
    }
    const { step, brief } = req.body || {};
    const draft = await service.updateDraft({ id, step, brief });
    return res.status(200).json({ success: true, draft });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function complete(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid draft id' });
    }
    const { project_id: projectId } = req.body || {};
    await service.completeDraft({ id, projectId });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = { start, get, patch, complete };
