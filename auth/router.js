const express = require('express');
const router = express.Router();
const authController = require('./controller');
const passport = require('../config/passport');
const jwt = require('jsonwebtoken');
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';
const isGoogleOauthEnabled =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_CALLBACK_URL;

function authenticateRequest(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.body?.token;
    const fallbackEmail = req.headers['x-user-email'] || req.body?.user_email;

    if (!token) {
      return res.status(401).json({ status: false, message: 'Missing authorization token' });
    }

    const decoded = jwt.verify(token, jwtSecret);
    req.user = {
      ...decoded,
      email: decoded.email || decoded.user_email || fallbackEmail,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ status: false, message: 'Invalid authorization token' });
  }
}

router.post('/login', authController.login);
router.get('/profile', authenticateRequest, authController.getProfile);
router.put('/profile', authenticateRequest, authController.updateProfile);
router.put('/profile/password', authenticateRequest, authController.updatePassword);
router.post('/onboarding', authenticateRequest, authController.saveOnboarding);

// Step 1: Redirect to Google for authentication
router.get('/google', (req, res, next) => {
  if (!isGoogleOauthEnabled) {
    return res.status(503).json({
      status: false,
      message: 'Google OAuth is not configured on server.',
    });
  }

  return passport.authenticate('google', {
    scope: ['profile', 'email'],
  })(req, res, next);
});

// Step 2: Google redirects back here
router.get('/google/callback', (req, res, next) => {
  if (!isGoogleOauthEnabled) {
    return res.status(503).json({
      status: false,
      message: 'Google OAuth is not configured on server.',
    });
  }

  return passport.authenticate('google', {
    failureRedirect: frontendUrl,
    session: true,
  })(req, res, next);
}, (req, res) => {
  console.log('redircting to frontend after successful login');

  const user = req.user;
  const token = jwt.sign(
    { email: user.emails[0].value },
    jwtSecret,
    { expiresIn: '1h' }
  );

  // Redirect to frontend with token as query param
  res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
});

router.post('/authenticate', async (req, res) => {
  try {
    const token = req.body.token;
    const decoded = jwt.verify(token, jwtSecret);
    const ressult = await authController.googleLogin(decoded.email);

    if (ressult.status) {
      const token = jwt.sign(
        { email: ressult.user.email },
        jwtSecret,
        { expiresIn: '1h' }
      );

      return res.json({
        status: true,
        message: 'Authentication successful',
        token: token,
        user: {
          email: ressult.user.email,
          name: ressult.user.name,
          profile_photo_url: ressult.user.profile_photo_url || null,
        },
      });
    }

    return res.status(401).json({
      status: false,
      message: 'Invalid credentials',
    });
  } catch (err) {
    console.error('Authentication failed:', err);
    return res.status(500).json({
      status: false,
      message: 'Authentication failed',
      error: err.message,
    });
  }
});

module.exports = router;
