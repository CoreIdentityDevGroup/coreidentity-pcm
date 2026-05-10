'use strict';

async function execute(context) {
  const { asset_type, declared_value, country_of_origin, currency } = context;

  const BANK_ROUTING = {
    precious_metals: [
      { bank: 'DBS Singapore',    swift: 'DBSSSGSG', jurisdiction: 'singapore',   min_value: 0 },
      { bank: 'UBS Switzerland',  swift: 'UBSWCHZH', jurisdiction: 'switzerland', min_value: 10_000_000 },
      { bank: 'HSBC London',      swift: 'MIDLGB22', jurisdiction: 'uk',          min_value: 5_000_000 }
    ],
    real_estate: [
      { bank: 'Chase US',         swift: 'CHASUS33', jurisdiction: 'us',          min_value: 0 },
      { bank: 'Citi US',          swift: 'CITIUS33', jurisdiction: 'us',          min_value: 0 },
      { bank: 'Barclays London',  swift: 'BARCGB22', jurisdiction: 'uk',          min_value: 5_000_000 }
    ],
    sblc: [
      { bank: 'UBS Switzerland',  swift: 'UBSWCHZH', jurisdiction: 'switzerland', min_value: 0 },
      { bank: 'HSBC London',      swift: 'MIDLGB22', jurisdiction: 'uk',          min_value: 0 }
    ],
    skr: [
      { bank: 'DBS Singapore',    swift: 'DBSSSGSG', jurisdiction: 'singapore',   min_value: 0 },
      { bank: 'UBS Switzerland',  swift: 'UBSWCHZH', jurisdiction: 'switzerland', min_value: 0 }
    ]
  };

  const value = parseFloat(declared_value || 0);
  const routes = BANK_ROUTING[asset_type] || BANK_ROUTING.precious_metals;

  // Filter by minimum value and sort by preference
  const eligible = routes.filter(b => value >= b.min_value);

  if (!eligible.length) {
    return {
      status:  'no_route',
      action:  'MANUAL_ASSIGNMENT',
      message: `No eligible bank route for ${asset_type} at ${currency} ${Number(value).toLocaleString()}`
    };
  }

  const recommended = eligible[0];

  return {
    status:      'routed',
    recommended_bank:         recommended.bank,
    recommended_swift:        recommended.swift,
    recommended_jurisdiction: recommended.jurisdiction,
    eligible_banks:           eligible,
    action:      'ASSIGN_BANK',
    message:     `Recommended: ${recommended.bank} (${recommended.jurisdiction})`
  };
}

module.exports = { execute };
