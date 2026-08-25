const db_helper = require('../helper/db_helper');
const passwordHelper = require('../helper/password_helper');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LEN = 6;

// Signup / add-user. Validates the payload, normalizes the email,
// rejects duplicates case-insensitively with a 409, and stores the
// password hashed (scrypt). Resolves { success, userId, email } or
// throws an Error with .status + a user-facing .message.
exports.add = async (req) => {
    const rawName = String(req.body?.name ?? '').trim();
    const rawEmail = String(req.body?.email ?? '').trim().toLowerCase();
    const rawPassword = String(req.body?.password ?? '');
    const dob = req.body?.dob || null;
    const status = req.body?.status;

    // ---- Validation (mirrors what the form should enforce; the API is
    // the source of truth because the form can be bypassed). ----
    if (!rawName || rawName.length < 2) {
        throw Object.assign(new Error('Please enter your full name.'), { status: 400 });
    }
    if (rawName.length > 120) {
        throw Object.assign(new Error('Name is too long (max 120 characters).'), { status: 400 });
    }
    if (!rawEmail || !EMAIL_RE.test(rawEmail) || rawEmail.length > 254) {
        throw Object.assign(new Error('Please enter a valid email address.'), { status: 400 });
    }
    if (!rawPassword || rawPassword.length < MIN_PASSWORD_LEN) {
        throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`), { status: 400 });
    }
    if (rawPassword.length > 200) {
        throw Object.assign(new Error('Password is too long (max 200 characters).'), { status: 400 });
    }

    const db_poll = await db_helper.get_db_connection();

    return new Promise((resolve, reject) => {
        // 1. Case-insensitive duplicate check. Emails are stored
        // lowercase from here on, but legacy rows may be mixed-case.
        const checkSql = `SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`;
        db_poll.query(checkSql, [rawEmail], (err, result) => {
            if (err) {
                console.error('signup: duplicate check failed:', err);
                return reject(Object.assign(new Error('Something went wrong, please try again.'), { status: 500 }));
            }

            if (result.length > 0) {
                return reject(Object.assign(
                    new Error('An account with this email already exists. Try signing in instead.'),
                    { status: 409 }
                ));
            }

            // 2. Insert with a hashed password.
            const activeStatus = Number.isInteger(Number(status)) ? Number(status) : 1;
            const hashedPassword = passwordHelper.hash(rawPassword);
            const insertSql = `INSERT INTO users (name, email, password, dob, active) VALUES (?, ?, ?, ?, ?) RETURNING id`;
            db_poll.query(insertSql, [rawName, rawEmail, hashedPassword, dob, activeStatus], (insertErr, insertResult) => {
                if (insertErr) {
                    // Unique-constraint race (two signups at once): treat as duplicate.
                    if (String(insertErr.code) === '23505') {
                        return reject(Object.assign(
                            new Error('An account with this email already exists. Try signing in instead.'),
                            { status: 409 }
                        ));
                    }
                    console.error('signup: insert failed:', insertErr);
                    return reject(Object.assign(new Error('Could not create your account, please try again.'), { status: 500 }));
                }

                resolve({
                    success: true,
                    message: 'User inserted successfully',
                    userId: insertResult.insertId,
                    email: rawEmail,
                });
            });
        });
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

