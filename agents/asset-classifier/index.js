'use strict';

async function execute(context) {
  const { description, asset_subtype, declared_value, currency } = context;

  const ASSET_KEYWORDS = {
    precious_metals: ['gold','silver','platinum','palladium','bullion','bar','coin','oz','troy','assay'],
    real_estate:     ['property','land','building','commercial','residential','office','warehouse','deed'],
    sblc:            ['sblc','standby','letter of credit','swift','mt760','mt799','bank guarantee'],
    skr:             ['skr','safekeeping','receipt','custodial','vault receipt','depository'],
    private_equity:  ['equity','shares','stake','ownership','fund','portfolio','cap table'],
    hedge_fund:      ['hedge','fund','aum','nav','lp','limited partner'],
    bond:            ['bond','treasury','sovereign','coupon','maturity','fixed income'],
    commodity:       ['oil','gas','copper','iron','commodity','futures','raw material']
  };

  const text = `${description || ''} ${asset_subtype || ''}`.toLowerCase();
  
  let best_match = null;
  let best_score = 0;

  for (const [asset_type, keywords] of Object.entries(ASSET_KEYWORDS)) {
    const score = keywords.filter(kw => text.includes(kw)).length;
    if (score > best_score) {
      best_score = score;
      best_match = asset_type;
    }
  }

  // Value-based classification hints
  const value = parseFloat(declared_value || 0);
  if (!best_match && value > 0) {
    if (value >= 50_000_000) best_match = 'sblc';
    else if (value >= 1_000_000) best_match = 'precious_metals';
    else best_match = 'real_estate';
  }

  return {
    status:         'classified',
    asset_type:     best_match || 'unclassified',
    confidence:     best_score > 2 ? 'high' : best_score > 0 ? 'medium' : 'low',
    declared_value: value,
    currency:       currency || 'USD',
    action:         best_match ? 'PROCEED' : 'REQUEST_MANUAL_CLASSIFICATION',
    message:        `Classified as ${best_match || 'unclassified'} (confidence: ${best_score > 2 ? 'high' : best_score > 0 ? 'medium' : 'low'})`
  };
}

module.exports = { execute };
