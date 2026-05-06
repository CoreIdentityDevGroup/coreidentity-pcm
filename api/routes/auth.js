'use strict';
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = express.Router();

const STAFF = [
  { email: process.env.ADMIN_EMAIL_1||'owner@coreg.com',  password: process.env.ADMIN_PASS_1||'changeme', role: 'trade_group_owner', name: 'Trade Group Owner' },
  { email: process.env.ADMIN_EMAIL_2||'pm@coreg.com',     password: process.env.ADMIN_PASS_2||'changeme', role: 'program_manager',   name: 'Program Manager' },
  { email: process.env.ADMIN_EMAIL_3||'intake@coreg.com', password: process.env.ADMIN_PASS_3||'changeme', role: 'intake_officer',    name: 'Intake Officer' }
];

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = STAFF.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET not configured' });
  const token = jwt.sign({ sub: email, role: user.role, name: user.name }, secret, { expiresIn: '8h' });
  res.json({ token, role: user.role, name: user.name });
});

router.get('/verify', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ valid: false });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch { res.status(401).json({ valid: false }); }
});

module.exports = router;
