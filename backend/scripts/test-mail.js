#!/usr/bin/env node
'use strict';
/* ============================================================================
 * test-mail.js — send one REAL copy of every e-mail the platform produces,
 * through the SMTP account configured in .env.
 *
 *   node scripts/test-mail.js                     # to the festival inbox itself
 *   node scripts/test-mail.js someone@example.com # to any address you own
 *
 * Run it twice: once to the Gmail account, once to a NON-Gmail address you
 * own (Outlook is ideal). Gmail-to-Gmail almost always succeeds, so only the
 * second run tells you whether schools on other providers will receive mail.
 *
 * Cost: 5 recipients out of Gmail's ~500 per rolling 24 hours.
 * Touches no database — safe to run any time, including in production.
 * ========================================================================== */

const { config, mailWarnings } = require('../src/config');
const mailer = require('../src/services/mailer');

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`,
      Y = s => `\x1b[33m${s}\x1b[0m`, B = s => `\x1b[1m${s}\x1b[0m`;

/* Gmail's SMTP errors are terse. Each one maps to a single concrete fix. */
function explain(err) {
  const m = String(err && (err.response || err.message) || err);
  const code = err && (err.responseCode || err.code);

  if (/535|Username and Password not accepted|Invalid login|BadCredentials/i.test(m) || code === 'EAUTH')
    return 'Gmail refused the login.\n' +
      '  - SMTP_PASS must be an App Password, NOT the account\'s normal password.\n' +
      '  - 2-Step Verification must be ON for this account, or App Passwords do not exist.\n' +
      '  - Create a fresh one at myaccount.google.com/apppasswords and paste it again.\n' +
      '  - Check SMTP_USER is exactly the Gmail address the App Password belongs to.';
  if (/534|Application-specific password required/i.test(m))
    return 'Gmail wants an App Password. Turn on 2-Step Verification, then create one\n' +
      '  at myaccount.google.com/apppasswords and put it in SMTP_PASS.';
  if (/self[- ]signed|unable to verify|certificate|CERT_/i.test(m))
    return 'Something on this computer is intercepting the secure connection.\n' +
      '  This is almost always antivirus "SSL / e-mail scanning" (Avast, AVG, Kaspersky,\n' +
      '  ESET, Bitdefender). Turn off e-mail or HTTPS scanning for this test, or run the\n' +
      '  script on the VPS instead. Do NOT disable certificate checking in the code.';
  if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|ECONNRESET|Greeting never received|ENOTFOUND/i.test(m) ||
      ['ETIMEDOUT','ECONNREFUSED','ESOCKET','ECONNRESET','ENOTFOUND','ECONNECTION'].includes(code))
    return `Could not reach ${config.mail.host}:${config.mail.port}.\n` +
      '  Your network or firewall may block this port. Try, in .env:\n' +
      '      SMTP_PORT=587\n      SMTP_SECURE=false\n' +
      '  If it still fails, some ISPs block outgoing mail ports entirely — run it on the VPS.';
  if (/5\.4\.5|quota|sending limit|rate limit|too many/i.test(m))
    return 'Gmail\'s sending limit is reached. It resets on a rolling 24-hour window.\n' +
      '  Nothing is lost: registrations are saved regardless, and the admin panel can\n' +
      '  resend each confirmation once sending is allowed again.';
  if (/550|553|recipient|mailbox unavailable|No such user|EENVELOPE/i.test(m))
    return 'The receiving server rejected the address. Check its spelling.';
  return 'Unrecognised error — the raw message is above. Send it to me and I\'ll read it.';
}

(async () => {
  console.log(B('\n━━━ أمل الطفولة — mail test ━━━\n'));

  const m = config.mail;
  if (!m.user || !m.pass) {
    console.log(R('✗ SMTP_USER or SMTP_PASS is empty in backend/.env\n'));
    console.log('  Set at least:\n' +
      '    SMTP_HOST=smtp.gmail.com\n    SMTP_PORT=465\n    SMTP_SECURE=true\n' +
      '    SMTP_USER=amal.toufoula.festival@gmail.com\n    SMTP_PASS=<your App Password>\n');
    process.exit(1);
  }

  const to = (process.argv[2] || m.user).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    console.log(R(`✗ "${to}" is not a valid e-mail address.\n`)); process.exit(1);
  }

  console.log(`  account   : ${m.user}`);
  console.log(`  server    : ${m.host}:${m.port}  (${m.secure ? 'SSL' : 'STARTTLS'})`);
  console.log(`  from name : ${m.fromName}`);
  console.log(`  reply-to  : ${m.replyTo}`);
  console.log(`  sending to: ${B(to)}\n`);

  const warnings = mailWarnings();
  if (warnings.length) {
    warnings.forEach(w => console.log(Y('⚠ ' + w) + '\n'));
  }

  /* Step 1 — log in. Nothing is sent if this fails. */
  process.stdout.write('  1/2  Logging in to the SMTP server … ');
  try {
    /* mailer.verify() logs its own line; mute it so ours reads cleanly */
    const log = console.log; let ok;
    console.log = () => {};
    try { ok = await mailer.verify(); } finally { console.log = log; }
    if (!ok) throw new Error('mailer.verify() returned false (SMTP_USER not picked up)');
    console.log(G('OK'));
  } catch (e) {
    console.log(R('FAILED'));
    console.log('\n  ' + R(String(e.response || e.message)));
    console.log('\n  ' + explain(e).replace(/\n/g, '\n') + '\n');
    process.exit(1);
  }

  /* Step 2 — one real copy of every e-mail type, labelled as a test. */
  console.log('  2/2  Sending one of each e-mail type:\n');
  const now = new Date();
  const base = { to, gov: 'tunis', ref: 'BQF-2026-TEST01', rank: 1 };
  const frSchool = 'École Test — message d\'essai, ne pas répondre';
  const arSchool = 'مدرسة تجريبية — رسالة اختبار';

  const tests = [
    ['Confirmation d\'inscription (FR)', () => mailer.sendConfirmation({ ...base, lang: 'fr', school: frSchool, registeredAt: now })],
    ['Confirmation d\'inscription (AR)', () => mailer.sendConfirmation({ ...base, lang: 'ar', school: arSchool, registeredAt: now })],
    ['Liste d\'attente (FR)',             () => mailer.sendWaitlist({ ...base, lang: 'fr', school: frSchool, ref: 'WL-2026-TEST01', joinedAt: now, rank: 3 })],
    ['Reçu après avance (FR)',            () => mailer.sendApproval({ ...base, lang: 'fr', school: frSchool, seats: 50, approvedAt: now, depositRef: 'CHQ-TEST' })],
    ['Alerte organisateur',               () => {
        /* Force this one to the test address; in real use it goes to ORGANISER_EMAILS. */
        const saved = m.organisers; m.organisers = [to];
        return mailer.sendOrganiserAlert('registration', {
          school: frSchool, gov: 'tunis', director: 'Directeur Test', phone: '20000000',
          email: to, lang: 'fr', ref: 'BQF-2026-TEST01', rank: 1, at: now, taken: 1
        }).finally(() => { m.organisers = saved; });
    }]
  ];

  let sent = 0;
  for (const [label, fn] of tests) {
    process.stdout.write(`       ${label.padEnd(34)} `);
    try {
      const r = await fn();
      if (r && r.dryRun) { console.log(Y('DRY-RUN (not actually sent)')); continue; }
      if (r && r.skipped) { console.log(Y('skipped: ' + r.skipped)); continue; }
      console.log(G('sent'));
      sent++;
    } catch (e) {
      console.log(R('FAILED'));
      console.log('         ' + R(String(e.response || e.message)));
      console.log('         ' + explain(e).replace(/\n/g, '\n         '));
    }
  }

  console.log('\n' + (sent === tests.length
    ? G(B(`  ✓ All ${sent} e-mails handed to Gmail.`))
    : Y(B(`  ${sent} of ${tests.length} sent.`))));
  console.log(`
  Now open ${B(to)} and check:
    • all 5 arrived — look in Spam and Promotions too, not just the inbox
    • the Arabic one reads right-to-left and its letters are joined
    • the sender shows as "${m.fromName}"
    • pressing Reply on a confirmation addresses ${m.replyTo}

  If you sent to the Gmail account itself and the inbox looks empty, check
  "Sent" — Gmail sometimes files mail you send to yourself only there. Run it
  again to a non-Gmail address to see what a school actually receives.
`);
  process.exit(sent === tests.length ? 0 : 1);
})().catch(e => { console.error(R('\nUnexpected error:'), e); process.exit(1); });
