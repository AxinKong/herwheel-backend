const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { sendWelcomeEmail } = require('../email');

/**
 * POST /api/auth/register
 * Body: { email, password, role?, lang? }
 * role defaults to 'learner'. Coaches still register as 'learner' and
 * become a coach by submitting a coach_profiles application (POST /api/coaches);
 * 'admin' role should be set manually in the database, never via this endpoint.
 */
router.post('/register', async (req, res) => {
  const { email, password, lang } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, lang)
       VALUES ($1, $2, 'learner', $3) RETURNING id, email, role, lang`,
      [email, passwordHash, lang || 'en']
    );
    const user = rows[0];
    const token = signToken(user);

    // Fire-and-forget — don't block the response on email delivery.
    sendWelcomeEmail(user.email, user.lang);

    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  const user = rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, lang: user.lang } });
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = router;
