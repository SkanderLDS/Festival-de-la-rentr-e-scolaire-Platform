'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const AdminUser = require('../models/AdminUser');
const Registration = require('../models/Registration');
const registry = require('../services/registry');
const waitlistSvc = require('../services/waitlist');
const Waitlist = require('../models/Waitlist');
const mailer = require('../services/mailer');
const { sign, requireAuth, requireRole } = require('../middleware/auth');
const { sanitize } = require('../middleware/validate');
const { config } = require('../config');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, code: 'RATE_LIMITED', message: 'Too many sign-in attempts.' }
});

/* ── POST /api/admin/login ─────────────────────────────────────────────────── */
router.post('/login', loginLimiter, sanitize, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    const bad = () => registry.appError('BAD_CREDENTIALS', 401, 'Incorrect username or password.');

    if (!username || !password) return next(bad());
    const admin = await AdminUser.findOne({ username, active: true });
    /* Always spend the bcrypt cost, even when the user does not exist, so the
       response time cannot be used to enumerate valid usernames. */
    const DUMMY = '$2a$12$abcdefghijklmnopqrstuuKq7Zr8mJZ0Y3vZ1wQ1xW9sJ8Q2Gf6Aa';
    const okPw = admin ? await admin.verify(password)
                       : await require('bcryptjs').compare(password, DUMMY).catch(() => false);
    if (!admin || !okPw) return next(bad());

    admin.lastLoginAt = new Date();
    await admin.save();

    res.json({ ok: true, data: {
      token: sign(admin),
      admin: { username: admin.username, name: admin.name, role: admin.role }
    }});
  } catch (err) { next(err); }
});

router.use(requireAuth);

/* ── GET /api/admin/me ─────────────────────────────────────────────────────── */
router.get('/me', (req, res) => {
  res.json({ ok: true, data: { username: req.admin.u, name: req.admin.n, role: req.admin.r } });
});

/* ── GET /api/admin/stats ──────────────────────────────────────────────────── */
router.get('/stats', async (req, res, next) => {
  try {
    const rows = await Registration.aggregate([
      { $match: { edition: registry.EDITION } },
      { $group: { _id: { gov: '$gov', status: '$status' }, n: { $sum: 1 }, seats: { $sum: '$seats' } } }
    ]);
    const snap = registry.get();
    const byStatus = {};
    for (const r of rows) {
      byStatus[r._id.status] = byStatus[r._id.status] || { n: 0, seats: 0, byGov: {} };
      byStatus[r._id.status].n += r.n;
      byStatus[r._id.status].seats += r.seats;
      byStatus[r._id.status].byGov[r._id.gov] = r.n;
    }
    const mailFailed = await Registration.countDocuments({
      edition: registry.EDITION, 'mail.confirmationError': { $nin: [null, 'DRY_RUN'] }
    });
    const waiting = await Waitlist.countDocuments({ edition: registry.EDITION, status: 'waiting' });
    const invited = await Waitlist.countDocuments({ edition: registry.EDITION, status: 'invited' });
    res.json({ ok: true, data: {
      taken: snap.taken, left: snap.left, locked: snap.locked,
      waitlist: { waiting, invited },
      revenueExpectedDT: (byStatus.approved?.seats || 0) * 20,
      depositsExpectedDT: (byStatus.approved?.n || 0) * 500,
      byStatus, mailFailed
    }});
  } catch (err) { next(err); }
});

/* ── GET /api/admin/registrations ──────────────────────────────────────────
   Full contact details. This is the ONLY place PII is returned.            */
router.get('/registrations', async (req, res, next) => {
  try {
    const q = { edition: registry.EDITION };
    if (req.query.status) q.status = String(req.query.status);
    if (req.query.gov) q.gov = String(req.query.gov);
    if (req.query.search) {
      const key = Registration.schoolKeyOf(String(req.query.search));
      q.schoolKey = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const [items, total] = await Promise.all([
      Registration.find(q).sort({ registeredAt: 1, slot: 1 }).skip(skip).limit(limit).lean(),
      Registration.countDocuments(q)
    ]);

    const boards = registry.get()?.govs || {};
    const withRank = items.map(r => ({
      ...r,
      rank: (boards[r.gov]?.board.findIndex(b => b.ref === r.ref) ?? -1) + 1 || null,
      ageHours: Math.floor((Date.now() - new Date(r.registeredAt)) / 3600000)
    }));

    res.json({ ok: true, data: { items: withRank, total, limit, skip } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/registrations/:ref/approve ────────────────────────────
   Called when the delegate has collected the 500 DT avance.                */
router.post('/registrations/:ref/approve', requireRole('admin'), sanitize, async (req, res, next) => {
  try {
    const { doc, changed } = await registry.approve(
      req.params.ref, req.admin.u, String(req.body?.depositRef || '').slice(0, 80) || null
    );
    res.json({ ok: true, data: { ref: doc.ref, status: doc.status, changed } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/registrations/:ref/release ────────────────────────────
   Frees the slot and the day seats. The row is kept for the audit trail.    */
router.post('/registrations/:ref/release', requireRole('admin'), sanitize, async (req, res, next) => {
  try {
    const status = req.body?.status === 'expired' ? 'expired' : 'cancelled';
    const { doc, changed } = await registry.release(
      req.params.ref, status, String(req.body?.note || '').slice(0, 300)
    );
    res.json({ ok: true, data: { ref: doc.ref, status: doc.status, changed } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/registrations/:ref/resend ─────────────────────────────── */
router.post('/registrations/:ref/resend', requireRole('admin'), async (req, res, next) => {
  try {
    const doc = await Registration.findOne({ ref: req.params.ref, edition: registry.EDITION });
    if (!doc) return next(registry.appError('NOT_FOUND', 404, 'Registration not found.'));
    const board = registry.get()?.govs?.[doc.gov]?.board || [];
    const rank = board.findIndex(r => r.ref === doc.ref) + 1;

    const r = await mailer.sendConfirmation({
      to: doc.email, lang: doc.lang, school: doc.school,
      gov: doc.gov, ref: doc.ref, registeredAt: doc.registeredAt, rank
    });
    doc.mail.confirmationSentAt = new Date();
    doc.mail.confirmationError = r.dryRun ? 'DRY_RUN' : null;
    doc.mail.attempts += 1;
    await doc.save();
    res.json({ ok: true, data: { ref: doc.ref, dryRun: Boolean(r.dryRun) } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/lock ──────────────────────────────────────────────────── */
router.post('/lock', requireRole('admin'), sanitize, async (req, res, next) => {
  try {
    const snap = await registry.setLock(Boolean(req.body?.locked), req.admin.u);
    res.json({ ok: true, data: { locked: snap.lockedManually, taken: snap.taken } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/reconcile ─────────────────────────────────────────────── */
router.post('/reconcile', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await registry.reconcile();
    await registry.refreshAndBroadcast();
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});


/* ── GET /api/admin/waitlist ──────────────────────────────────────────────── */
router.get('/waitlist', async (req, res, next) => {
  try {
    const q = { edition: registry.EDITION };
    if (req.query.status) q.status = String(req.query.status);
    if (req.query.gov) q.gov = String(req.query.gov);
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const skip = Math.max(Number(req.query.skip) || 0, 0);

    const [items, total] = await Promise.all([
      Waitlist.find(q).sort({ joinedAt: 1, position: 1 }).skip(skip).limit(limit).lean(),
      Waitlist.countDocuments(q)
    ]);
    res.json({ ok: true, data: { items: items.map((r, i) => ({ ...r, queue: skip + i + 1 })), total, limit, skip } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/waitlist/:ref/invite ──────────────────────────────────
   Called when a pending registration expires and a place opens up.          */
router.post('/waitlist/:ref/invite', requireRole('admin'), sanitize, async (req, res, next) => {
  try {
    const { doc, changed } = await waitlistSvc.invite(
      req.params.ref, req.admin.u, String(req.body?.note || '').slice(0, 300));
    res.json({ ok: true, data: { ref: doc.ref, status: doc.status, changed } });
  } catch (err) { next(err); }
});

/* ── POST /api/admin/waitlist/:ref/status ─────────────────────────────────── */
router.post('/waitlist/:ref/status', requireRole('admin'), sanitize, async (req, res, next) => {
  try {
    const allowed = ['waiting', 'invited', 'converted', 'withdrawn'];
    const status = allowed.includes(req.body?.status) ? req.body.status : 'waiting';
    const { doc } = await waitlistSvc.setStatus(
      req.params.ref, status, req.admin.u, String(req.body?.note || '').slice(0, 300));
    res.json({ ok: true, data: { ref: doc.ref, status: doc.status } });
  } catch (err) { next(err); }
});

/* ── GET /api/admin/waitlist.csv ──────────────────────────────────────────── */
router.get('/waitlist.csv', async (req, res, next) => {
  try {
    const rows = await Waitlist.find({ edition: registry.EDITION })
      .sort({ joinedAt: 1, position: 1 }).lean();
    const cell = v => { const s = v == null ? '' : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['ref','file','statut','gouvernorat','ecole','directeur','telephone','email','langue','inscrit_le','invite_le','note'];
    const lines = [head.join(';')];
    rows.forEach((r, i) => lines.push([
      r.ref, i + 1, r.status, config.GOVS[r.gov].fr, r.school, r.director,
      `+216${r.phone}`, r.email, r.lang,
      new Date(r.joinedAt).toISOString(),
      r.invitedAt ? new Date(r.invitedAt).toISOString() : '', r.note || ''
    ].map(cell).join(';')));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="fiestadream-waitlist-${registry.EDITION}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) { next(err); }
});

/* ── GET /api/admin/export.csv ─────────────────────────────────────────────── */
router.get('/export.csv', async (req, res, next) => {
  try {
    const rows = await Registration.find({ edition: registry.EDITION })
      .sort({ registeredAt: 1, slot: 1 }).lean();
    const cell = v => {
      const s = v == null ? '' : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['ref','slot','statut','gouvernorat','jour','pass','ecole','directeur',
                  'telephone','email','langue','carnets','places','inscrit_le',
                  'approuve_le','approuve_par','ref_acompte'];
    const lines = [head.join(';')];
    for (const r of rows) {
      const g = config.GOVS[r.gov];
      lines.push([
        r.ref, r.slot, r.status, g.fr, g.dFr, g.pFr, r.school, r.director,
        `+216${r.phone}`, r.email, r.lang, r.booklets, r.seats,
        new Date(r.registeredAt).toISOString(),
        r.approvedAt ? new Date(r.approvedAt).toISOString() : '',
        r.approvedBy || '', r.depositRef || ''
      ].map(cell).join(';'));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="fiestadream-${registry.EDITION}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));   // BOM so Excel reads the Arabic
  } catch (err) { next(err); }
});

module.exports = router;
