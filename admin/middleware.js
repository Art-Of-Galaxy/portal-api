// Admin auth middleware. We reuse the same JWT secret as the user-facing
// auth, but admin tokens carry an extra { is_admin: true } claim that we
// verify here. Tokens are minted by admin/controller.login after checking
// users.is_admin in the DB.

const jwt = require('jsonwebtoken');

const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';

function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Missing admin token' });
    }
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded?.is_admin) {
      return res.status(403).json({ success: false, message: 'Admin role required' });
    }
    req.admin = { email: decoded.email, id: decoded.id };
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid admin token' });
  }
}

module.exports = { requireAdmin };
