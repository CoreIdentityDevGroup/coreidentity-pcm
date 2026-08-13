#!/usr/bin/env node
/**
 * CLOSE-GAP-19b: PATCH /forms/:id/status let any caller set
 * pcm_agreements.status directly to fully_executed, bypassing the actual
 * signature flow
 *
 * pcm_agreement_status enum (checked live before writing this): draft,
 * pending_signature, partially_signed, fully_executed, expired,
 * superseded, voided. Only two of these are computed by real evidence
 * elsewhere in the code -- PATCH /:id/parties/:party_id/sign sets
 * 'partially_signed' or 'fully_executed' based on whether every party
 * has actually signed (api/routes/forms.js, the unsigned-count query).
 * The other five (draft, pending_signature, expired, superseded, voided)
 * are administrative statuses with no signature-computed equivalent --
 * marking an agreement expired, superseded by a new version, or voided
 * are legitimate manual actions with no other path in this codebase.
 *
 * Fix: block only 'fully_executed' and 'partially_signed' from this
 * route -- those two values must only be reachable via the real signing
 * flow, which is unaffected by this change. Every other enum value
 * remains settable here, since blocking them would remove the only path
 * that has ever existed for genuinely administrative status changes.
 *
 * No database access of any kind -- this script only edits source files
 * and runs `npm run build`.
 *
 * Idempotent: detects the existing CLOSE-GAP-19b marker before writing;
 * no-ops cleanly on re-run.
 *
 * Run: node scripts/close-gap-19b-restrict-agreement-status.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TARGET    = path.join(REPO_ROOT, 'api', 'routes', 'forms.js');

const OLD_BLOCK = `// ─── UPDATE AGREEMENT STATUS ──────────────────────────────────────────────────
router.patch('/:id/status', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });

    const result = await db.forms.query(
      \`UPDATE pcm_agreements SET status = $1
       WHERE agreement_id = $2 RETURNING *\`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agreement not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});`;

const NEW_BLOCK = `// ─── UPDATE AGREEMENT STATUS ──────────────────────────────────────────────────
// CLOSE-GAP-19b: 'fully_executed' and 'partially_signed' are computed by
// PATCH /:id/parties/:party_id/sign from actual signature state -- they
// must not be settable here from an unverified request body. Every other
// status in the enum (draft, pending_signature, expired, superseded,
// voided) has no signature-computed equivalent and remains a legitimate
// manual action.
const SIGNATURE_COMPUTED_STATUSES = ['fully_executed', 'partially_signed'];

router.patch('/:id/status', authorize('trade_group_owner','program_manager'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });

    if (SIGNATURE_COMPUTED_STATUSES.includes(status)) {
      return res.status(403).json({
        error:       'Status not settable directly',
        status,
        message:     \`'\${status}' is computed from actual party signatures, not assertable directly. Use PATCH /:id/parties/:party_id/sign.\`,
        use_instead: '/api/v1/forms/:id/parties/:party_id/sign'
      });
    }

    const result = await db.forms.query(
      \`UPDATE pcm_agreements SET status = $1
       WHERE agreement_id = $2 RETURNING *\`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agreement not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ Target file not found: ${TARGET}`);
    process.exit(1);
  }

  const contents = fs.readFileSync(TARGET, 'utf8');

  if (contents.includes('CLOSE-GAP-19b')) {
    console.log('✓ CLOSE-GAP-19b already applied — no-op.');
    return;
  }

  if (!contents.includes(OLD_BLOCK)) {
    console.error('✗ Expected PATCH /:id/status handler not found — file may have changed since this script was written.');
    console.error('  Refusing to apply blind edit. Manual review required.');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, contents.replace(OLD_BLOCK, NEW_BLOCK), 'utf8');
  console.log('✓ CLOSE-GAP-19b applied: PATCH /forms/:id/status rejects fully_executed/partially_signed,');
  console.log('  points callers at the real signing flow. Other status values unaffected.');

  console.log('\nRunning npm run build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

main();
