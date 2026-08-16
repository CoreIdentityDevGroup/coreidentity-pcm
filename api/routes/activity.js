'use strict';
const express = require('express');
const db      = require('../services/db');
const { requireOwnClientOrStaff } = require('../middleware/ownership');
const router  = express.Router();

// This file only ever reads pcm_agent_activity (SELECT) -- never writes to or
// deletes from it, and these fixes don't change that.

const ownClient = requireOwnClientOrStaff(req => req.params.id);
const ownAsset = requireOwnClientOrStaff(async req => {
  const r = await db.assets.query(
    `SELECT client_id FROM pcm_assets WHERE asset_id = $1 AND deleted_at IS NULL`,
    [req.params.id]
  );
  return r.rows.length ? r.rows[0].client_id : null;
});

// GET /api/v1/activity — platform-wide agent activity feed
router.get('/', async (req, res, next) => {
  try {
    const { asset_id, agent_name, limit = 50 } = req.query;
    // Client-role tokens are always scoped to their own client_id, regardless
    // of any client_id passed in the query string. Combined with an AND on
    // asset_id below, this also blocks probing someone else's asset_id --
    // rows only match if BOTH the (forced) own client_id and the requested
    // asset_id are true, which is impossible for another client's asset.
    const client_id = req.user?.role === 'client' ? req.user.client_id : req.query.client_id;

    let where = [];
    let params = [];

    if (client_id)  { params.push(client_id);  where.push(`client_id = $${params.length}`); }
    if (asset_id)   { params.push(asset_id);   where.push(`asset_id = $${params.length}`); }
    if (agent_name) { params.push(agent_name); where.push(`agent_name = $${params.length}`); }

    params.push(parseInt(limit));
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await db.clients.query(
      `SELECT activity_id, agent_name, client_id, asset_id,
              action, status, decision, proof_pack_id,
              duration_ms, result_summary, triggered_by, created_at
       FROM pcm_agent_activity
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ activity: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// GET /api/v1/activity/client/:id — activity for a specific client
router.get('/client/:id', ownClient, async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const result = await db.clients.query(
      `SELECT activity_id, agent_name, action, status, decision,
              proof_pack_id, duration_ms, result_summary, triggered_by, created_at
       FROM pcm_agent_activity
       WHERE client_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, parseInt(limit)]
    );
    res.json({ activity: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

// GET /api/v1/activity/asset/:id — activity for a specific asset
router.get('/asset/:id', ownAsset, async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const result = await db.clients.query(
      `SELECT activity_id, agent_name, action, status, decision,
              proof_pack_id, duration_ms, result_summary, triggered_by, created_at
       FROM pcm_agent_activity
       WHERE asset_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [req.params.id, parseInt(limit)]
    );
    res.json({ activity: result.rows, count: result.rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
