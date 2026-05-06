'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

// ─── LIST FUNDS ───────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { fund_type, status, jurisdiction, limit = 50, offset = 0 } = req.query;
    let query = `SELECT * FROM pcm_funds WHERE 1=1`;
    const params = [];

    if (fund_type)    { params.push(fund_type);    query += ` AND fund_type = $${params.length}`; }
    if (status)       { params.push(status);       query += ` AND status = $${params.length}`; }
    if (jurisdiction) { params.push(jurisdiction); query += ` AND jurisdiction = $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    query += ` ORDER BY fund_name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.pehf.query(query, params);
    res.json({ funds: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// ─── GET FUND ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const fund = await db.pehf.query(
      `SELECT * FROM pcm_funds WHERE fund_id = $1`, [req.params.id]
    );
    if (!fund.rows.length) return res.status(404).json({ error: 'Fund not found' });

    const contacts = await db.pehf.query(
      `SELECT * FROM pcm_fund_contacts WHERE fund_id = $1 ORDER BY is_primary DESC`, [req.params.id]
    );
    const banks = await db.pehf.query(
      `SELECT * FROM pcm_trader_bank_relationships WHERE fund_id = $1`, [req.params.id]
    );

    res.json({ ...fund.rows[0], contacts: contacts.rows, bank_relationships: banks.rows });
  } catch (err) { next(err); }
});

// ─── CREATE FUND ──────────────────────────────────────────────────────────────
router.post('/', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const {
      fund_name, fund_type, strategy, aum_usd, aum_as_of_date,
      geography, jurisdiction, regulatory_status, deployment_appetite,
      min_deal_size_usd, max_deal_size_usd, preferred_asset_types,
      referral_source, notes
    } = req.body;

    if (!fund_name || !fund_type) {
      return res.status(400).json({ error: 'fund_name and fund_type are required' });
    }

    const result = await db.pehf.query(
      `INSERT INTO pcm_funds
        (fund_name, fund_type, strategy, aum_usd, aum_as_of_date,
         geography, jurisdiction, regulatory_status, deployment_appetite,
         min_deal_size_usd, max_deal_size_usd, preferred_asset_types,
         referral_source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [fund_name, fund_type, strategy, aum_usd, aum_as_of_date,
       geography, jurisdiction, regulatory_status, deployment_appetite,
       min_deal_size_usd, max_deal_size_usd, preferred_asset_types,
       referral_source, notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE FUND ──────────────────────────────────────────────────────────────
router.patch('/:id', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const allowed = ['fund_name','strategy','aum_usd','aum_as_of_date','geography',
                     'jurisdiction','regulatory_status','deployment_appetite',
                     'min_deal_size_usd','max_deal_size_usd','preferred_asset_types',
                     'status','referral_source','notes'];
    const updates = [];
    const params  = [];

    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        params.push(val);
        updates.push(`${key} = $${params.length}`);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.id);
    const result = await db.pehf.query(
      `UPDATE pcm_funds SET ${updates.join(', ')}
       WHERE fund_id = $${params.length} RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Fund not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ADD CONTACT ──────────────────────────────────────────────────────────────
router.post('/:id/contacts', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { full_name, title, email, phone, is_primary, linkedin_url, notes } = req.body;
    if (!full_name) return res.status(400).json({ error: 'full_name is required' });

    if (is_primary) {
      await db.pehf.query(
        `UPDATE pcm_fund_contacts SET is_primary = false WHERE fund_id = $1`, [req.params.id]
      );
    }

    const result = await db.pehf.query(
      `INSERT INTO pcm_fund_contacts
        (fund_id, full_name, title, email, phone, is_primary, linkedin_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.params.id, full_name, title, email, phone,
       is_primary || false, linkedin_url, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE CONTACT ───────────────────────────────────────────────────────────
router.patch('/:id/contacts/:contact_id', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const allowed = ['full_name','title','email','phone','is_primary','linkedin_url','notes'];
    const updates = [];
    const params  = [];

    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) { params.push(val); updates.push(`${key} = $${params.length}`); }
    }

    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.contact_id);
    params.push(req.params.id);
    const result = await db.pehf.query(
      `UPDATE pcm_fund_contacts SET ${updates.join(', ')}
       WHERE contact_id = $${params.length - 1} AND fund_id = $${params.length}
       RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contact not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ADD TRADER BANK RELATIONSHIP ─────────────────────────────────────────────
router.post('/:id/banks', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const {
      bank_name, bank_jurisdiction, swift_code, branch,
      relationship_type, account_type, relationship_manager,
      established_date, notes
    } = req.body;

    if (!bank_name || !bank_jurisdiction || !relationship_type) {
      return res.status(400).json({ error: 'bank_name, bank_jurisdiction, relationship_type required' });
    }

    const result = await db.pehf.query(
      `INSERT INTO pcm_trader_bank_relationships
        (fund_id, bank_name, bank_jurisdiction, swift_code, branch,
         relationship_type, account_type, relationship_manager,
         established_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [req.params.id, bank_name, bank_jurisdiction, swift_code, branch,
       relationship_type, account_type, relationship_manager,
       established_date, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── LIST TRADER BANKS FOR FUND ───────────────────────────────────────────────
router.get('/:id/banks', async (req, res, next) => {
  try {
    const result = await db.pehf.query(
      `SELECT * FROM pcm_trader_bank_relationships
       WHERE fund_id = $1 ORDER BY relationship_type`,
      [req.params.id]
    );
    res.json({ bank_relationships: result.rows });
  } catch (err) { next(err); }
});

// ─── ADD DEAL LINK ────────────────────────────────────────────────────────────
router.post('/:id/deals', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const {
      asset_id, client_id, pipeline_reference, link_type,
      capital_committed_usd, notes
    } = req.body;

    if (!asset_id || !client_id || !link_type) {
      return res.status(400).json({ error: 'asset_id, client_id, link_type required' });
    }

    const result = await db.pehf.query(
      `INSERT INTO pcm_deal_links
        (fund_id, asset_id, client_id, pipeline_reference,
         link_type, capital_committed_usd, linked_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [req.params.id, asset_id, client_id, pipeline_reference,
       link_type, capital_committed_usd,
       req.user.sub || 'system', notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── LIST DEAL LINKS FOR FUND ─────────────────────────────────────────────────
router.get('/:id/deals', async (req, res, next) => {
  try {
    const { link_status } = req.query;
    let query = `SELECT * FROM pcm_deal_links WHERE fund_id = $1`;
    const params = [req.params.id];

    if (link_status) { params.push(link_status); query += ` AND link_status = $${params.length}`; }
    query += ` ORDER BY linked_at DESC`;

    const result = await db.pehf.query(query, params);
    res.json({ deal_links: result.rows });
  } catch (err) { next(err); }
});

// ─── UPDATE DEAL LINK STATUS ──────────────────────────────────────────────────
router.patch('/:id/deals/:link_id', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { link_status, capital_committed_usd, notes } = req.body;
    const updates = [];
    const params  = [];

    if (link_status)           { params.push(link_status);           updates.push(`link_status = $${params.length}`); }
    if (capital_committed_usd) { params.push(capital_committed_usd); updates.push(`capital_committed_usd = $${params.length}`); }
    if (notes)                 { params.push(notes);                 updates.push(`notes = $${params.length}`); }

    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.link_id);
    params.push(req.params.id);
    const result = await db.pehf.query(
      `UPDATE pcm_deal_links SET ${updates.join(', ')}
       WHERE link_id = $${params.length - 1} AND fund_id = $${params.length}
       RETURNING *`, params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Deal link not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── SEARCH FUNDS BY ASSET TYPE + JURISDICTION ───────────────────────────────
router.get('/search/match', async (req, res, next) => {
  try {
    const { asset_type, jurisdiction, min_deal_size } = req.query;
    let query = `SELECT * FROM pcm_funds WHERE status = 'active'`;
    const params = [];

    if (asset_type) {
      params.push(`%${asset_type}%`);
      query += ` AND (preferred_asset_types::text ILIKE $${params.length} OR preferred_asset_types IS NULL)`;
    }
    if (jurisdiction) {
      params.push(jurisdiction);
      query += ` AND (jurisdiction = $${params.length} OR jurisdiction IS NULL)`;
    }
    if (min_deal_size) {
      params.push(parseFloat(min_deal_size));
      query += ` AND (max_deal_size_usd >= $${params.length} OR max_deal_size_usd IS NULL)`;
    }

    query += ` ORDER BY aum_usd DESC NULLS LAST LIMIT 20`;
    const result = await db.pehf.query(query, params);
    res.json({ matches: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
