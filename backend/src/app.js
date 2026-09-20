'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { config } = require('./config');
const registry = require('./services/registry');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { notFound, errorHandler } = require('./middleware/errors');

function build() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    /* The API serves JSON only — nothing here should ever be framed, sniffed
       or referred onward with a full URL. */
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.env === 'production'
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false
  }));
  app.use(compression());
  app.use(express.json({ limit: '16kb' }));       // the form is tiny; cap it hard

  /* Reject duplicated query params outright: ?status=a&status=b arrives as an
     array and every downstream String() would silently read only part of it. */
  app.use((req, res, next) => {
    for (const v of Object.values(req.query || {})) {
      if (Array.isArray(v)) {
        return res.status(400).json({ ok: false, code: 'BAD_QUERY',
          message: 'Repeated query parameters are not accepted.' });
      }
    }
    next();
  });

  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);          // curl, server-to-server
      if (config.corsOrigins.length === 0) {
        if (config.env === 'production') return cb(null, false);   // never open in prod
        return cb(null, true);                                     // dev convenience
      }
      cb(null, config.corsOrigins.includes(origin));
    },
    methods: ['GET', 'POST'],
    credentials: false,
    /* The admin panel sends Authorization on every call and downloads the CSV
       export as a blob; without these the browser blocks both before the
       request is even made. */
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400
  }));

  /* Blanket ceiling. The per-route limiters are stricter where it matters. */
  app.use(rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

  app.get('/health', (req, res) => {
    const snap = registry.get();
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      edition: config.edition.id,
      taken: snap?.taken ?? null,
      locked: snap?.locked ?? null,
      open: snap?.open ?? null
    });
  });

  app.use('/api', publicRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { build };