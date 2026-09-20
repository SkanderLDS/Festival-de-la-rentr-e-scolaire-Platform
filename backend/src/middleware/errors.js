'use strict';
const { config } = require('../config');

function notFound(req, res) {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Unknown endpoint.' });
}

/* eslint-disable no-unused-vars */
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL';

  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  else if (config.env !== 'production') console.warn('[warn]', code, err.message);

  res.status(status).json({
    ok: false,
    code,
    message: err.expose || status < 500 ? err.message : 'Internal server error.',
    ...(err.fields ? { fields: err.fields } : {})
  });
}

module.exports = { notFound, errorHandler };
