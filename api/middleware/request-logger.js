'use strict';

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      level:      'info',
      requestId:  req.requestId,
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      duration:   `${Date.now() - start}ms`,
      userAgent:  req.headers['user-agent'],
      timestamp:  new Date().toISOString()
    }));
  });
  next();
}

module.exports = { requestLogger };
