'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const { requireOwnClientOrStaff } = require('../middleware/ownership');
const router   = express.Router();

const TRANSACTION_TYPES = ['crypto', 'cash', 'asset'];
const TOTAL_STAGES = 8;

// Columns a client/staff member may set on create or update (excludes server-managed
// fields: transaction_id, client_id, rules_acknowledged*, timestamps).
const WRITABLE_FIELDS = [
  'transaction_type', 'crypto_wallet_address', 'crypto_wallet_link',
  'asset_type_id', 'asset_description', 'asset_backing_id',
  'instrument_id', 'instrument_description', 'bank_id',
  'asset_jurisdiction', 'asset_location', 'owner_name',
  'beneficiary_same_as_owner', 'beneficiary_name', 'been_in_trade_before',
  'status'
];

// ─── CREATE TRANSACTION (+ auto-populate 8 pipeline stages, atomic) ───────────
router.post('/', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  const { client_id, transaction_type } = req.body;
  if (!client_id || !transaction_type) {
    return res.status(400).json({ error: 'client_id and transaction_type are required' });
  }
  if (!TRANSACTION_TYPES.includes(transaction_type)) {
    return res.status(400).json({ error: `transaction_type must be one of: ${TRANSACTION_TYPES.join(', ')}` });
  }

  const columns = ['client_id'];
  const params  = [client_id];
  for (const field of WRITABLE_FIELDS) {
    if (req.body[field] !== undefined) {
      params.push(req.body[field]);
      columns.push(field);
    }
  }
  const placeholders = params.map((_, i) => `$${i + 1}`).join(',');

  const client = await db.clients.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `INSERT INTO pcm_transactions (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      params
    );
    const transaction = txResult.rows[0];

    // Auto-populate all 8 pipeline stages as 'pending'. If any insert fails the
    // whole transaction (incl. the parent row) rolls back.
    for (let stage = 1; stage <= TOTAL_STAGES; stage++) {
      await client.query(
        `INSERT INTO pcm_transaction_stages (transaction_id, stage_number, status)
         VALUES ($1, $2, 'pending')`,
        [transaction.transaction_id, stage]
      );
    }

    await client.query('COMMIT');

    const stages = await db.clients.query(
      `SELECT * FROM pcm_transaction_stages WHERE transaction_id = $1 ORDER BY stage_number ASC`,
      [transaction.transaction_id]
    );
    res.status(201).json({ ...transaction, stages: stages.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ─── LIST TRANSACTIONS (optionally by client) ─────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    // Client-role tokens are always scoped to their own client_id, regardless
    // of any client_id passed in the query string -- the query param must not
    // let a client credential list another client's transactions. Staff roles
    // keep the existing optional filter.
    const client_id = req.user?.role === 'client' ? req.user.client_id : req.query.client_id;
    let query = `SELECT * FROM pcm_transactions WHERE 1 = 1`;
    const params = [];

    if (client_id) { params.push(client_id); query += ` AND client_id = $${params.length}`; }
    if (status)    { params.push(status);    query += ` AND status = $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.clients.query(query, params);
    res.json({ transactions: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// ─── GET TRANSACTION DETAIL (+ its 8 stages) ──────────────────────────────────
router.get('/:id', requireOwnClientOrStaff(async req => {
  const r = await db.clients.query(
    `SELECT client_id FROM pcm_transactions WHERE transaction_id = $1`,
    [req.params.id]
  );
  return r.rows.length ? r.rows[0].client_id : null;
}), async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `SELECT * FROM pcm_transactions WHERE transaction_id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const stages = await db.clients.query(
      `SELECT * FROM pcm_transaction_stages WHERE transaction_id = $1 ORDER BY stage_number ASC`,
      [req.params.id]
    );
    res.json({ ...result.rows[0], stages: stages.rows });
  } catch (err) { next(err); }
});

// ─── UPDATE TRANSACTION ───────────────────────────────────────────────────────
router.put('/:id', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const updates = [];
    const params  = [];
    for (const field of WRITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    if (req.body.transaction_type !== undefined &&
        !TRANSACTION_TYPES.includes(req.body.transaction_type)) {
      return res.status(400).json({ error: `transaction_type must be one of: ${TRANSACTION_TYPES.join(', ')}` });
    }

    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const result = await db.clients.query(
      `UPDATE pcm_transactions SET ${updates.join(', ')} WHERE transaction_id = $${params.length} RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── ACKNOWLEDGE RULES (client-portal action — compliance gate) ───────────────
// The client themselves must acknowledge (client-auth token, role='client'), and
// only for their OWN transaction. This sets rules_acknowledged, which
// transaction-stages.js's PUT /:txId/stages/:stageNumber actually enforces
// (blocks completing any stage until this is true) -- previously this flag
// was set here but read nowhere, so calling it "the compliance gate" was
// aspirational, not real. It's real as of the transaction-stages.js gating pass.
router.post('/:id/acknowledge-rules', authorize('client'), async (req, res, next) => {
  try {
    const existing = await db.clients.query(
      `SELECT client_id FROM pcm_transactions WHERE transaction_id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    if (existing.rows[0].client_id !== req.user.client_id) {
      return res.status(403).json({ error: 'Clients may only acknowledge rules for their own transactions' });
    }

    const result = await db.clients.query(
      `UPDATE pcm_transactions
       SET rules_acknowledged = true, rules_acknowledged_at = NOW(), updated_at = NOW()
       WHERE transaction_id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
