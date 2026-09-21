'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const registry = require('../services/registry');
const mailer = require('../services/mailer');
const Registration = require('../models/Registration');
const { sanitize, antiBot, validateRegistration, validateWaitlist } = require('../middleware/validate');
const waitlist = require('../services/waitlist');
const Waitlist = require('../models/Waitlist');
const { config } = require('../config');

const router = express.Router();

/* 8 per minute per IP. Deliberately loose: several Tunisian schools can sit
   behind one carrier-grade NAT address, and a tight per-IP limit would have
   them locking each other out on registration morning. The real protection is
   the honeypot + minimum fill time in antiBot, the unique-school index, and
   the atomic 150-cap in Mongo. This limiter only keeps bulk junk off the
   write path. */
const registerLimiter = rateLimit({
  windowMs: 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute.' }
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 180,
  standardHeaders: true, legacyHeaders: false
});

/* References are sequential (BQF-2026-000001, 000002, ...) so the lookup
   endpoint is trivially enumerable. Everything it returns is already public on
   the leaderboard, so this is not a disclosure hole — but rate limiting it
   keeps the whole register from being scraped in one pass. */
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', message: 'Too many lookups.' }
});

/* ── GET /api/state ─────────────────────────────────────────────────────────
   Counter, four passes, four leaderboards. Served entirely from memory.     */
router.get('/state', readLimiter, (req, res) => {
  const snap = registry.get();
  if (!snap) return res.status(503).json({ ok: false, code: 'WARMING', message: 'Starting up.' });
  res.set('Cache-Control', 'public, max-age=5');
  res.json({ ok: true, data: snap });
});

/* ── GET /api/board/:gov ──────────────────────────────────────────────────── */
router.get('/board/:gov', readLimiter, (req, res, next) => {
  const snap = registry.get();
  const g = snap?.govs?.[req.params.gov];
  if (!g) return next(registry.appError('NOT_FOUND', 404, 'Unknown gouvernorat.'));
  res.set('Cache-Control', 'public, max-age=5');
  res.json({ ok: true, data: { gov: req.params.gov, count: g.count, board: g.board } });
});

/* ── POST /api/registrations ───────────────────────────────────────────────
   The only write the public can make. Slot claim is atomic; the timestamp is
   ours; the e-mail is fired after the response so SMTP can never hold the
   request open — rank is decided by arrival time and must not wait on mail.  */
router.post('/registrations', registerLimiter, sanitize, antiBot, validateRegistration, async (req, res, next) => {
  try {
    const { doc, rank } = await registry.register(req.validated, {
      ip: req.ip,
      userAgent: (req.get('user-agent') || '').slice(0, 300)
    });

    const gov = config.GOVS[doc.gov];
    res.status(201).json({
      ok: true,
      data: {
        ref: doc.ref,
        rank,
        gov: doc.gov,
        govName: { fr: gov.fr, ar: gov.ar },
        day:  { fr: gov.dFr, ar: gov.dAr },
        pass: { fr: gov.pFr, ar: gov.pAr },
        hex: gov.hex,
        seats: doc.seats,
        status: doc.status,
        registeredAt: doc.registeredAt.toISOString(),
        lang: doc.lang,
        email: doc.email,
        pendingTtlHours: config.edition.pendingTtlHours
      }
    });

    /* Both e-mails go out after the response and neither is awaited. A slow
       SMTP handshake must never hold open a request whose arrival time decides
       a public ranking. */

    /* The organisation needs to know who to go and see. */
    mailer.sendOrganiserAlert('registration', {
      school: doc.school, gov: doc.gov, director: doc.director,
      phone: doc.phone, email: doc.email, lang: doc.lang,
      ref: doc.ref, rank, at: doc.registeredAt,
      taken: registry.get()?.taken ?? 0
    }).catch(err => console.error('[mail:alert]', doc.ref, err.message));

    /* Failures are recorded on the row, never surfaced to the director as a
       registration failure — they ARE registered. */
    mailer.sendConfirmation({
      to: doc.email, lang: doc.lang, school: doc.school,
      gov: doc.gov, ref: doc.ref, registeredAt: doc.registeredAt, rank
    })
      .then(r => Registration.updateOne({ _id: doc._id }, {
        $set: { 'mail.confirmationSentAt': new Date(), 'mail.confirmationError': r.dryRun ? 'DRY_RUN' : null },
        $inc: { 'mail.attempts': 1 }
      }).exec())
      .catch(err => {
        console.error('[mail]', doc.ref, err.message);
        Registration.updateOne({ _id: doc._id }, {
          $set: { 'mail.confirmationError': err.message.slice(0, 300) },
          $inc: { 'mail.attempts': 1 }
        }).exec().catch(() => {});
      });

  } catch (err) { next(err); }
});


/* ── POST /api/waitlist ────────────────────────────────────────────────────
   300 schools invited, 150 places. This endpoint catches the other half.    */
router.post('/waitlist', registerLimiter, sanitize, antiBot, validateWaitlist, async (req, res, next) => {
  try {
    const { doc, rank } = await waitlist.join(req.validated, {
      ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 300)
    });

    const gov = config.GOVS[doc.gov];
    res.status(201).json({ ok: true, data: {
      ref: doc.ref, rank, gov: doc.gov,
      govName: { fr: gov.fr, ar: gov.ar },
      joinedAt: doc.joinedAt.toISOString(),
      lang: doc.lang, email: doc.email
    }});

    mailer.sendOrganiserAlert('waitlist', {
      school: doc.school, gov: doc.gov, director: doc.director,
      phone: doc.phone, email: doc.email, lang: doc.lang,
      ref: doc.ref, rank, at: doc.joinedAt
    }).catch(err => console.error('[mail:alert:wl]', doc.ref, err.message));

    mailer.sendWaitlist({
      to: doc.email, lang: doc.lang, school: doc.school,
      gov: doc.gov, ref: doc.ref, joinedAt: doc.joinedAt, rank
    })
      .then(r => Waitlist.updateOne({ _id: doc._id }, {
        $set: { 'mail.sentAt': new Date(), 'mail.error': r.dryRun ? 'DRY_RUN' : null },
        $inc: { 'mail.attempts': 1 }
      }).exec())
      .catch(err => {
        console.error('[mail:wl]', doc.ref, err.message);
        Waitlist.updateOne({ _id: doc._id }, {
          $set: { 'mail.error': err.message.slice(0, 300) }, $inc: { 'mail.attempts': 1 }
        }).exec().catch(() => {});
      });

  } catch (err) { next(err); }
});

/* ── POST /api/lookup ──────────────────────────────────────────────────────
   A school retrieving its own card after closing the tab (spec section 5).

   Reference AND e-mail, not reference alone. References are sequential, so a
   ref-only lookup is enumerable — harmless for registrations, whose data is on
   the public leaderboard anyway, but a real leak for the waiting list, whose
   membership is private. The director holds both values; nobody else does.

   POST, so the e-mail never appears in a URL, a proxy log or browser history.
   Every miss returns the SAME response whether the reference or the e-mail was
   wrong, so the endpoint cannot be used to confirm that a reference exists.  */
const REF_RX = /^(BQF|WL)-\d{4}-\d{6}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.post('/lookup', lookupLimiter, sanitize, async (req, res, next) => {
  const miss = () => next(registry.appError('NOT_FOUND', 404,
    'No registration matches this reference and e-mail address.'));
  try {
    const ref = String(req.body?.ref || '').trim().toUpperCase();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!REF_RX.test(ref) || !EMAIL_RX.test(email) || email.length > 160) return miss();

    if (ref.startsWith('BQF-')) {
      const doc = await Registration.findOne({ ref, email, edition: registry.EDITION })
        .select('ref school gov status registeredAt approvedAt seats lang').lean();
      if (!doc) return miss();
      const board = registry.get()?.govs?.[doc.gov]?.board || [];
      const rank = board.findIndex(r => r.ref === doc.ref) + 1;
      return res.json({ ok: true, data: {
        kind: 'registration', ref: doc.ref, school: doc.school, gov: doc.gov,
        status: doc.status, rank: rank || null, seats: doc.seats,
        registeredAt: doc.registeredAt.toISOString(),
        approvedAt: doc.approvedAt ? doc.approvedAt.toISOString() : null,
        pendingTtlHours: config.edition.pendingTtlHours
      }});
    }

    const doc = await Waitlist.findOne({ ref, email, edition: registry.EDITION })
      .select('ref school gov status joinedAt position').lean();
    if (!doc) return miss();
    const rank = doc.status === 'waiting' ? await waitlist.rankOf(doc) : null;
    return res.json({ ok: true, data: {
      kind: 'waitlist', ref: doc.ref, school: doc.school, gov: doc.gov,
      status: doc.status, rank, joinedAt: doc.joinedAt.toISOString()
    }});

  } catch (err) { next(err); }
});

module.exports = router;