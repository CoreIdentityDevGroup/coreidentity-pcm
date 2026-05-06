'use strict';

function errorHandler(err, req, res, _next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  console.error(JSON.stringify({
    level:      'error',
    requestId:  req.requestId,
    method:     req.method,
    path:       req.path,
    status,
    message,
    stack:      process.env.NODE_ENV === 'development' ? err.stack : undefined,
    timestamp:  new Date().toISOString()
  }));

  res.status(status).json({
    error:     message,
    requestId: req.requestId
  });
}

module.exports = { errorHandler };
