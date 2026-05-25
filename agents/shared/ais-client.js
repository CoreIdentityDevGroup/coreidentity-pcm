/**
 * CoreIdentity PCM — AIS Client
 * Verifies agent identity via Agent Identity Systems (AIS).
 * Phase 2: wired to AIS_API_URL (default https://api.agentidentity.systems).
 */
const AIS_BASE = (typeof process !== 'undefined' && process.env.AIS_API_URL)
  ? process.env.AIS_API_URL.replace(/\/$/, '')
  : 'https://api.agentidentity.systems';

export async function aisVerify(agentId, context) {
  if (!agentId || !context?.trace_id) {
    throw new Error('AIS verification failed — missing agent_id or trace_id');
  }

  // Identity assertion (always logged for audit)
  console.log(JSON.stringify({
    type:      'AIS_ASSERTION',
    agent_id:  agentId,
    trace_id:  context.trace_id,
    ais_url:   AIS_BASE,
    timestamp: new Date().toISOString()
  }));

  // Phase 2 — verify against the AIS API
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(AIS_BASE + '/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        agent_id: agentId,
        trace_id: context.trace_id,
        context
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`AIS verify returned HTTP ${res.status}`);
    }
    const data = await res.json();
    return {
      verified: data.verified !== false,
      mode:     'live',
      ais_url:  AIS_BASE,
      ...data
    };
  } catch (err) {
    console.error(JSON.stringify({
      type:     'AIS_VERIFY_ERROR',
      agent_id: agentId,
      trace_id: context.trace_id,
      error:    String(err && err.message ? err.message : err)
    }));
    // Fail-close: governance requires a positive identity assertion.
    throw new Error(`AIS verification failed — ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}
