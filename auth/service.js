const db_helper = require('../helper/db_helper');
const auth_helper = require('../helper/auth_helper');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';
const PROFILE_SELECT = `
    SELECT id, name, email, phone, dob, profile_photo_url, onboarding_data, created_at, updated_at
    FROM users
`;

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function defaultNameFromEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    return normalizedEmail ? normalizedEmail.split('@')[0] : 'User';
}

function firstReturnedRow(result) {
    if (Array.isArray(result)) return result[0] || null;
    if (Array.isArray(result?.rows)) return result.rows[0] || null;
    return null;
}

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
              profile_photo_url: result[0].profile_photo_url || null,
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
                            email: result[0].email,
                            profile_photo_url: result[0].profile_photo_url || null,
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

exports.getProfileByEmail = async (email) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    const db_poll = await db_helper.get_db_connection();
    const rows = await db_poll.query(
        `${PROFILE_SELECT}
         WHERE LOWER(email) = LOWER(?)
         LIMIT 1`,
        [normalizedEmail]
    );

    return rows && rows.length ? rows[0] : null;
};

exports.getOrCreateProfileByEmail = async (email, name) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    const existingProfile = await exports.getProfileByEmail(normalizedEmail);
    if (existingProfile) return existingProfile;

    const db_poll = await db_helper.get_db_connection();
    const inserted = await db_poll.query(
        `INSERT INTO users (email, name, active)
         VALUES (?, ?, 1)
         ON CONFLICT (email) DO UPDATE
           SET email = EXCLUDED.email
         RETURNING id`,
        [normalizedEmail, name || defaultNameFromEmail(normalizedEmail)]
    );

    if (!inserted) return null;
    return exports.getProfileByEmail(normalizedEmail);
};

exports.updateProfile = async (email, profile) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    await exports.getOrCreateProfileByEmail(normalizedEmail, profile?.name);

    const db_poll = await db_helper.get_db_connection();
    const { name, phone, dob, profile_photo_url } = profile || {};
    const result = await db_poll.query(
        `UPDATE users
         SET name = COALESCE(?, name),
             phone = COALESCE(?, phone),
             dob = COALESCE(?, dob),
             profile_photo_url = COALESCE(?, profile_photo_url),
             updated_at = NOW()
         WHERE LOWER(email) = LOWER(?)
         RETURNING id, name, email, phone, dob, profile_photo_url, onboarding_data, created_at, updated_at`,
        [
            name === undefined ? null : name,
            phone === undefined ? null : phone,
            dob === undefined ? null : dob,
            profile_photo_url === undefined ? null : profile_photo_url,
            normalizedEmail,
        ]
    );

    return firstReturnedRow(result);
};

exports.updatePassword = async (email, currentPassword, newPassword) => {
    const normalizedEmail = normalizeEmail(email);
    const db_poll = await db_helper.get_db_connection();
    const rows = await db_poll.query(
        `SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND password = ? LIMIT 1`,
        [normalizedEmail, currentPassword]
    );

    if (!rows || !rows.length) {
        return { success: false, message: 'Current password is incorrect' };
    }

    await db_poll.query(
        `UPDATE users SET password = ?, updated_at = NOW() WHERE LOWER(email) = LOWER(?)`,
        [newPassword, normalizedEmail]
    );

    return { success: true };
};

exports.saveOnboarding = async (email, onboardingData) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    await exports.getOrCreateProfileByEmail(normalizedEmail);

    const db_poll = await db_helper.get_db_connection();
    const result = await db_poll.query(
        `UPDATE users
         SET onboarding_data = ?::jsonb,
             phone = COALESCE(?, phone),
             updated_at = NOW()
         WHERE LOWER(email) = LOWER(?)
         RETURNING id, name, email, phone, dob, profile_photo_url, onboarding_data, created_at, updated_at`,
        [
            JSON.stringify(onboardingData || {}),
            onboardingData?.business?.phone || null,
            normalizedEmail,
        ]
    );

    return firstReturnedRow(result);
};

exports.getServiceContextByEmail = async (email) => {
    if (!email) return null;
    const profile = await exports.getProfileByEmail(email);
    if (!profile) return null;

    return {
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        onboarding: profile.onboarding_data || null,
    };
};

