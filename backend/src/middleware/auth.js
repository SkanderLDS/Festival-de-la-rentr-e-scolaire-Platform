'use strict';
const jwt = require('jsonwebtoken');
const { config } = require('../config');

function sign(admin) {
  return jwt.sign(
    { sub: String(admin._id), u: admin.username, r: admin.role, n: admin.name },
    config.jwt.secret,
    { expiresIn: config.jwt.ttl, algorithm: 'HS256' }
  );
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return deny(next, 'NO_TOKEN', 'Authentication required.');
  try {
    /* Pin the algorithm. Without this, jwt.verify accepts whatever `alg` the
       token header claims, which is the classic algorithm-confusion bypass. */
    req.admin = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    next();
  } catch {
    deny(next, 'BAD_TOKEN', 'Session expired. Sign in again.');
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.admin) return deny(next, 'NO_TOKEN', 'Authentication required.');
    if (role === 'admin' && req.admin.r !== 'admin')
      return deny(next, 'FORBIDDEN', 'This action requires an admin account.', 403);
    next();
  };
}

function deny(next, code, message, status = 401) {
  const e = new Error(message);
  e.status = status; e.code = code; e.expose = true;
  next(e);
}

module.exports = { sign, requireAuth, requireRole };
