'use strict';

// Client-role tokens may only access resources bound to their own client_id.
// Staff roles (administrator, program_manager, intake_officer) keep their
// existing, unrestricted scope over client-linked resources -- this only adds
// a floor under the 'client' role. Mirrors the ownership check already
// established in transactions.js's acknowledge-rules route (fetch the
// resource, compare client_id, 403 on mismatch), applied consistently via one
// middleware instead of copy-pasted per route.
//
// `getClientId(req)` must resolve to the client_id that owns the resource
// being accessed. For routes where the client_id IS the path param, pass
// `req => req.params.id`. For routes where it must be looked up (e.g. by
// transaction_id or asset_id), pass an async function that does that lookup
// and returns the client_id, or null if the resource doesn't exist -- in the
// null case this middleware lets the request through so the route's own 404
// handling runs normally instead of this middleware masking it as a 403.
function requireOwnClientOrStaff(getClientId) {
  return async function requireOwnClientOrStaffMiddleware(req, res, next) {
    if (req.user?.role !== 'client') return next();
    try {
      const ownerClientId = await getClientId(req);
      if (ownerClientId !== null && ownerClientId !== req.user.client_id) {
        return res.status(403).json({ error: 'Clients may only access their own records' });
      }
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { requireOwnClientOrStaff };
