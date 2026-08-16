'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

// ─── CREATE DOCUMENT (with versioning, atomic) ────────────────────────────────
router.post('/', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  const {
    client_id, transaction_id, document_type, file_name,
    file_size_bytes, mime_type, storage_path
  } = req.body;

  if (!file_name || !storage_path) {
    return res.status(400).json({ error: 'file_name and storage_path are required' });
  }

  const client = await db.clients.connect();
  try {
    await client.query('BEGIN');

    // Find an existing active doc with the same identity tuple (null-safe match).
    const existing = await client.query(
      `SELECT document_id, version FROM pcm_documents
       WHERE active = true
         AND client_id      IS NOT DISTINCT FROM $1
         AND transaction_id IS NOT DISTINCT FROM $2
         AND document_type  IS NOT DISTINCT FROM $3
         AND file_name = $4
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [client_id ?? null, transaction_id ?? null, document_type ?? null, file_name]
    );

    let version = 1;
    if (existing.rows.length) {
      version = existing.rows[0].version + 1;
      await client.query(
        `UPDATE pcm_documents SET active = false WHERE document_id = $1`,
        [existing.rows[0].document_id]
      );
    }

    const result = await client.query(
      `INSERT INTO pcm_documents
        (client_id, transaction_id, document_type, file_name,
         file_size_bytes, mime_type, storage_path, uploaded_by, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [client_id ?? null, transaction_id ?? null, document_type ?? null, file_name,
       file_size_bytes ?? null, mime_type ?? null, storage_path,
       req.user.sub || 'system', version]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ─── LIST DOCUMENTS (by transaction or client) ────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { transaction_id } = req.query;
    // Client-role tokens are always scoped to their own client_id, regardless
    // of any client_id passed in the query string -- combined with an AND on
    // transaction_id below, this also blocks probing another client's
    // transaction_id (same reasoning as activity.js's LIST route).
    const client_id = req.user?.role === 'client' ? req.user.client_id : req.query.client_id;
    if (!transaction_id && !client_id) {
      return res.status(400).json({ error: 'transaction_id or client_id query parameter is required' });
    }

    let query = `SELECT * FROM pcm_documents WHERE active = true`;
    const params = [];
    if (transaction_id) { params.push(transaction_id); query += ` AND transaction_id = $${params.length}`; }
    if (client_id)      { params.push(client_id);      query += ` AND client_id = $${params.length}`; }
    query += ` ORDER BY created_at DESC`;

    const result = await db.clients.query(query, params);
    res.json({ documents: result.rows });
  } catch (err) { next(err); }
});

// ─── SOFT DELETE DOCUMENT ─────────────────────────────────────────────────────
router.delete('/:id', authorize('trade_group_owner','program_manager','intake_officer'), async (req, res, next) => {
  try {
    const result = await db.clients.query(
      `UPDATE pcm_documents SET active = false
       WHERE document_id = $1 AND active = true RETURNING document_id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json({ message: 'Document deactivated', document_id: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
