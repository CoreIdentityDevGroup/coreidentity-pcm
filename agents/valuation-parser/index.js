'use strict';

async function execute(context) {
  const { asset_id, appraised_value, declared_value, currency, 
          appraiser_name, appraisal_date, db } = context;

  const discrepancy_ratio = Math.abs(appraised_value - declared_value) / declared_value;
  const DISCREPANCY_THRESHOLD = 0.20; // 20% variance triggers review

  const flags = [];

  if (discrepancy_ratio > DISCREPANCY_THRESHOLD) {
    flags.push(
      `Appraised value (${currency} ${Number(appraised_value).toLocaleString()}) ` +
      `differs from declared value (${currency} ${Number(declared_value).toLocaleString()}) ` +
      `by ${(discrepancy_ratio * 100).toFixed(1)}%`
    );
  }

  if (!appraiser_name || appraiser_name.trim().length < 3) {
    flags.push('Appraiser name missing or invalid');
  }

  const status = flags.length > 0 ? 'review_required' : 'accepted';

  return {
    status,
    appraised_value: parseFloat(appraised_value),
    declared_value:  parseFloat(declared_value),
    discrepancy_pct: parseFloat((discrepancy_ratio * 100).toFixed(2)),
    appraiser_name,
    flags,
    action:   status === 'accepted' ? 'ADVANCE_PIPELINE' : 'FLAG_FOR_REVIEW',
    message:  status === 'accepted'
      ? `Valuation accepted — ${appraiser_name}`
      : `Valuation requires review: ${flags[0]}`
  };
}

module.exports = { execute };
