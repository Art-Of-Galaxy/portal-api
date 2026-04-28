const db_helper = require('../helper/db_helper');
const auth_helper = require('../helper/auth_helper');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';
exports.login = (req, res) => {
  return new Promise((resolve, reject) => {
    const { email, password } = req.body;

    db_helper.get_db_connection(req)
      .then((db) => {
        const sql = `SELECT * FROM users WHERE email = ? AND password = ?`;
        db.query(sql, [email, password], async (err, result) => {
          if (err) {
            console.error("Error executing query:", err);
            return reject(err);
          }

          if (result.length) {
            console.log('resultlogin', result[0].id);
            const token = jwt.sign(
                  { email: result[0].email },
                  jwtSecret,
                  { expiresIn: '1h' }
                );
            console.log('resulttoken', token);
            resolve({
              success: true,
              token: token,
              name: result[0].name,
              email: result[0].email,
            });
          } else {
            resolve({ success: false });
          }
        });
      })
      .catch(reject);
  });
};


exports.googleLogin = async (email, name) => {
    return new Promise(async (resolve, reject) => {
        try {
            let db_poll = await db_helper.get_db_connection();

            let sql = `SELECT * FROM users WHERE email = ?`;
            db_poll.query(sql, [email], async (err, result) => {
                if (err) {
                    console.error('Error executing query:', err);
                    return reject({ success: false, message: 'Database error', error: err.message });
                }

                if (result.length > 0) {
                    // User exists
                    console.log('resultgoogleLogin', result[0].id);
                    
                    try {
                        const token = await auth_helper.encrypt(result[0].id);
                        resolve({
                            success: true,
                            token: token,
                            name: result[0].name,
                            email: result[0].email
                        });
                    } catch (encryptErr) {
                        console.error('Error encrypting ID:', encryptErr);
                        reject({ success: false, message: 'Token generation failed', error: encryptErr.message });
                    }
                } else {
                    // User does not exist, insert new user
                    const userName = name || email.split('@')[0];
                    const insertSql = `INSERT INTO users (email, name) VALUES (?, ?) RETURNING id`;
                    db_poll.query(insertSql, [email, userName], async (insertErr, insertResult) => {
                        if (insertErr) {
                            console.error('Error inserting user:', insertErr);
                            return reject({ success: false, message: 'User creation failed', error: insertErr.message });
                        }

                        const newUserId = insertResult.insertId;

                        try {
                            const token = await auth_helper.encrypt(newUserId);
                            resolve({
                                success: true,
                                token: token,
                                email: email
                            });
                        } catch (encryptErr) {
                            console.error('Error encrypting ID after insert:', encryptErr);
                            reject({ success: false, message: 'Token generation failed', error: encryptErr.message });
                        }
                    });
                }
            });
        } catch (err) {
            console.error('Unexpected error:', err);
            reject({ success: false, message: 'Unexpected error', error: err.message });
        }
    });
};

