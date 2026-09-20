#!/usr/bin/env node
'use strict';
/* ============================================================================
 * stress-test.js — run this against a REAL MongoDB before go-live.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017/bellaqueen_stress \
 *   node scripts/stress-test.js
 *
 * It fires 400 concurrent registrations at a 150 cap and asserts the
 * invariants the whole platform rests on. Point it at a THROWAWAY database —
 * it wipes the edition first.
 * ========================================================================== */

const db = require('../src/db');
const { config } = require('../src/config');

if (!/stress|test/i.test(config.mongoUri)) {
  console.error('Refusing to run: MONGODB_URI must contain "stress" or "test".');
  console.error('   got:', config.mongoUri);
  process.exit(1);
}

(async () => {
  await db.connect();
  const registry = require('../src/services/registry');
  const Registration = require('../src/models/Registration');
  const Counter = require('../src/models/Counter');

  await Registration.deleteMany({ edition: config.edition.id });
  await Counter.deleteOne({ _id: config.edition.id });
  await Registration.syncIndexes();
  await registry.init();

  const GOVS = config.GOV_KEYS;
  const CAP = config.edition.maxSchools;
  const mk = i => ({
    school: `Ecole Stress ${i}`, gov: GOVS[i % 4],
    director: `Directeur ${i}`, phone: '20000000',
    email: `stress${i}@ecole.tn`, lang: i % 3 === 0 ? 'ar' : 'fr', booklets: 1
  });

  let pass = true;
  const check = (label, cond) => {
    console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`);
    if (!cond) pass = false;
  };

  console.log(`\n=== 1. ${CAP * 2 + 100} concurrent registrations against a ${CAP} cap ===`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CAP * 2 + 100 }, (_, i) => registry.register(mk(i)))
  );
  const ok = results.filter(r => r.status === 'fulfilled');
  const codes = {};
  for (const r of results) if (r.status === 'rejected') codes[r.reason.code] = (codes[r.reason.code] || 0) + 1;

  console.log(`  accepted : ${ok.length}   rejected :`, codes);
  console.log(`  elapsed  : ${Date.now() - t0}ms`);

  const live = await Registration.countDocuments({ edition: config.edition.id, status: { $in: registry.LIVE } });
  const counter = await Counter.findById(config.edition.id).lean();

  check(`exactly ${CAP} accepted — no oversell`, ok.length === CAP);
  check(`exactly ${CAP} live rows in mongo`, live === CAP);
  check('counter.schoolsTaken matches rows', counter.schoolsTaken === live);
  check('no day exceeded its seat quota',
        GOVS.every(g => counter.seats[g] <= config.edition.maxSeatsPerDay));

  console.log('\n=== 2. references and slot numbers are unique ===');
  const all = await Registration.find({ edition: config.edition.id }).select('ref slot gov school registeredAt').lean();
  check('unique refs',  new Set(all.map(r => r.ref)).size === all.length);
  check('unique slots', new Set(all.map(r => r.slot)).size === all.length);

  console.log('\n=== 3. a duplicate school cannot burn a slot ===');
  const victim = all[0];
  await registry.release(victim.ref, 'cancelled', 'stress: make room');
  const takenBefore = (await Counter.findById(config.edition.id).lean()).schoolsTaken;
  let dupCode = null;
  try { await registry.register(mk(1)); } catch (e) { dupCode = e.code; }
  const takenAfter = (await Counter.findById(config.edition.id).lean()).schoolsTaken;
  check('duplicate rejected with DUPLICATE', dupCode === 'DUPLICATE');
  check('slot count unchanged after rejection', takenAfter === takenBefore);

  console.log('\n=== 4. release frees the slot and re-ranks ===');
  const snap = registry.get();
  check('released school left its board',
        !snap.govs[victim.gov].board.some(r => r.ref === victim.ref));
  check('one place is free again', snap.left === 1);

  console.log('\n=== 5. ranking is chronological and contiguous ===');
  for (const g of GOVS) {
    const b = snap.govs[g].board;
    const ordered = b.every((r, i) => i === 0 || new Date(r.registeredAt) >= new Date(b[i-1].registeredAt));
    check(`${g}: chronological and ranks 1..n`, ordered && b.every((r, i) => r.rank === i + 1));
  }

  console.log('\n=== 6. reconcile repairs counter drift ===');
  await Counter.updateOne({ _id: config.edition.id }, { $inc: { schoolsTaken: 7 } });
  const rec = await registry.reconcile();
  const fixed = await Counter.findById(config.edition.id).lean();
  check('drift of 7 detected', rec.drift === 7);
  check('counter repaired to real row count', fixed.schoolsTaken === CAP - 1);

  console.log('\n=== 7. the public snapshot leaks no PII ===');
  await registry.rebuild();
  const json = JSON.stringify(registry.get());
  check('no e-mail addresses',  !json.includes('@ecole.tn'));
  check('no phone numbers',     !json.includes('20000000'));
  check('no director names',    !json.includes('Directeur'));

  console.log(`\n${pass ? '\x1b[32m*** ALL CHECKS PASSED ***\x1b[0m' : '\x1b[31m*** SOME CHECKS FAILED ***\x1b[0m'}\n`);
  await db.disconnect();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
