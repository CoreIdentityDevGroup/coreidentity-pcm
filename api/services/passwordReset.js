'use strict';

const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min -- design report's recommended lower bound of the 30-60 min range

function newRawToken() {
  return crypto.randomBytes(32).toString('base64url'); // 256 bits
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Appends one immutable row to pcm_agent_activity for a real reset event.
// pcm_agent_activity is INSERT/SELECT only for pcm_app (see
// db/migrations/0002-audit-log-lock-down.sql) -- this is the application
// auditing a real action, the same table AI-agent decisions already write
// to, not a second audit table invented for this feature. The reset_token
// row (pcm_password_reset_tokens) is operational state and can be pruned
// later; this row is the permanent record of the event.
async function logAuditEvent({ action, status, targetStaffId, targetEmail, initiatedBy, mechanism, resetTokenId }) {
  await db.clients.query(
    `INSERT INTO pcm_agent_activity
       (agent_name, agent_id, action, status, result_summary, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      'password-reset',
      targetStaffId || null,
      action,
      status,
      JSON.stringify({ target_email: targetEmail || null, mechanism, reset_token_id: resetTokenId || null }),
      initiatedBy || 'self'
    ]
  );
}

// Looks up an active staff account by email. Returns null on no match --
// caller is responsible for taking the identical-response path regardless
// (see routes/auth.js forgot-password handler).
async function findActiveStaffByEmail(email) {
  const result = await db.clients.query(
    `SELECT staff_id, email, name FROM pcm_staff WHERE email = $1 AND active = true`,
    [email]
  );
  return result.rows[0] || null;
}

async function findStaffById(staffId) {
  const result = await db.clients.query(
    `SELECT staff_id, email, name, active FROM pcm_staff WHERE staff_id = $1`,
    [staffId]
  );
  return result.rows[0] || null;
}

// Invalidates every currently-unused token for a staff_id by marking it
// used (not deleting -- the row stays as queryable "this token existed and
// was superseded" state). Called both when a new token is requested (so
// only the newest link is live) and when a token is successfully consumed
// (so a burst of requested-but-unused tokens can't be used after a
// password change) -- satisfies "invalidated on use and on any subsequent
// password change" as one code path, not two.
async function invalidateOutstandingTokens(staffId) {
  await db.clients.query(
    `UPDATE pcm_password_reset_tokens SET used_at = now()
     WHERE staff_id = $1 AND used_at IS NULL`,
    [staffId]
  );
}

// Real path: creates + persists a token and sends the email.
async function issueResetToken(staff, { initiatedBy = null } = {}) {
  await invalidateOutstandingTokens(staff.staff_id);
  const raw = newRawToken();
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const result = await db.clients.query(
    `INSERT INTO pcm_password_reset_tokens (staff_id, token_hash, expires_at, initiated_by)
     VALUES ($1,$2,$3,$4) RETURNING token_id`,
    [staff.staff_id, hash, expiresAt, initiatedBy]
  );
  const tokenId = result.rows[0].token_id;

  const base = process.env.PORTAL_URL || 'https://app.coregenisis.com';
  const resetUrl = `${base}/reset-password?token=${raw}`;
  await mailer.sendPasswordResetEmail(staff.email, resetUrl);

  await logAuditEvent({
    action: 'password_reset_requested',
    status: 'sent',
    targetStaffId: staff.staff_id,
    targetEmail: staff.email,
    initiatedBy: initiatedBy || 'self',
    mechanism: initiatedBy ? 'admin_triggered' : 'self_service',
    resetTokenId: tokenId
  });

  return tokenId;
}

// Dummy path: equivalent-cost work for a not-found/inactive email, so the
// forgot-password endpoint's response time doesn't become a second
// enumeration oracle even though its response body already isn't one (see
// routes/auth.js -- both branches return the identical body). Does the same
// randomBytes + sha256 + a throwaway async tick as the real path, but never
// touches the DB or sends mail.
async function dummyResetWork() {
  const raw = newRawToken();
  hashToken(raw);
  await new Promise((resolve) => setImmediate(resolve));
}

// Completion step: hash the incoming token, look up an unexpired, unused
// row. Returns null for not-found / expired / already-used alike -- one
// generic outcome, no distinction leaked to the caller (routes/auth.js
// turns null into the same 400 body regardless of which of the three it
// was).
async function consumeToken(rawToken) {
  const hash = hashToken(rawToken);
  const result = await db.clients.query(
    `SELECT prt.token_id, prt.staff_id, s.email, s.active
       FROM pcm_password_reset_tokens prt
       JOIN pcm_staff s ON s.staff_id = prt.staff_id
      WHERE prt.token_hash = $1 AND prt.used_at IS NULL AND prt.expires_at > now()`,
    [hash]
  );
  const row = result.rows[0];
  if (!row || !row.active) return null; // deactivated-account tokens are rejected here, same generic outcome
  return row;
}

module.exports = {
  TOKEN_TTL_MS,
  newRawToken,
  hashToken,
  findActiveStaffByEmail,
  findStaffById,
  invalidateOutstandingTokens,
  issueResetToken,
  dummyResetWork,
  consumeToken,
  logAuditEvent
};
