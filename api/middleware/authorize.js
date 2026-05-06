'use strict';

const ROLE_HIERARCHY = {
  trade_group_owner: 3,
  program_manager:   2,
  intake_officer:    1,
  system:            0
};

function authorize(...allowedRoles) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole || !allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: allowedRoles,
        current: userRole || 'none'
      });
    }
    next();
  };
}

module.exports = { authorize, ROLE_HIERARCHY };
