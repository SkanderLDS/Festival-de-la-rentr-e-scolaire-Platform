'use strict';
/* ============================================================================
 * registry.js — the heart of the platform.
 *
 * Two jobs:
 *   1. Claim a slot ATOMICALLY. A single compound-filter findOneAndUpdate
 *      checks the global cap AND the day's seat quota AND increments both, in
 *      one indivisible Mongo operation. There is no read-then-write window, so
 *      slot 150 cannot be sold twice no matter how many requests arrive at the
 *      same millisecond.
 *   2. Hold the whole public snapshot in memory. The dataset is capped at 150
 *      rows, so every read (counter, passes, leaderboard) is served from RAM
 *      and Mongo never sees the 10 000 concurrent readers.
 * ========================================================================== */

const Counter = require('../models/Counter');
const Registration = require('../models/Registration');
const Waitlist = require('../models/Waitlist');
const { config } = require('../config');

const EDITION = config.edition.id;
const LIVE = ['pending', 'approved'];

let snapshot = null;                 // the cached public view
const subscribers = new Set();       // realtime broadcasters

/* ─────────────────────────────────────────────────────── snapshot ────── */

async function rebuild() {
  const [counter, rows, waiting] = await Promise.all([
    Counter.findById(EDITION).lean(),
    Registration.find({ edition: EDITION, status: { $in: LIVE } })
      .sort({ registeredAt: 1, slot: 1 })
      .select('ref school gov registeredAt status seats slot')
      .lean(),
    Waitlist.countDocuments({ edition: EDITION, status: { $in: ['waiting','invited'] } })
  ]);

  const govs = {};
  for (const key of config.GOV_KEYS) {
    const g = config.GOVS[key];
    const list = rows.filter(r => r.gov === key);
    const seatsUsed = list.reduce((a, r) => a + r.seats, 0);
    govs[key] = {
      key,
      fr: g.fr, ar: g.ar,
      dayFr: g.dFr, dayAr: g.dAr,
      passFr: g.pFr, passAr: g.pAr,
      hex: g.hex,
      count: list.length,
      seatsUsed,
      seatsFree: Math.max(0, config.edition.maxSeatsPerDay - seatsUsed),
      leader: list[0]
        ? { school: list[0].school, registeredAt: list[0].registeredAt.toISOString() }
        : null,
      board: list.map((r, i) => ({
        rank: i + 1,
        ref: r.ref,
        school: r.school,
        registeredAt: r.registeredAt.toISOString(),
        status: r.status
      }))
    };
  }

  const taken = rows.length;
  snapshot = {
    edition: EDITION,
    maxSchools: config.edition.maxSchools,
    maxSeatsPerDay: config.edition.maxSeatsPerDay,
    seatsPerBooklet: config.edition.seatsPerBooklet,
    taken,
    left: Math.max(0, config.edition.maxSchools - taken),
    locked: Boolean(counter?.locked) || taken >= config.edition.maxSchools,
    lockedManually: Boolean(counter?.locked),
    opensAt: config.edition.opensAt ? config.edition.opensAt.toISOString() : null,
    open: isOpenNow() && !(Boolean(counter?.locked) || taken >= config.edition.maxSchools),
    waiting,
    govs,
    updatedAt: new Date().toISOString()
  };
  return snapshot;
}

function get() { return snapshot; }

function isOpenNow() {
  const at = config.edition.opensAt;
  return !at || Date.now() >= at.getTime();
}

function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
async function refreshAndBroadcast() {
  const s = await rebuild();
  for (const fn of subscribers) { try { fn(s); } catch (e) { console.error('[rt]', e.message); } }
  return s;
}

/* ─────────────────────────────────────────────── atomic allocation ────── */

/**
 * Claim one slot + `seats` places on that gouvernorat's day.
 * Returns { slot, ref } or throws an AppError with a stable code.
 */
async function claimSlot(gov, seats) {
  const seatField = `seats.${gov}`;
  const counter = await Counter.findOneAndUpdate(
    {
      _id: EDITION,
      locked: false,
      schoolsTaken: { $lt: config.edition.maxSchools },
      [seatField]: { $lte: config.edition.maxSeatsPerDay - seats }
    },
    {
      $inc: { schoolsTaken: 1, seqCounter: 1, [seatField]: seats },
      $set: { updatedAt: new Date() }
    },
    { new: true, lean: true }
  );

  if (counter) {
    return {
      slot: counter.seqCounter,
      ref: `BQF-${EDITION}-${String(counter.seqCounter).padStart(6, '0')}`
    };
  }

  /* Rejected — read once to say WHY, so the UI can show the right message. */
  const now = await Counter.findById(EDITION).lean();
  if (!now) throw appError('EDITION_MISSING', 500, 'Edition counter not initialised.');
  if (now.locked) throw appError('LOCKED', 409, 'Registration is closed.');
  if (now.schoolsTaken >= now.maxSchools) throw appError('FULL', 409, 'All 150 places are taken.');
  throw appError('DAY_FULL', 409, `No seats left for ${gov}.`);
}

/** Give a slot back (duplicate insert, expiry sweep, admin rejection).
 *  seqCounter is deliberately NOT decremented — references are never reused. */
async function releaseSlot(gov, seats) {
  await Counter.updateOne(
    { _id: EDITION },
    { $inc: { schoolsTaken: -1, [`seats.${gov}`]: -seats }, $set: { updatedAt: new Date() } }
  );
}

/* ──────────────────────────────────────────────────────── register ────── */

async function register(input, meta = {}) {
  if (!isOpenNow()) {
    throw appError('NOT_OPEN', 409, 'Registration has not opened yet.');
  }

  const seats = config.edition.seatsPerBooklet * (input.booklets || 1);
  const schoolKey = Registration.schoolKeyOf(input.school);

  /* Cheap pre-check off the in-memory snapshot. The unique index below is the
     real guarantee — this just avoids burning a slot on an obvious repeat. */
  const already = Object.values(snapshot?.govs || {})
    .some(g => g.board.some(r => Registration.schoolKeyOf(r.school) === schoolKey));
  if (already) throw appError('DUPLICATE', 409, 'This school is already registered.');

  const { slot, ref } = await claimSlot(input.gov, seats);

  try {
    const doc = await Registration.create({
      ref, slot, edition: EDITION,
      school: input.school.trim(),
      schoolKey,
      gov: input.gov,
      director: input.director.trim(),
      phone: input.phone,
      email: input.email.toLowerCase().trim(),
      lang: input.lang === 'ar' ? 'ar' : 'fr',
      booklets: input.booklets || 1,
      seats,
      status: 'pending',
      registeredAt: new Date(),          // ← the authoritative clock
      charterAccepted: true,
      meta: { ip: meta.ip || null, userAgent: meta.userAgent || null }
    });

    const s = await refreshAndBroadcast();
    const rank = s.govs[doc.gov].board.findIndex(r => r.ref === doc.ref) + 1;
    return { doc, rank, snapshot: s };

  } catch (err) {
    /* Insert failed after the slot was claimed — hand it straight back. */
    await releaseSlot(input.gov, seats).catch(() => {});
    if (err.code === 11000) throw appError('DUPLICATE', 409, 'This school is already registered.');
    throw err;
  }
}

/* ─────────────────────────────────────────────── status changes ───────── */

async function approve(ref, adminName, depositRef) {
  const doc = await Registration.findOne({ ref, edition: EDITION });
  if (!doc) throw appError('NOT_FOUND', 404, 'Registration not found.');
  if (doc.status === 'approved') return { doc, changed: false };
  if (!LIVE.includes(doc.status)) throw appError('NOT_LIVE', 409, `Cannot approve a ${doc.status} registration.`);

  doc.status = 'approved';
  doc.approvedAt = new Date();
  doc.approvedBy = adminName;
  if (depositRef) doc.depositRef = depositRef;
  await doc.save();

  await refreshAndBroadcast();

  /* Spec section 5: the receipt and the Charte go out automatically on
     approval. Fired after the state change and deliberately not awaited —
     a slow SMTP handshake must never make an admin think the approval
     failed and click twice. */
  const mailer = require('./mailer');
  mailer.sendApproval({
    to: doc.email, lang: doc.lang, school: doc.school, gov: doc.gov,
    ref: doc.ref, seats: doc.seats, approvedAt: doc.approvedAt,
    depositRef: doc.depositRef
  })
    .then(r => Registration.updateOne({ _id: doc._id }, {
      $set: { 'mail.approvalSentAt': new Date(),
              'mail.approvalError': r.dryRun ? 'DRY_RUN' : null }
    }).exec())
    .catch(err => {
      console.error('[mail:approval]', doc.ref, err.message);
      Registration.updateOne({ _id: doc._id }, {
        $set: { 'mail.approvalError': err.message.slice(0, 300) }
      }).exec().catch(() => {});
    });

  return { doc, changed: true };
}

/** Release a live registration (admin rejection or the 72 h sweep).
 *  Frees the slot and the day seats; the row is kept for the audit trail. */
async function release(ref, status, note) {
  const doc = await Registration.findOne({ ref, edition: EDITION });
  if (!doc) throw appError('NOT_FOUND', 404, 'Registration not found.');
  if (!LIVE.includes(doc.status)) return { doc, changed: false };

  doc.status = status;                 // 'expired' | 'cancelled'
  doc.releasedAt = new Date();
  doc.releaseNote = note || null;
  await doc.save();
  await releaseSlot(doc.gov, doc.seats);

  await refreshAndBroadcast();
  return { doc, changed: true };
}

async function setLock(locked, adminName) {
  await Counter.updateOne({ _id: EDITION }, {
    $set: { locked, lockedAt: locked ? new Date() : null,
            lockedBy: locked ? adminName : null, updatedAt: new Date() }
  });
  return refreshAndBroadcast();
}

/* Recompute schoolsTaken / seats from the registrations themselves.
   Safety net for a crash between claimSlot and the insert. */
async function reconcile() {
  const rows = await Registration.find({ edition: EDITION, status: { $in: LIVE } })
    .select('gov seats').lean();
  const seats = { tunis: 0, ariana: 0, manouba: 0, benarous: 0 };
  for (const r of rows) seats[r.gov] += r.seats;

  const before = await Counter.findById(EDITION).lean();
  await Counter.updateOne({ _id: EDITION },
    { $set: { schoolsTaken: rows.length, seats, updatedAt: new Date() } });

  const drift = before ? before.schoolsTaken - rows.length : 0;
  if (drift !== 0) console.warn(`[registry] reconciled counter drift: ${drift}`);
  return { schools: rows.length, seats, drift };
}

/* ──────────────────────────────────────────────────────── helpers ─────── */

function appError(code, status, message) {
  const e = new Error(message);
  e.code = code; e.status = status; e.expose = true;
  return e;
}

async function init() {
  await Counter.ensure();
  await reconcile();
  await rebuild();
  console.log(`[registry] edition ${EDITION} ready — ${snapshot.taken}/${snapshot.maxSchools} taken`);
  return snapshot;
}

module.exports = {
  init, get, rebuild, refreshAndBroadcast, subscribe,
  register, approve, release, setLock, reconcile, isOpenNow, appError, EDITION, LIVE
};
