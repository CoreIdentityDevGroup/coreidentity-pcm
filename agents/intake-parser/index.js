'use strict';

async function execute(context) {
  const { client_data, db } = context;
  
  const required_fields = ['full_name', 'email', 'country_of_origin'];
  const missing = required_fields.filter(f => !client_data[f]);
  
  if (missing.length > 0) {
    return {
      status: 'incomplete',
      missing_fields: missing,
      action: 'REQUEST_ADDITIONAL_INFO',
      message: `Missing required fields: ${missing.join(', ')}`
    };
  }

  // Extract and normalize fields
  const parsed = {
    full_name:         client_data.full_name?.trim(),
    email:             client_data.email?.toLowerCase().trim(),
    phone:             client_data.phone?.replace(/[^0-9+]/g, '') || null,
    country_of_origin: client_data.country_of_origin?.trim(),
    referral_source:   client_data.referral_source || 'Unknown',
    referral_contact:  client_data.referral_contact || null,
    deal_assignment:   client_data.deal_assignment || 'Platform'
  };

  // Check for duplicate email
  const existing = await db.clients.query(
    'SELECT client_id FROM pcm_clients WHERE email = $1',
    [parsed.email]
  );

  if (existing.rows.length > 0) {
    return {
      status: 'duplicate',
      client_id: existing.rows[0].client_id,
      action: 'MERGE_OR_REJECT',
      message: `Client with email ${parsed.email} already exists`
    };
  }

  return {
    status: 'ready',
    parsed_data: parsed,
    action: 'PROCEED_TO_KYC',
    message: 'Intake complete — all required fields present'
  };
}

module.exports = { execute };
