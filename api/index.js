const app = require('../app');

module.exports = async (req, res) => {
  try {
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
