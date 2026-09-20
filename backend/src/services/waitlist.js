'use strict';
/* ============================================================================
 * waitlist.js — joining, ordering and promoting the queue behind the 150.
 * ========================================================================== */

const Waitlist = require('../models/Waitlist');
const Registration = require('../models/Registration');
const Counter = require('../models/Counter');
const registry = require('./registry');
const { config } = require('../config');

const EDITION = config.edition.id;
const LIVE = ['waiting', 'invited'];

/** Position numbers come off the same monotonic seqCounter the registrations
 *  use, so a WL ref can never collide with a BQF ref. */
async function nextPosition() {
  const c = await Counter.findOneAndUpdate(
    { _id: EDITION },
    { $inc: { seqCounter: 1 }, $set: { updatedAt: new Date() } },
    { new: true, lean: true }
  );
  if (!c) throw registry.appError('EDITION_MISSING', 500, 'Edition counter not initialised.');
  return c.seqCounter;
}

/* 300 schools are invited. A queue an order of magnitude larger than that is
   not demand, it is abuse — cap it so a script cannot fill the collection. */
const MAX_QUEUE = 1000;

async function join(input, meta = {}) {
  const live = await count();
  if (live >= MAX_QUEUE) {
    throw registry.appError('QUEUE_FULL', 409, 'The waiting list is closed.');
  }
  const schoolKey = Waitlist.schoolKeyOf(input.school);

  /* A school that already holds a place must not also sit in the queue —
     it would inflate the list and mislead the organisers. */
  const registered = await Registration.findOne({
    edition: EDITION, schoolKey, status: { $in: registry.LIVE }
  }).select('ref').lean();
  if (registered) {
    throw registry.appError('ALREADY_REGISTERED', 409,
      'This school already holds a confirmed place.');
  }

  const position = await nextPosition();
  const ref = `WL-${EDITION}-${String(position).padStart(6, '0')}`;

  try {
    const doc = await Waitlist.create({
      ref, position, edition: EDITION,
      school: input.school.trim(), schoolKey, gov: input.gov,
      director: input.director.trim(), phone: input.phone,
      email: input.email.toLowerCase().trim(),
      lang: input.lang === 'ar' ? 'ar' : 'fr',
      status: 'waiting', joinedAt: new Date(),
      meta: { ip: meta.ip || null, userAgent: meta.userAgent || null }
    });
    const rank = await rankOf(doc);
    await registry.refreshAndBroadcast();
    return { doc, rank };
  } catch (err) {
    if (err.code === 11000) {
      throw registry.appError('DUPLICATE', 409, 'This school is already on the waiting list.');
    }
    throw err;
  }
}

/** Place in the queue: 1-based, counting only entries still waiting. */
async function rankOf(doc) {
  const ahead = await Waitlist.countDocuments({
    edition: EDITION, status: 'waiting',
    $or: [
      { joinedAt: { $lt: doc.joinedAt } },
      { joinedAt: doc.joinedAt, position: { $lt: doc.position } }
    ]
  });
  return ahead + 1;
}

async function count() {
  return Waitlist.countDocuments({ edition: EDITION, status: { $in: LIVE } });
}

/** Mark an entry as invited — used when a pending registration expires and a
 *  place opens up. Does NOT create the registration; the school still has to
 *  register itself, which keeps the timestamp honest. */
async function invite(ref, adminName, note) {
  const doc = await Waitlist.findOne({ ref, edition: EDITION });
  if (!doc) throw registry.appError('NOT_FOUND', 404, 'Waiting-list entry not found.');
  if (doc.status !== 'waiting') return { doc, changed: false };
  doc.status = 'invited';
  doc.invitedAt = new Date();
  doc.invitedBy = adminName;
  if (note) doc.note = note;
  await doc.save();
  await registry.refreshAndBroadcast();
  return { doc, changed: true };
}

async function setStatus(ref, status, adminName, note) {
  const doc = await Waitlist.findOne({ ref, edition: EDITION });
  if (!doc) throw registry.appError('NOT_FOUND', 404, 'Waiting-list entry not found.');
  doc.status = status;
  if (note) doc.note = note;
  if (status === 'invited') { doc.invitedAt = new Date(); doc.invitedBy = adminName; }
  await doc.save();
  await registry.refreshAndBroadcast();
  return { doc, changed: true };
}

module.exports = { join, rankOf, count, invite, setStatus, LIVE, MAX_QUEUE };
