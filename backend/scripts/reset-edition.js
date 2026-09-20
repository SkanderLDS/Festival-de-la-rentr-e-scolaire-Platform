#!/usr/bin/env node
'use strict';
/* DESTRUCTIVE. Wipes every registration for the edition and zeroes the counter.
   Use before go-live to clear test data. Requires --yes to run. */
const db = require('../src/db');
const Counter = require('../src/models/Counter');
const Registration = require('../src/models/Registration');
const { config } = require('../src/config');

(async () => {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to wipe without --yes');
    console.error(`  node scripts/reset-edition.js --yes   # edition ${config.edition.id}`);
    process.exit(1);
  }
  await db.connect();
  const { deletedCount } = await Registration.deleteMany({ edition: config.edition.id });
  await Counter.updateOne({ _id: config.edition.id }, {
    $set: { schoolsTaken: 0, seqCounter: 0, locked: false, lockedAt: null, lockedBy: null,
            seats: { tunis: 0, ariana: 0, manouba: 0, benarous: 0 }, updatedAt: new Date() }
  }, { upsert: true });
  console.log(`Deleted ${deletedCount} registration(s). Counter reset for edition ${config.edition.id}.`);
  await db.disconnect();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
