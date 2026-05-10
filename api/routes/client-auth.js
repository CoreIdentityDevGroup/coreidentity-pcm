'use strict';
const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../services/db');
const router  = express.Router();

// POST /api/v1/client-auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });

  try {
    const result = await db.clients.query(
      `SELECT ca.auth_id, ca.client_id, ca.email, ca.password_hash,
              c.full_name, c.pipeline_stage, c.ofac_status
       FROM pcm_client_auth ca
       JOIN pcm_clients c ON c.client_id = ca.client_id
       WHERE ca.email = $1 AND ca.active = true`,
      [email]
    );

    if (!result.rows.length)
      return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];

    const verify = await db.clients.query(
      `SELECT (password_hash = crypt($1, password_hash)) AS valid
       FROM pcm_client_auth WHERE auth_id = $2`,
      [password, user.auth_id]
    );

    if (!verify.rows[0]?.valid)
      return res.status(401).json({ error: 'Invalid credentials' });

    await db.clients.query(
      `UPDATE pcm_client_auth SET last_login = NOW() WHERE auth_id = $1`,
      [user.auth_id]
    );

    const token = jwt.sign(
      { sub: email, role: 'client', name: user.full_name,
        client_id: user.client_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, role: 'client', name: user.full_name,
               client_id: user.client_id });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Client auth error', error: err.message }));
    res.status(500).json({ error: 'Authentication error' });
  }
});

// POST /api/v1/client-auth/register
// Staff-only: create client login credentials
router.post('/register', async (req, res) => {
  const { client_id, email, password } = req.body;
  if (!client_id || !email || !password)
    return res.status(400).json({ error: 'client_id, email, password required' });
  if (password.length < 10)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });

  try {
    const result = await db.clients.query(
      `INSERT INTO pcm_client_auth (client_id, email, password_hash)
       VALUES ($1, $2, crypt($3, gen_salt('bf', 12)))
       ON CONFLICT (email) DO UPDATE
         SET password_hash = crypt($3, gen_salt('bf', 12)),
             updated_at = NOW()
       RETURNING auth_id, email`,
      [client_id, email, password]
    );
    res.json({ success: true, auth_id: result.rows[0].auth_id, email });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed', detail: err.message });
  }
});

// POST /api/v1/client-auth/change-password
router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const user_email = req.user?.sub;

  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < 10)
    return res.status(400).json({ error: 'Minimum 10 characters' });

  try {
    const r = await db.clients.query(
      `SELECT auth_id FROM pcm_client_auth WHERE email = $1 AND active = true`,
      [user_email]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
    const auth_id = r.rows[0].auth_id;

    const v = await db.clients.query(
      `SELECT (password_hash = crypt($1, password_hash)) AS valid
       FROM pcm_client_auth WHERE auth_id = $2`,
      [current_password, auth_id]
    );
    if (!v.rows[0]?.valid)
      return res.status(401).json({ error: 'Current password incorrect' });

    await db.clients.query(
      `UPDATE pcm_client_auth
       SET password_hash = crypt($1, gen_salt('bf', 12)), updated_at = NOW()
       WHERE auth_id = $2`,
      [new_password, auth_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
