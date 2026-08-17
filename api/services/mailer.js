'use strict';

const nodemailer = require('nodemailer');

// Zoho SMTP, same pattern as coreidentity-ops/ops-api/server.js's `init()` --
// deliberately not shared credentials (dedicated coreidentity/pcm/ZOHO_SMTP_*
// secrets, see coreidentity-infrastructure/pcm-password-reset.tf), but the
// same transport shape. Lazy singleton: built on first send, not at module
// load, so a missing credential fails the one request that needed it
// instead of crashing the whole process at startup.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.ZOHO_SMTP_USER;
  const pass = process.env.ZOHO_SMTP_PASS;
  if (!user || !pass) throw new Error('ZOHO_SMTP_USER/ZOHO_SMTP_PASS not configured');
  transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user, pass }
  });
  return transporter;
}

const FROM_EMAIL = { name: 'CoreG Platform', address: 'tmorgan@coreidentitygroup.com' };

async function sendPasswordResetEmail(toEmail, resetUrl) {
  await getTransporter().sendMail({
    from: FROM_EMAIL,
    to: toEmail,
    subject: 'CoreG Platform — Password Reset',
    text: `A password reset was requested for your CoreG Platform account.\n\n` +
          `Reset your password: ${resetUrl}\n\n` +
          `This link expires in 30 minutes and can only be used once. ` +
          `If you did not request this, no action is needed -- your password has not been changed.`,
    html: `<p>A password reset was requested for your CoreG Platform account.</p>` +
          `<p><a href="${resetUrl}">Reset your password</a></p>` +
          `<p>This link expires in 30 minutes and can only be used once. ` +
          `If you did not request this, no action is needed &mdash; your password has not been changed.</p>`
  });
}

module.exports = { sendPasswordResetEmail, getTransporter };
