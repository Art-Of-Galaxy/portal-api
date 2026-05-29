const service = require('./service');

function userEmailFrom(req) {
  return (
    req.body?.user_email ||
    req.query?.user_email ||
    req.headers?.['x-user-email'] ||
    null
  );
}

async function startSession(req, res) {
  try {
    const { service: domain } = req.body || {};
    if (!service.isKnownService(domain)) {
      return res.status(400).json({ success: false, message: 'Unknown service' });
    }
    const session = await service.createSession({
      userEmail: userEmailFrom(req),
      service: domain,
    });
    return res.status(200).json({ success: true, session });
  } catch (err) {
    console.error('strategist/start error:', err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function getSession(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid session id' });
    }
    const session = await service.loadSession(id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    return res.status(200).json({ success: true, session });
  } catch (err) {
    console.error('strategist/get error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function listSessions(req, res) {
  try {
    const sessions = await service.listSessions({
      userEmail: userEmailFrom(req),
      service: req.query?.service || null,
    });
    return res.status(200).json({ success: true, sessions });
  } catch (err) {
    console.error('strategist/list error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function turn(req, res) {
  try {
    const id = Number(req.params.id);
    const { message, model } = req.body || {};
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid session id' });
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Missing user message' });
    }
    const session = await service.loadSession(id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    // Prefer the session's stored user_email so tools always scope to the
    // session owner even if the request didn't include the header.
    const userEmail = session.user_email || userEmailFrom(req);
    const result = await service.runTurn({
      session,
      userMessage: message.trim(),
      model,
      userEmail,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('strategist/turn error:', err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

async function destroy(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid session id' });
    }
    await service.deleteSession({ sessionId: id, userEmail: userEmailFrom(req) });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('strategist/delete error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

async function complete(req, res) {
  try {
    const id = Number(req.params.id);
    const { project_id: projectId } = req.body || {};
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid session id' });
    }
    await service.markCompleted({ sessionId: id, projectId: projectId || null });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('strategist/complete error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = {
  startSession,
  getSession,
  listSessions,
  turn,
  complete,
  destroy,
};
