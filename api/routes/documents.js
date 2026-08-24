'use strict';

const express  = require('express');
const db       = require('../services/db');
const { authorize } = require('../middleware/authorize');
const router   = express.Router();

// ─── CREATE DOCUMENT (with versioning, atomic) ────────────────────────────────
router.post('/', authorize('facilitator','program_manager','intake_officer'), async (req, res, next) => {
  const {
    client_id, document_type, file_name,
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
         AND document_type  IS NOT DISTINCT FROM $2
         AND file_name = $3
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [client_id ?? null, document_type ?? null, file_name]
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
        (client_id, document_type, file_name,
         file_size_bytes, mime_type, storage_path, uploaded_by, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [client_id ?? null, document_type ?? null, file_name,
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

// ─── LIST DOCUMENTS (by client) ────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    // Client-role tokens are always scoped to their own client_id, regardless
    // of any client_id passed in the query string (same reasoning as
    // activity.js's LIST route).
    const client_id = req.user?.role === 'client' ? req.user.client_id : req.query.client_id;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id query parameter is required' });
    }

    const result = await db.clients.query(
      `SELECT * FROM pcm_documents WHERE active = true AND client_id = $1 ORDER BY created_at DESC`,
      [client_id]
    );
    res.json({ documents: result.rows });
  } catch (err) { next(err); }
});

// ─── SOFT DELETE DOCUMENT ─────────────────────────────────────────────────────
router.delete('/:id', authorize('facilitator','program_manager','intake_officer'), async (req, res, next) => {
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
