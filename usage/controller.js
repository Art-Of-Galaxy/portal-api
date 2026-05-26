const service = require('./service');

function userEmailFrom(req) {
  return (
    req.body?.user_email ||
    req.query?.user_email ||
    req.headers?.['x-user-email'] ||
    null
  );
}

async function summary(req, res) {
  try {
    const sinceDays = Math.min(Math.max(Number(req.query?.since_days) || 30, 1), 365);
    const data = await service.getSummary({
      userEmail: userEmailFrom(req),
      sinceDays,
    });
    return res.status(200).json({ success: true, summary: data });
  } catch (err) {
    console.error('usage/summary error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

module.exports = { summary };
