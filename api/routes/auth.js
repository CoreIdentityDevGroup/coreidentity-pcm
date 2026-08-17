'use strict';
const governance    = require('../services/governance');
const express       = require('express');
const jwt           = require('jsonwebtoken');
const rateLimit      = require('express-rate-limit');
const db             = require('../services/db');
const passwordReset  = require('../services/passwordReset');
const { authenticate } = require('../middleware/authenticate');
const { authorize }    = require('../middleware/authorize');
const router  = express.Router();

// Dedicated, stricter than the app-wide 200/15min limiter in app.js --
// forgot-password is an unauthenticated, email-sending endpoint, exactly
// the shape an email-bombing tool would target. Keyed by IP and by the
// submitted email, so one account can't be hammered from spread-out IPs
// either.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || '').toLowerCase()}`,
  message: { error: 'Too many requests — please try again later.' }
});

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

    // Log auth event to SAL
    governance.onAuthEvent({
      email, role: user.role,
      success: true,
      ip: req.ip || req.headers['x-forwarded-for']
    }).catch(() => {});

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

// ─── FORGOT PASSWORD (self-service, public) ────────────────────────────────
// Identical response and near-identical latency whether or not the email
// exists -- see passwordReset.dummyResetWork()'s comment. Never returns a
// 4xx/404 distinguishing "no such account": a request with a malformed body
// still needs email present to even route to a branch, but an empty/missing
// email is a client error, not an enumeration signal (no account could ever
// match it), so that alone is fine to reject distinctly.
const GENERIC_FORGOT_PASSWORD_RESPONSE = { message: 'If that email exists, a reset link has been sent.' };

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const staff = await passwordReset.findActiveStaffByEmail(email);
    if (staff) {
      await passwordReset.issueResetToken(staff, { initiatedBy: null });
    } else {
      await passwordReset.dummyResetWork();
    }
  } catch (err) {
    // Deliberately still return the generic response -- a mail-transport
    // failure or DB error must not turn into a distinguishable response
    // shape for the caller. Logged for us, invisible to them.
    console.error(JSON.stringify({ level: 'error', message: 'forgot-password error', error: err.message }));
  }

  res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
});

// ─── RESET PASSWORD (completion step, public — token is the credential) ───
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    return res.status(400).json({ error: 'token and new_password required' });
  }
  if (new_password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }

  try {
    const row = await passwordReset.consumeToken(token);
    if (!row) {
      // Same message for not-found, expired, already-used, and
      // deactivated-account tokens -- no distinction leaked.
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    await db.clients.query(
      `UPDATE pcm_staff SET password_hash = crypt($1, gen_salt('bf', 12)), updated_at = NOW()
       WHERE staff_id = $2`,
      [new_password, row.staff_id]
    );
    // A successful reset invalidates every other outstanding token for this
    // staff_id too -- "invalidated on use and on any subsequent password
    // change" as one step, since a completed reset is itself a password
    // change.
    await passwordReset.invalidateOutstandingTokens(row.staff_id);

    await passwordReset.logAuditEvent({
      action: 'password_reset_completed',
      status: 'success',
      targetStaffId: row.staff_id,
      targetEmail: row.email,
      initiatedBy: 'self',
      mechanism: 'token_consumption',
      resetTokenId: row.token_id
    });

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'reset-password error', error: err.message }));
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── ADMIN-TRIGGERED RESET (Administrator only) ────────────────────────────
// Always triggers the same reset-email flow as forgot-password -- never
// sets a password directly (Decision, this session: no path exists for an
// admin to ever know another user's credential; the audit record shows a
// reset was initiated, not a password handed over). Same token/TTL/
// single-use mechanism as self-service, distinguished only by
// initiated_by being the admin's identity instead of null.
router.post('/admin/reset-password', authenticate, authorize('trade_group_owner'), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const staff = await passwordReset.findActiveStaffByEmail(email);
  if (!staff) return res.status(404).json({ error: 'No active staff account with that email' });

  await passwordReset.issueResetToken(staff, { initiatedBy: req.user.sub || req.user.email });

  res.json({ success: true, message: `Reset link sent to ${staff.email}` });
});

module.exports = router;
