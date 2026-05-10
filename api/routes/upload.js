'use strict';
const governance = require('../services/governance');
const express = require('express');
const multer  = require('multer');
const { Storage } = require('@google-cloud/storage');
const router  = express.Router();

const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const BUCKET_MAP = {
  kyc:      process.env.PCM_BUCKET_KYC_VAULT,
  pof:      process.env.PCM_BUCKET_KYC_VAULT,
  cis:      process.env.PCM_BUCKET_KYC_VAULT,
  asset:    process.env.PCM_BUCKET_ASSET_DOCS,
  forms:    process.env.PCM_BUCKET_FORMS,
  deletion: process.env.PCM_BUCKET_DELETION_CERTS
};

const ALLOWED_TYPES = [
  'application/pdf','image/jpeg','image/png','image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

// POST /api/v1/upload
// Form: file, doc_category, client_id, asset_id (optional)
router.post('/', upload.single('file'), async (req, res) => {
  const { doc_category, client_id, asset_id } = req.body;
  const file = req.file;

  if (!file || !doc_category || !client_id)
    return res.status(400).json({ error: 'file, doc_category, client_id required' });

  if (!ALLOWED_TYPES.includes(file.mimetype))
    return res.status(400).json({ error: 'File type not permitted' });

  const bucket_name = BUCKET_MAP[doc_category];
  if (!bucket_name)
    return res.status(400).json({ error: `Unknown doc_category: ${doc_category}` });

  const timestamp   = Date.now();
  const safe_name   = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const object_path = asset_id
    ? `${doc_category}/${client_id}/${asset_id}/${timestamp}_${safe_name}`
    : `${doc_category}/${client_id}/${timestamp}_${safe_name}`;

  try {
    const bucket     = storage.bucket(bucket_name);
    const gcs_file   = bucket.file(object_path);

    await gcs_file.save(file.buffer, {
      metadata: { contentType: file.mimetype },
      resumable: false
    });

    // Log document upload to SAL
    governance.onDocumentUpload({
      client_id, asset_id,
      doc_type: doc_category,
      file_name: file.originalname,
      uploaded_by: req.user?.sub || 'system'
    }).catch(() => {});

    res.json({
      success:     true,
      object_path,
      bucket:      bucket_name,
      file_name:   file.originalname,
      size:        file.size,
      content_type: file.mimetype
    });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Upload error', error: err.message }));
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
});

module.exports = router;
