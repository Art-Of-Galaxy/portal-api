const db_helper = require('../helper/db_helper');
const auth_helper = require('../helper/auth_helper');
const passwordHelper = require('../helper/password_helper');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_secret';
const PROFILE_SELECT = `
    SELECT id, name, email, phone, dob, profile_photo_url, onboarding_data, is_admin, created_at, updated_at
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

exports.login = (req) => {
  return new Promise((resolve, reject) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');

    if (!email || !password) {
      return resolve({ success: false });
    }

    db_helper.get_db_connection(req)
      .then((db) => {
        // Look the user up by email only (case-insensitive), then
        // verify the password in JS. This supports both scrypt-hashed
        // rows and legacy plaintext rows; legacy rows are upgraded to
        // the hashed format on a successful login.
        const sql = `SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`;
        db.query(sql, [email], (err, result) => {
          if (err) {
            console.error('login: query failed:', err);
            return reject(err);
          }

          const user = result?.[0];
          if (!user || !user.password) {
            // No such user, or a Google-only account with no password
            // set. Same generic failure so we don't leak which.
            return resolve({ success: false });
          }
          if (user.active === 0) {
            return resolve({ success: false });
          }

          const check = passwordHelper.verify(password, user.password);
          if (!check.ok) {
            return resolve({ success: false });
          }

          // Transparent upgrade: re-store legacy plaintext as scrypt.
          // Best-effort; a failure here must not block the login.
          if (check.legacy) {
            try {
              db.query(
                `UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?`,
                [passwordHelper.hash(password), user.id],
                (upErr) => {
                  if (upErr) console.warn('login: legacy password upgrade failed:', upErr.message);
                }
              );
            } catch (upErr) {
              console.warn('login: legacy password upgrade threw:', upErr.message);
            }
          }

          // 7 days to match the Google OAuth path. The old 1h expiry
          // meant users hit "Invalid authorization token" mid-session.
          const token = jwt.sign({ email: user.email }, jwtSecret, { expiresIn: '7d' });
          resolve({
            success: true,
            token,
            name: user.name,
            email: user.email,
            profile_photo_url: user.profile_photo_url || null,
          });
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

// True when an account with this email already exists. Used by the Google
// OAuth callback to decide whether the user can "sign in" or needs to
// "sign up" before continuing.
exports.userExistsByEmail = async (email) => {
    const profile = await exports.getProfileByEmail(email);
    return Boolean(profile);
};

// Create-only Google user. Returns the freshly created profile, or the
// existing one if the email is already known. Stores the Google avatar
// when we have one and the user hasn't set their own photo yet.
exports.createGoogleUser = async ({ email, name, photoUrl }) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    const existing = await exports.getProfileByEmail(normalizedEmail);
    if (existing) {
        // If we got a Google photo and the profile has none, persist it.
        if (photoUrl && !existing.profile_photo_url) {
            const db = await db_helper.get_db_connection();
            await db.query(
                `UPDATE users SET profile_photo_url = ?, updated_at = NOW() WHERE LOWER(email) = LOWER(?)`,
                [photoUrl, normalizedEmail]
            );
            return exports.getProfileByEmail(normalizedEmail);
        }
        return existing;
    }

    const db = await db_helper.get_db_connection();
    await db.query(
        `INSERT INTO users (email, name, profile_photo_url, active)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (email) DO NOTHING`,
        [normalizedEmail, name || defaultNameFromEmail(normalizedEmail), photoUrl || null]
    );
    return exports.getProfileByEmail(normalizedEmail);
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
    if (String(newPassword ?? '').length < 6) {
        return { success: false, message: 'New password must be at least 6 characters' };
    }
    const db_poll = await db_helper.get_db_connection();
    const rows = await db_poll.query(
        `SELECT id, password FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
        [normalizedEmail]
    );
    const user = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
    if (!user) {
        return { success: false, message: 'Current password is incorrect' };
    }
    const check = passwordHelper.verify(currentPassword, user.password);
    if (!check.ok) {
        return { success: false, message: 'Current password is incorrect' };
    }

    await db_poll.query(
        `UPDATE users SET password = ?, updated_at = NOW() WHERE LOWER(email) = LOWER(?)`,
        [passwordHelper.hash(newPassword), normalizedEmail]
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

