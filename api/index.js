const app = require('../app');

function isHealthRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `https://${host}`);
  return (
    url.pathname === '/' ||
    url.pathname === '/health' ||
    url.pathname === '/api/health' ||
    url.pathname === '/api/db-health'
  );
}

module.exports = async (req, res) => {
  try {
    if (isHealthRequest(req)) {
      return app(req, res);
    }

    await app.initializeDatabaseSchema();
    return app(req, res);
  } catch (error) {
    console.error('Failed to initialize API request:', error);
    return res.status(500).json({
      status: false,
      message: 'API initialization failed',
    });
  }
};
