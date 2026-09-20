'use strict';
const { mongoose } = require('../db');
const { config } = require('../config');
const { schoolKeyOf } = require('./Registration');

/**
 * 300 schools are invited for 150 places. By design, half of them arrive to a
 * closed door — and those are precisely the contacts worth keeping, both for
 * desistements in this edition and for the second one.
 *
 * Deliberately NOT a Registration with a different status: a waitlist entry
 * holds no slot and no seats, so letting it anywhere near the Counter would be
 * a way to corrupt occupancy. Separate collection, separate lifecycle.
 */
const WaitlistSchema = new mongoose.Schema({
  ref:       { type: String, required: true, unique: true },   // WL-2026-000001
  position:  { type: Number, required: true },                 // monotonic, never reused
  edition:   { type: String, required: true, index: true },

  school:    { type: String, required: true, trim: true, maxlength: 160 },
  schoolKey: { type: String, required: true },
  gov:       { type: String, required: true, enum: config.GOV_KEYS, index: true },

  director:  { type: String, required: true, trim: true, maxlength: 120 },
  phone:     { type: String, required: true, match: /^[2459]\d{7}$/ },
  email:     { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
  lang:      { type: String, required: true, enum: ['fr','ar'], default: 'fr' },

  status: { type: String, required: true, default: 'waiting',
            enum: ['waiting','invited','converted','withdrawn'], index: true },

  joinedAt:  { type: Date, required: true },      // server-stamped, decides order
  invitedAt: { type: Date, default: null },
  invitedBy: { type: String, default: null },
  note:      { type: String, default: null, maxlength: 300 },

  mail: {
    sentAt:   { type: Date, default: null },
    error:    { type: String, default: null },
    attempts: { type: Number, default: 0 }
  },
  meta: { ip: { type: String, default: null }, userAgent: { type: String, default: null } }
}, { timestamps: true, versionKey: false });

/* One live entry per school. Withdrawn rows keep their history without
   blocking a later re-join. */
WaitlistSchema.index({ edition: 1, schoolKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['waiting','invited'] } } });
WaitlistSchema.index({ edition: 1, joinedAt: 1, position: 1 });

WaitlistSchema.statics.schoolKeyOf = schoolKeyOf;

module.exports = mongoose.model('Waitlist', WaitlistSchema);
