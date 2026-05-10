'use strict';
const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../services/db');
const router  = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const result = await db.clients.query(
      `SELECT staff_id, email, name, role, password_hash
       FROM pcm_staff
       WHERE email = $1 AND active = true`,
      [email]
    );

    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];

    const verify = await db.clients.query(
      `SELECT (password_hash = crypt($1, password_hash)) AS valid FROM pcm_staff WHERE staff_id = $2`,
      [password, user.staff_id]
    );

    if (!verify.rows[0]?.valid) return res.status(401).json({ error: 'Invalid credentials' });

    await db.clients.query(
      `UPDATE pcm_staff SET last_login = NOW() WHERE staff_id = $1`, [user.staff_id]
    );

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET not configured' });

    const token = jwt.sign(
      { sub: user.email, role: user.role, name: user.name, staff_id: user.staff_id },
      secret,
      { expiresIn: '8h' }
    );

    res.json({ token, role: user.role, name: user.name });
  } catch (err) {
    console.error(JSON.stringify({level:'error',message:'Auth error',error:err.message,stack:err.stack}));
    res.status(500).json({ error: 'Authentication error', detail: err.message });
  }
});

router.get('/verify', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ valid: false });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch { res.status(401).json({ valid: false }); }
});


router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const user_email = req.user?.sub;

  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password required' });

  if (new_password.length < 10)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });

  try {
    const result = await db.clients.query(
      `SELECT staff_id, password_hash FROM pcm_staff WHERE email = $1 AND active = true`,
      [user_email]
    );

    if (!result.rows.length)
      return res.status(401).json({ error: 'User not found' });

    const user = result.rows[0];

    const verify = await db.clients.query(
      `SELECT (password_hash = crypt($1, password_hash)) AS valid FROM pcm_staff WHERE staff_id = $2`,
      [current_password, user.staff_id]
    );

    if (!verify.rows[0]?.valid)
      return res.status(401).json({ error: 'Current password is incorrect' });

    await db.clients.query(
      `UPDATE pcm_staff 
       SET password_hash = crypt($1, gen_salt('bf', 12)), updated_at = NOW()
       WHERE staff_id = $2`,
      [new_password, user.staff_id]
    );

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Change password error', error: err.message }));
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
