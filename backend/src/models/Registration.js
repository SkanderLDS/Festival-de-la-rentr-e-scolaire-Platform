'use strict';
const { mongoose } = require('../db');
const { config } = require('../config');

/** Normalised key used for the duplicate-school unique index.
 *  Strips diacritics, Arabic tatweel, punctuation and case so that
 *  "École Primaire Privée  Ennour" and "ecole primaire privee ennour"
 *  cannot both take a slot. */
function schoolKeyOf(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // latin diacritics
    .replace(/\u0640/g, '')            // arabic tatweel
    .replace(/[\u064B-\u065F]/g, '')   // arabic harakat
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const RegistrationSchema = new mongoose.Schema({
  ref:        { type: String, required: true, unique: true },   // BQF-2026-000001
  slot:       { type: Number, required: true, unique: true },   // from seqCounter
  edition:    { type: String, required: true, index: true },

  school:     { type: String, required: true, trim: true, maxlength: 160 },
  schoolKey:  { type: String, required: true },
  gov:        { type: String, required: true, enum: config.GOV_KEYS, index: true },

  director:   { type: String, required: true, trim: true, maxlength: 120 },
  phone:      { type: String, required: true, match: /^[2459]\d{7}$/ },
  email:      { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
  lang:       { type: String, required: true, enum: ['fr', 'ar'], default: 'fr' },

  booklets:   { type: Number, default: 1, min: 1 },
  seats:      { type: Number, required: true, min: 1 },

  status: { type: String, required: true, default: 'pending',
            enum: ['pending', 'approved', 'expired', 'cancelled'], index: true },

  /* Set by the SERVER on arrival. This is the only clock that decides rank. */
  registeredAt: { type: Date, required: true },

  approvedAt:  { type: Date, default: null },
  approvedBy:  { type: String, default: null },
  depositRef:  { type: String, default: null },   // cheque no. / virement ref
  releasedAt:  { type: Date, default: null },
  releaseNote: { type: String, default: null },

  charterAccepted: { type: Boolean, required: true },

  mail: {
    confirmationSentAt: { type: Date, default: null },
    confirmationError:  { type: String, default: null },
    approvalSentAt:     { type: Date, default: null },
    approvalError:      { type: String, default: null },
    attempts:           { type: Number, default: 0 }
  },

  meta: {
    ip:        { type: String, default: null },
    userAgent: { type: String, default: null }
  }
}, { timestamps: true, versionKey: false });

/* Only ONE live registration per school. Expired/cancelled rows keep their
   history but stop blocking a re-registration (partial unique index). */
RegistrationSchema.index(
  { edition: 1, schoolKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } }
);

/* The leaderboard sort: arrival time, then slot as the documented tiebreak. */
RegistrationSchema.index({ edition: 1, gov: 1, registeredAt: 1, slot: 1 });
/* The expiry sweep. */
RegistrationSchema.index({ status: 1, registeredAt: 1 });

RegistrationSchema.statics.schoolKeyOf = schoolKeyOf;

/** Public projection — NEVER leaks director, phone, e-mail or IP. */
RegistrationSchema.methods.toPublic = function (rank) {
  return {
    rank,
    ref: this.ref,
    school: this.school,
    gov: this.gov,
    registeredAt: this.registeredAt.toISOString(),
    status: this.status
  };
};

module.exports = mongoose.model('Registration', RegistrationSchema);
module.exports.schoolKeyOf = schoolKeyOf;
