const express = require('express');
const router = express.Router();
const authController = require('./controller');
const authService = require('./service');
const passport = require('../config/passport');
const jwt = require('jsonwebtoken');
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';
const isGoogleOauthEnabled =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_CALLBACK_URL;

// Helper: build a /auth/callback URL with the given query params. Encoded
// once so the frontend Authentication.jsx can drive its UI from the URL.
function callbackRedirect(params) {
  const qs = new URLSearchParams(params).toString();
  return `${frontendUrl}/auth/callback?${qs}`;
}

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
    // Log so we can tell a tampered token from a plain-expired one in
    // backend logs; the response stays generic so we don't leak details
    // to the client.
    console.warn('authenticateRequest: token rejected:', error.message || error);
    return res.status(401).json({ status: false, message: 'Invalid authorization token' });
  }
}

// Public status endpoint: tells the frontend which auth providers are
// configured. The login page reads this to hide the Google button when
// OAuth isn't set up (end-user feedback: clicking it produced a 503).
router.get('/status', (req, res) => res.status(200).json({
  status: true,
  providers: {
    google: isGoogleOauthEnabled,
    password: true,
  },
}));

router.post('/login', authController.login);
router.get('/profile', authenticateRequest, authController.getProfile);
router.put('/profile', authenticateRequest, authController.updateProfile);
router.put('/profile/password', authenticateRequest, authController.updatePassword);
router.post('/onboarding', authenticateRequest, authController.saveOnboarding);

// Step 1: Kick off Google OAuth. ?mode=login or ?mode=signup tells the
// callback how to interpret existing-vs-missing accounts. We pass the
// mode through Google's `state` parameter (Google echoes it back on the
// callback) rather than the express session, because session writes can
// race the OAuth redirect and silently lose the value.
router.get('/google', (req, res, next) => {
  if (!isGoogleOauthEnabled) {
    return res.redirect(callbackRedirect({
      status: 'error',
      reason: 'oauth_disabled',
    }));
  }

  const mode = req.query.mode === 'signup' ? 'signup' : 'login';

  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: mode,
  })(req, res, next);
});

// Step 2: Google redirects back here. We:
//   1. Authenticate the OAuth response (passport sets req.user).
//   2. Inspect req.session.oauthMode to know whether the user came from
//      the Sign In or Sign Up button.
//   3. Cross-check whether an account with that email exists.
//   4. Redirect the user to /auth/callback with a `status` that tells the
//      frontend exactly what happened — the frontend renders a modern
//      message screen (and never silently auto-creates an account).
router.get(
  '/google/callback',
  (req, res, next) => {
    if (!isGoogleOauthEnabled) {
      return res.redirect(callbackRedirect({
        status: 'error',
        reason: 'oauth_disabled',
      }));
    }
    return passport.authenticate('google', {
      failureRedirect: callbackRedirect({ status: 'error', reason: 'google_failed' }),
      session: true,
    })(req, res, next);
  },
  async (req, res) => {
    try {
      const profile = req.user || {};
      const email = profile?.emails?.[0]?.value;
      const name = profile?.displayName
        || [profile?.name?.givenName, profile?.name?.familyName].filter(Boolean).join(' ')
        || (email ? email.split('@')[0] : null);
      const photoUrl = profile?.photos?.[0]?.value || null;
      // Mode was round-tripped through Google's state parameter (see
       // the /google handler). Fall back to session, then 'login', if
       // anything goes wrong with the echo.
      const stateMode = typeof req.query?.state === 'string' ? req.query.state : '';
      const sessionMode = req.session?.oauthMode;
      const mode = (stateMode === 'signup' || stateMode === 'login')
        ? stateMode
        : (sessionMode || 'login');

      if (!email) {
        return res.redirect(callbackRedirect({ status: 'error', reason: 'missing_email' }));
      }

      const exists = await authService.userExistsByEmail(email);

      // Login flow: account must already exist.
      if (mode === 'login') {
        if (!exists) {
          return res.redirect(callbackRedirect({
            status: 'no_account',
            email,
            name: name || '',
          }));
        }
        const token = jwt.sign({ email }, jwtSecret, { expiresIn: '7d' });
        return res.redirect(callbackRedirect({
          status: 'signed_in',
          token,
          email,
          name: name || '',
          photo: photoUrl || '',
        }));
      }

      // Signup flow: must NOT already exist.
      if (exists) {
        return res.redirect(callbackRedirect({
          status: 'already_exists',
          email,
          name: name || '',
        }));
      }

      await authService.createGoogleUser({ email, name, photoUrl });
      const token = jwt.sign({ email }, jwtSecret, { expiresIn: '7d' });
      return res.redirect(callbackRedirect({
        status: 'new_account',
        token,
        email,
        name: name || '',
        photo: photoUrl || '',
      }));
    } catch (err) {
      console.error('Google callback error:', err);
      return res.redirect(callbackRedirect({ status: 'error', reason: 'server_error' }));
    }
  }
);

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
