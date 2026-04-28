const staffService = require('./service');

let add = async (req, res) => {
  try {
    const result = await staffService.add(req, res);
    if (result.success) {
      res.status(200).json({ 
          message: 'added successfully', 
          status: true,
        });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
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
