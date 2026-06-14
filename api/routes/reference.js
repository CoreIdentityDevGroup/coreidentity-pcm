'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

// ─── REFERENCE TYPE REGISTRY ──────────────────────────────────────────────────
// Maps the public :type slug to its table + primary key. Table/column names are
// constants drawn from this registry only — never interpolated from user input.
const REF_TYPES = {
  'banks':          { table: 'pcm_banks',                  pk: 'bank_id',       hasReqDesc: false },
  'asset-types':    { table: 'pcm_asset_types',            pk: 'asset_type_id', hasReqDesc: true  },
  'asset-backings': { table: 'pcm_asset_backings',         pk: 'backing_id',    hasReqDesc: false },
  'instruments':    { table: 'pcm_securities_instruments', pk: 'instrument_id', hasReqDesc: true  }
};

function resolveType(req, res) {
  const meta = REF_TYPES[req.params.type];
  if (!meta) {
    res.status(400).json({ error: `Unknown reference type '${req.params.type}'`, allowed: Object.keys(REF_TYPES) });
    return null;
  }
  return meta;
}

// ─── LIST BANKS ───────────────────────────────────────────────────────────────
router.get('/banks', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_banks WHERE active = true ORDER BY sort_order ASC, name ASC`
    );
    res.json({ banks: result.rows });
  } catch (err) { next(err); }
});

// ─── LIST ASSET TYPES ─────────────────────────────────────────────────────────
router.get('/asset-types', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_asset_types WHERE active = true ORDER BY sort_order ASC, name ASC`
    );
    res.json({ asset_types: result.rows });
  } catch (err) { next(err); }
});

// ─── LIST ASSET BACKINGS ──────────────────────────────────────────────────────
router.get('/asset-backings', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_asset_backings WHERE active = true ORDER BY sort_order ASC, name ASC`
    );
    res.json({ asset_backings: result.rows });
  } catch (err) { next(err); }
});

// ─── LIST SECURITIES INSTRUMENTS ──────────────────────────────────────────────
router.get('/instruments', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_securities_instruments WHERE active = true ORDER BY sort_order ASC, name ASC`
    );
    res.json({ instruments: result.rows });
  } catch (err) { next(err); }
});

// ─── LIST PIPELINE STAGE DEFINITIONS ──────────────────────────────────────────
router.get('/pipeline-stages', async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_pipeline_stage_definitions ORDER BY stage_number ASC`
    );
    res.json({ pipeline_stages: result.rows });
  } catch (err) { next(err); }
});

// ─── CREATE REFERENCE ITEM (admin) ────────────────────────────────────────────
router.post('/:type', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const meta = resolveType(req, res);
    if (!meta) return;

    const { name, active, sort_order, requires_description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const columns = ['name', 'active', 'sort_order'];
    const values  = [name, active ?? true, sort_order ?? 0];
    if (meta.hasReqDesc) {
      columns.push('requires_description');
      values.push(requires_description ?? false);
    }

    const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
    const result = await db.clients.query(
      `INSERT INTO ${meta.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── UPDATE REFERENCE ITEM (admin) ────────────────────────────────────────────
router.put('/:type/:id', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const meta = resolveType(req, res);
    if (!meta) return;

    const allowed = ['name', 'active', 'sort_order'];
    if (meta.hasReqDesc) allowed.push('requires_description');

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
    const result = await db.clients.query(
      `UPDATE ${meta.table} SET ${updates.join(', ')} WHERE ${meta.pk} = $${params.length} RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Reference item not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── SOFT DELETE REFERENCE ITEM (admin) ───────────────────────────────────────
router.delete('/:type/:id', authorize('trade_group_owner'), async (req, res, next) => {
  try {
    const meta = resolveType(req, res);
    if (!meta) return;

    const result = await db.clients.query(
      `UPDATE ${meta.table} SET active = false WHERE ${meta.pk} = $1 RETURNING ${meta.pk}`,
      [req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Reference item not found' });
    res.json({ message: 'Reference item deactivated', id: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
