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
  const SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };

  for (const agreement of expiring.rows) {
    const days_until = Math.floor(
      (new Date(agreement.expiry_date) - now) / (1000 * 60 * 60 * 24)
    );

    const severity = days_until <= 0   ? 'critical'
                   : days_until <= 30  ? 'warning'
                   : 'info';

    // 2026-08-15: this used to log unconditionally on every run -- with no
    // upper bound on run frequency (the route was about to be scheduled
    // every 15 minutes) that meant one row per still-expiring agreement
    // PER RUN, forever, until it actually expired. An alert should mark a
    // change (first crossing into the window, or an escalation to a more
    // severe bucket), not repeat a condition that hasn't changed. The
    // table's own resolved/resolved_at/resolved_by columns confirm the
    // intended lifecycle is log-once-then-staff-resolves, not
    // log-every-tick. Suppress unless: no prior alert exists for this
    // agreement, the prior one is resolved (a fresh occurrence is
    // meaningful even at the same severity), or severity has escalated
    // since the prior unresolved one.
    const { rows: priorRows } = await db.forms.query(
      `SELECT severity, resolved
         FROM pcm_contract_monitoring_log
        WHERE agreement_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [agreement.agreement_id]
    );
    const prior = priorRows[0];
    const isNewOccurrence = !prior || prior.resolved
      || SEVERITY_RANK[severity] > SEVERITY_RANK[prior.severity];
    if (!isNewOccurrence) continue;

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
