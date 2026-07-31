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

  // CLOSE-GAP-01: value-based auto-classification removed.
  // Declared value alone must never route a submission to PROCEED.
  // Unmatched submissions always require manual classification.
  const value = parseFloat(declared_value || 0);

  return {
    status:         'classified',
    asset_type:     best_match || 'unclassified',
    confidence:     best_score > 2 ? 'high' : best_score > 0 ? 'medium' : 'low',
    declared_value: value,
    currency:       currency || 'USD',
    action:         best_match ? 'PROCEED' : 'REQUEST_MANUAL_CLASSIFICATION', // CLOSE-GAP-01: no value-based override
    message:        `Classified as ${best_match || 'unclassified'} (confidence: ${best_score > 2 ? 'high' : best_score > 0 ? 'medium' : 'low'})`
  };
}

module.exports = { execute };
