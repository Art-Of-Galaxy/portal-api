const staffService = require('./service');

let add = async (req, res) => {
  try {
    const result = await staffService.add(req);
    if (result.success) {
      res.status(200).json({
          message: 'added successfully',
          status: true,
        });
    } else {
      res.status(400).json({ status: false, message: result.message || 'Signup failed' });
    }
  } catch (error) {
    // The service throws Errors with .status + a user-facing message
    // (400 validation, 409 duplicate email, 500 db). Surface them so
    // the signup form can show something actionable instead of a
    // generic "Internal server error".
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = error?.message && status !== 500
      ? error.message
      : (error?.message || 'Internal server error');
    res.status(status).json({ status: false, message });
  }
};

let get = async (req, res) => {
  try {
    const result = await staffService.get(req, res);
    if (result.success) {
      res.status(200).json({ 
          message: 'added successfully', 
          status: true,
          data: result.data
        });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
};


module.exports = {
 add,
 get
};
