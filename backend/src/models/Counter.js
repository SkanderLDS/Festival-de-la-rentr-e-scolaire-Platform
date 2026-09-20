'use strict';
const { mongoose } = require('../db');
const { config } = require('../config');

/**
 * ONE document per edition. It is the single source of truth for occupancy,
 * and the only thing the registration write path contends on.
 *
 *   schoolsTaken  live occupancy — goes UP on claim, DOWN on release
 *   seqCounter    monotonic, NEVER decremented — issues slot numbers and refs
 *   seats.<gov>   live seats booked for that gouvernorat's day
 *
 * Two counters, not one, on purpose: if a pending registration expires we free
 * its slot (schoolsTaken--) but we must never reissue its reference number.
 */
const CounterSchema = new mongoose.Schema({
  _id:            { type: String },                 // e.g. "2026"
  maxSchools:     { type: Number, required: true },
  maxSeatsPerDay: { type: Number, required: true },
  schoolsTaken:   { type: Number, default: 0, min: 0 },
  seqCounter:     { type: Number, default: 0, min: 0 },
  seats: {
    tunis:    { type: Number, default: 0, min: 0 },
    ariana:   { type: Number, default: 0, min: 0 },
    manouba:  { type: Number, default: 0, min: 0 },
    benarous: { type: Number, default: 0, min: 0 }
  },
  locked:     { type: Boolean, default: false },    // manual kill switch
  lockedAt:   { type: Date, default: null },
  lockedBy:   { type: String, default: null },
  updatedAt:  { type: Date, default: Date.now }
}, { versionKey: false, _id: false });

CounterSchema.statics.ensure = async function () {
  const { id, maxSchools, maxSeatsPerDay } = config.edition;
  await this.updateOne(
    { _id: id },
    { $setOnInsert: {
        maxSchools, maxSeatsPerDay,
        schoolsTaken: 0, seqCounter: 0,
        seats: { tunis: 0, ariana: 0, manouba: 0, benarous: 0 },
        locked: false, updatedAt: new Date()
      } },
    { upsert: true }
  );
  /* Keep the caps in sync with .env without wiping live counts. */
  await this.updateOne({ _id: id }, { $set: { maxSchools, maxSeatsPerDay } });
  return this.findById(id).lean();
};

module.exports = mongoose.model('Counter', CounterSchema);
