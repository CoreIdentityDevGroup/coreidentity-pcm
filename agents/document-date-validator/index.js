'use strict';

async function execute(context) {
  const { appraisal_date, submission_date, pof_date, asset_id, db } = context;

  const errors = [];
  const warnings = [];

  // Core rule: appraisal_date must equal submission_date
  if (appraisal_date && submission_date) {
    const ap = new Date(appraisal_date).toDateString();
    const su = new Date(submission_date).toDateString();
    if (ap !== su) {
      errors.push(`Appraisal date (${appraisal_date}) must match submission date (${submission_date})`);
    }
  }

  // POF date check — must be within 90 days
  if (pof_date) {
    const pof = new Date(pof_date);
    const now = new Date();
    const days_old = Math.floor((now - pof) / (1000 * 60 * 60 * 24));
    if (days_old > 90) {
      warnings.push(`POF document is ${days_old} days old — may require refresh`);
    }
  }

  // Check for future dates
  const today = new Date();
  for (const [label, date_str] of [['appraisal_date', appraisal_date], ['submission_date', submission_date]]) {
    if (date_str && new Date(date_str) > today) {
      errors.push(`${label} cannot be in the future`);
    }
  }

  return {
    status:   errors.length > 0 ? 'invalid' : 'valid',
    errors,
    warnings,
    action:   errors.length > 0 ? 'REJECT_DOCUMENT' : 'APPROVE_DOCUMENT',
    message:  errors.length > 0 
      ? `Date validation failed: ${errors[0]}`
      : 'All dates valid'
  };
}

module.exports = { execute };
