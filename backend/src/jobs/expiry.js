'use strict';
/* Pending registrations hold a slot for PENDING_TTL_HOURS. After that the slot
   is released to the waiting list — otherwise one prank submission squats a
   place for the whole campaign and the public counter is a lie. */
const cron = require('node-cron');
const Registration = require('../models/Registration');
const registry = require('../services/registry');
const { config } = require('../config');

async function sweep() {
  const cutoff = new Date(Date.now() - config.edition.pendingTtlHours * 3600 * 1000);
  const stale = await Registration.find({
    edition: registry.EDITION, status: 'pending', registeredAt: { $lt: cutoff }
  }).select('ref').lean();

  if (!stale.length) return { released: 0 };

  let released = 0;
  for (const r of stale) {
    try {
      const { changed } = await registry.release(r.ref, 'expired',
        `Auto-released: no deposit within ${config.edition.pendingTtlHours}h.`);
      if (changed) released++;
    } catch (e) { console.error('[expiry]', r.ref, e.message); }
  }
  console.log(`[expiry] released ${released} stale pending registration(s)`);
  return { released };
}

function start() {
  /* Every 15 minutes. Frequent enough that a freed slot is usable the same
     morning, cheap enough to be invisible. */
  const task = cron.schedule('*/15 * * * *', () => {
    sweep().catch(e => console.error('[expiry] sweep failed:', e.message));
  });
  console.log(`[expiry] job started — TTL ${config.edition.pendingTtlHours}h`);
  return task;
}

module.exports = { start, sweep };
