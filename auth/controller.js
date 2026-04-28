const authService = require('./service');

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
            email: result.email
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
            name: result.name
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



module.exports = {
  login,
  googleLogin
};
