// Central error handler: logs full detail server-side, returns generic messages to clients.
module.exports = function errorHandler(err, req, res, next) {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  const isParse = err.type === 'entity.parse.failed' || err.status === 400;
  const status = isParse ? 400 : err.status || err.statusCode || 500;
  res.status(status).json({ message: status === 400 ? 'Invalid request' : 'Server error' });
};
