#!/usr/bin/env node
'use strict';
/* Usage: node scripts/create-admin.js <username> <password> ["Full Name"] [admin|viewer] */
const db = require('../src/db');
const AdminUser = require('../src/models/AdminUser');

(async () => {
  const [username, password, name = '', role = 'admin'] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node scripts/create-admin.js <username> <password> ["Full Name"] [admin|viewer]');
    process.exit(1);
  }
  if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }

  await db.connect();
  const passwordHash = await AdminUser.hash(password);
  const doc = await AdminUser.findOneAndUpdate(
    { username: username.toLowerCase() },
    { $set: { passwordHash, name, role, active: true } },
    { upsert: true, new: true }
  );
  console.log(`Admin ready: ${doc.username} (${doc.role})`);
  await db.disconnect();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
