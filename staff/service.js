const db_helper = require('../helper/db_helper');
const auth_helper = require('../helper/auth_helper');
const jwt = require('jsonwebtoken');

exports.add = async (req, res) => {
    return new Promise(async (resolve, reject) => {
        try {
            let db_poll = await db_helper.get_db_connection();
            const { email, name, dob, password, status } = req.body;

            console.log('Adding staff with data:', req.body);

            // 1. Check if user already exists
            let checkSql = `SELECT * FROM users WHERE email = ?`;
            db_poll.query(checkSql, [email], async (err, result) => {
                if (err) {
                    console.error('Error executing query:', err);
                    return reject({ success: false, message: 'Database error', error: err.message });
                }

                if (result.length > 0) {
                    // User already exists
                    console.log('User already exists with ID:', result[0].id);
                    return reject({
                        success: false,
                        message: 'User already exists',
                        userId: result[0].id
                    });
                }

                // 2. Insert new user
                const activeStatus = Number.isInteger(Number(status)) ? Number(status) : 1;
                const insertSql = `INSERT INTO users (name, email, password, dob, active) VALUES (?, ?, ?, ?, ?) RETURNING id`;
                db_poll.query(insertSql, [name, email, password, dob, activeStatus], async (insertErr, insertResult) => {
                    if (insertErr) {
                        console.error('Error inserting user:', insertErr);
                        return reject({ success: false, message: 'User creation failed', error: insertErr.message });
                    }

                    const newUserId = insertResult.insertId;

                    console.log('New staff inserted with ID:', newUserId);
                    resolve({
                        success: true,
                        message: 'User inserted successfully',
                        userId: newUserId,
                        email: email
                    });
                });
            });
        } catch (err) {
            console.error('Unexpected error:', err);
            reject({ success: false, message: 'Unexpected error', error: err.message });
        }
    });
};
exports.get = async (req, res) => {
    return new Promise(async (resolve, reject) => {
        try {
            let db_poll = await db_helper.get_db_connection();
            const { email, name, dob, password, status } = req.body;

            console.log('Adding staff with data:', req.body);

            // 1. Check if user already exists
            let checkSql = `SELECT * FROM users ORDER BY id DESC`;
            db_poll.query(checkSql, async (err, result) => {
                if (err) {
                    console.error('Error executing query:', err);
                    return reject({ success: false, message: 'Database error', error: err.message });
                }

                if (result.length > 0) {
                    // User already exists
                    console.log('User already exists with ID:', result[0].id);
                    return resolve({
                        success: true,
                        data: result,
                    });
                }
            });
        } catch (err) {
            console.error('Unexpected error:', err);
            reject({ success: false, message: 'Unexpected error', error: err.message });
        }
    });
};

