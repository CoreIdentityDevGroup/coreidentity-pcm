'use strict';

async function execute(context) {
  const { db } = context;

  const now     = new Date();
  const in_90   = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const in_30   = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Find expiring agreements
  const expiring = await db.forms.query(
    `SELECT a.agreement_id, a.agreement_type, a.expiry_date,
            a.pipeline_reference, a.status, a.asset_id, a.client_id
     FROM pcm_agreements a
     WHERE a.expiry_date IS NOT NULL
       AND a.expiry_date <= $1
       AND a.status NOT IN ('expired')
     ORDER BY a.expiry_date ASC`,
    [in_90]
  );

  const alerts = [];

  for (const agreement of expiring.rows) {
    const days_until = Math.floor(
      (new Date(agreement.expiry_date) - now) / (1000 * 60 * 60 * 24)
    );

    const severity = days_until <= 0   ? 'critical'
                   : days_until <= 30  ? 'warning'
                   : 'info';

    alerts.push({
      agreement_id:      agreement.agreement_id,
      agreement_type:    agreement.agreement_type,
      pipeline_reference: agreement.pipeline_reference,
      expiry_date:       agreement.expiry_date,
      days_until_expiry: days_until,
      severity,
      message: days_until <= 0
        ? `Agreement EXPIRED: ${agreement.agreement_type} (${agreement.pipeline_reference})`
        : `Agreement expiring in ${days_until} days: ${agreement.agreement_type}`
    });

    // Log alert. CLOSE-GAP-22: corrected table name (see script header),
    // correct required columns (asset_id/client_id are NOT NULL live),
    // and event_type mapped to the live CHECK constraint's allowed values
    // using the same days_until <= 0 condition already computed above
    // for severity.
    await db.forms.query(
      `INSERT INTO pcm_contract_monitoring_log
         (agreement_id, asset_id, client_id, pipeline_reference, event_type, severity, message, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        agreement.agreement_id,
        agreement.asset_id,
        agreement.client_id,
        agreement.pipeline_reference,
        days_until <= 0 ? 'expired' : 'approaching_expiry',
        severity,
        alerts[alerts.length - 1].message,
        'contract-monitoring-agent'
      ]
    );
  }

  return {
    status:      'complete',
    alerts_generated: alerts.length,
    critical:    alerts.filter(a => a.severity === 'critical').length,
    warning:     alerts.filter(a => a.severity === 'warning').length,
    info:        alerts.filter(a => a.severity === 'info').length,
    alerts,
    action:      alerts.length > 0 ? 'NOTIFY_STAFF' : 'NO_ACTION',
    message:     `Contract monitoring complete — ${alerts.length} alert(s) generated`
  };
}

module.exports = { execute };
