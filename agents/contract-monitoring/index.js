'use strict';

async function execute(context) {
  const { db } = context;

  const now     = new Date();
  const in_90   = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const in_30   = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Find expiring agreements
  const expiring = await db.forms.query(
    `SELECT a.agreement_id, a.agreement_type, a.expiry_date, 
            a.pipeline_reference, a.status
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

    // Log alert
    await db.forms.query(
      `INSERT INTO pcm_monitoring_log
         (agreement_id, alert_type, severity, message, pipeline_reference)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        agreement.agreement_id,
        'expiry_warning',
        severity,
        alerts[alerts.length - 1].message,
        agreement.pipeline_reference
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
