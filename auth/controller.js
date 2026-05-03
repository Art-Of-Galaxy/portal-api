const authService = require('./service');

function getRequestEmail(req) {
  return (
    req.user?.email ||
    req.headers['x-user-email'] ||
    req.body?.user_email ||
    ''
  );
}

let login = async (req, res) => {
  try {
    const result = await authService.login(req, res);
    if (result.success) {
      res.status(200).json({
          message: 'Login successful',
          token: result.token,
          status: true,
          user: {
            name: result.name,
            email: result.email,
            profile_photo_url: result.profile_photo_url || null,
          }
        });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
};
let googleLogin = async (email) => {
  return new Promise(async (resolve, reject) => {
    try {
      const result = await authService.googleLogin(email);

      if (result.success) {
        resolve({
          status: true,
          message: 'Login successful',
          token: result.token,
          user: {
            email: result.email,
            name: result.name,
            profile_photo_url: result.profile_photo_url || null,
          }
        });
      } else {
        resolve({
          status: false,
          message: 'Invalid credentials'
        });
      }
    } catch (error) {
      reject({
        status: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });
};

let getProfile = async (req, res) => {
  try {
    const email = getRequestEmail(req);
    if (!email) {
      return res.status(400).json({ status: false, message: 'Missing user email' });
    }

    const profile = await authService.getOrCreateProfileByEmail(email, req.user?.name);
    if (!profile) {
      return res.status(404).json({ status: false, message: 'Profile not found' });
    }
    return res.status(200).json({ status: true, profile });
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
};

let updateProfile = async (req, res) => {
  try {
    const email = getRequestEmail(req);
    if (!email) {
      return res.status(400).json({ status: false, message: 'Missing user email' });
    }

    const profile = await authService.updateProfile(email, req.body || {});
    if (!profile) {
      return res.status(404).json({ status: false, message: 'Profile not found' });
    }
    return res.status(200).json({ status: true, profile });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
};

let updatePassword = async (req, res) => {
  try {
    const email = getRequestEmail(req);
    if (!email) {
      return res.status(400).json({ status: false, message: 'Missing user email' });
    }

    const { current_password: currentPassword, new_password: newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        status: false,
        message: 'Current password and new password are required',
      });
    }

    const result = await authService.updatePassword(email, currentPassword, newPassword);
    if (!result.success) {
      return res.status(400).json({ status: false, message: result.message });
    }

    return res.status(200).json({ status: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update password error:', error);
    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
};

let saveOnboarding = async (req, res) => {
  try {
    const email = getRequestEmail(req);
    if (!email) {
      return res.status(400).json({ status: false, message: 'Missing user email' });
    }

    const profile = await authService.saveOnboarding(email, req.body?.onboarding || {});
    if (!profile) {
      return res.status(404).json({ status: false, message: 'Profile not found' });
    }
    return res.status(200).json({ status: true, profile });
  } catch (error) {
    console.error('Save onboarding error:', error);
    return res.status(500).json({ status: false, message: 'Internal server error' });
  }
};



module.exports = {
  login,
  googleLogin,
  getProfile,
  updateProfile,
  updatePassword,
  saveOnboarding
};
