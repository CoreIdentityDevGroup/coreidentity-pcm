'use strict';

// Explicit permission sets, not a >= hierarchy (2026-08-17 access-control
// redesign). Facilitator/Program Manager/Intake Officer no longer rank
// against each other -- each route/gate names exactly which roles may act
// on it. Facilitator remains a strict superset by definition (full
// platform access), enforced below by always passing the check, not by
// listing 'facilitator' in every single allow-list.
//
// ALIAS WINDOW (trade_group_owner -> facilitator rename, db/migrations/
// 0012): a JWT's role claim is frozen at sign time and can't be
// retroactively rewritten. pcm_staff.role is updated to 'facilitator'
// immediately (0012), so any FRESH login after this deploy signs
// 'facilitator'. But a token signed before this deploy (valid up to 8h,
// auth.js's expiresIn) still carries the literal string
// 'trade_group_owner' -- normalizeRole() is the one place that maps it
// back to 'facilitator' so those live sessions don't 403 the moment
// this ships.
//
// REMOVE the alias in a tracked follow-up once 8h has definitively passed
// since deploy (same pattern as the OFAC BLOCK_DAYS UAT override -- a
// temporary dual-state with an explicit removal condition, not a
// permanent shim). Do not remove it early "because it looks done" --
// removing it before every pre-deploy token has expired 403s anyone still
// holding one.
const ROLE_ALIAS = { trade_group_owner: 'facilitator' };

function normalizeRole(role) {
  return ROLE_ALIAS[role] || role;
}

function isFacilitator(role) {
  return normalizeRole(role) === 'facilitator';
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    const userRole = normalizeRole(req.user?.role);
    if (!userRole) {
      return res.status(403).json({ error: 'Insufficient permissions', required: allowedRoles, current: 'none' });
    }
    if (userRole === 'facilitator' || allowedRoles.includes(userRole)) {
      return next();
    }
    return res.status(403).json({
      error: 'Insufficient permissions',
      required: allowedRoles,
      current: req.user.role
    });
  };
}

module.exports = { authorize, normalizeRole, isFacilitator };
