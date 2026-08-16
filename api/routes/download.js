'use strict';
const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { authorize } = require('../middleware/authorize');
const router  = express.Router();
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });

const BUCKET_MAP = {
  kyc:      process.env.PCM_BUCKET_KYC_VAULT,
  pof:      process.env.PCM_BUCKET_KYC_VAULT,
  cis:      process.env.PCM_BUCKET_KYC_VAULT,
  asset:    process.env.PCM_BUCKET_ASSET_DOCS,
  forms:    process.env.PCM_BUCKET_FORMS,
  deletion: process.env.PCM_BUCKET_DELETION_CERTS
};

// No client role should ever fetch a permanent deletion certificate --
// these attest that a client's data was deleted, not something the client
// (whose data is gone) has any account left to request from.
const STAFF_ONLY_BUCKETS = new Set(['deletion']);

// GET /api/v1/download?bucket=kyc&path=kyc/client_id/file.pdf
// Previously had NO ownership check at all -- any authenticated role, any
// bucket, any path, as long as it wasn't literal `..` traversal. That meant
// raw KYC/POF/ID-document FILE CONTENT (not just metadata) for any client
// was downloadable by any other authenticated caller who knew or guessed the
// object_path. Fixed by deriving the owning client_id directly from the path
// convention upload.js itself already uses to write these paths --
// `{doc_category}/{client_id}/...` or `{doc_category}/{client_id}/{asset_id}/...`
// -- and applying the same client-role ownership check used elsewhere, rather
// than inventing a new authorization mechanism.
router.get('/', async (req, res) => {
  const { bucket: bucket_key, path: object_path } = req.query;

  if (!bucket_key || !object_path)
    return res.status(400).json({ error: 'bucket and path required' });

  const bucket_name = BUCKET_MAP[bucket_key];
  if (!bucket_name)
    return res.status(400).json({ error: `Unknown bucket: ${bucket_key}` });

  // Security: prevent path traversal
  if (object_path.includes('..') || object_path.startsWith('/'))
    return res.status(400).json({ error: 'Invalid path' });

  if (STAFF_ONLY_BUCKETS.has(bucket_key) && req.user?.role === 'client') {
    return res.status(403).json({ error: 'Clients may not access this bucket' });
  }

  if (req.user?.role === 'client') {
    // upload.js writes exactly `${doc_category}/${client_id}/...` -- the
    // second path segment is always the owning client_id.
    const pathClientId = object_path.split('/')[1];
    if (pathClientId !== req.user.client_id) {
      return res.status(403).json({ error: 'Clients may only access their own documents' });
    }
  }

  try {
    const file = storage.bucket(bucket_name).file(object_path);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'File not found' });

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || 'application/octet-stream';
    const fileName = object_path.split('/').pop();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');

    file.createReadStream()
      .on('error', err => {
        console.error(JSON.stringify({ level: 'error', message: 'Download error', error: err.message }));
        if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      })
      .pipe(res);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Download error', error: err.message }));
    res.status(500).json({ error: 'Download failed', detail: err.message });
  }
});

module.exports = router;
