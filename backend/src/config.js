'use strict';
require('dotenv').config();

const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : String(v) === 'true' || String(v) === '1');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  /* No silent fallback. A missing MONGODB_URI used to quietly become
     127.0.0.1:27017 and surface later as ECONNREFUSED against a database
     nobody asked for — a stack trace that says nothing about the real
     problem, which is that .env was never loaded. */
  mongoUri: process.env.MONGODB_URI || '',

  edition: {
    id: process.env.EDITION_ID || '2026',
    maxSchools: int(process.env.MAX_SCHOOLS, 150),
    maxSeatsPerDay: int(process.env.MAX_SEATS_PER_DAY, 2000),
    seatsPerBooklet: int(process.env.SEATS_PER_BOOKLET, 50),
    pendingTtlHours: int(process.env.PENDING_TTL_HOURS, 72),
    opensAt: process.env.REGISTRATION_OPENS_AT
      ? new Date(process.env.REGISTRATION_OPENS_AT)
      : null,
    deposit: int(process.env.DEPOSIT_DT, 500),
    balance: int(process.env.BALANCE_DT, 500)
  },

  /* Absolute path to the signed Charte d'honneur PDF. Attached to the
     approval e-mail when present; skipped with a warning when not, so a
     missing document never blocks a confirmation. */
  charterPath: process.env.CHARTER_PDF_PATH || '',

  jwt: {
    secret: process.env.JWT_SECRET || '',
    ttl: process.env.JWT_TTL || '8h'
  },

  mail: {
    host: process.env.SMTP_HOST,
    port: int(process.env.SMTP_PORT, 465),
    secure: bool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER || '',
    /* Google shows App Passwords as four groups — "abcd efgh ijkl mnop" — and
       people paste them with the spaces. The spaces are display-only, never
       part of the credential, so strip them for Gmail. Other providers keep
       the password byte-for-byte, since a real password may contain spaces. */
    pass: /(^|\.)gmail\.com$/i.test(process.env.SMTP_HOST || '') || /@gmail\.com$/i.test(process.env.SMTP_USER || '')
      ? (process.env.SMTP_PASS || '').replace(/\s+/g, '')
      : (process.env.SMTP_PASS || ''),
    /* Defaults follow the account you log in with, never a domain that may
       not exist yet. Gmail can only send as its own address; a MAIL_FROM or
       MAIL_REPLY_TO pointing elsewhere makes replies bounce and puts a dead
       contact link in the footer of every e-mail. */
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    fromName: process.env.MAIL_FROM_NAME || 'أمل الطفولة',
    replyTo: process.env.MAIL_REPLY_TO || process.env.MAIL_FROM || process.env.SMTP_USER || '',
    phone: process.env.FESTIVAL_PHONE || '+216 —',
    /* Who gets told when a school registers. Comma-separated; leave blank to
       switch the alerts off entirely. These messages carry the director's
       name, phone and e-mail, so only put real organiser addresses here. */
    organisers: (process.env.ORGANISER_EMAILS || '')
      .split(',').map(x => x.trim()).filter(Boolean),
    alertOnWaitlist: bool(process.env.ALERT_ON_WAITLIST, true)
  }
};

/* The four governorates. The day, the colour and the Pass follow the
   gouvernorat — never chosen by the school. Ben Arous is JAUNE: the emoji in
   the brief is green but its own text says "Pass Jaune". */
config.GOVS = {
  tunis:    { key:'tunis',    fr:'Tunis',     ar:'تونس',    date:'2026-10-28',
              dFr:'Mercredi 28 octobre 2026', dAr:'الأربعاء 28 أكتوبر 2026',
              pFr:'Pass Rouge', pAr:'الجواز الأحمر', hex:'#D63A3A' },
  ariana:   { key:'ariana',   fr:'Ariana',    ar:'أريانة',  date:'2026-10-29',
              dFr:'Jeudi 29 octobre 2026',    dAr:'الخميس 29 أكتوبر 2026',
              pFr:'Pass Bleu',  pAr:'الجواز الأزرق', hex:'#2E6FD9' },
  manouba:  { key:'manouba',  fr:'Manouba',   ar:'منوبة',   date:'2026-10-30',
              dFr:'Vendredi 30 octobre 2026', dAr:'الجمعة 30 أكتوبر 2026',
              pFr:'Pass Vert',  pAr:'الجواز الأخضر', hex:'#17915A' },
  benarous: { key:'benarous', fr:'Ben Arous', ar:'بن عروس', date:'2026-10-31',
              dFr:'Samedi 31 octobre 2026',   dAr:'السبت 31 أكتوبر 2026',
              pFr:'Pass Jaune', pAr:'الجواز الأصفر', hex:'#E8A317' }
};
config.GOV_KEYS = Object.keys(config.GOVS);

/* Checked in EVERY environment, not just production: these are the mistakes
   that cost an hour of confused debugging, so they get a plain sentence. */
function assertBootConfig() {
  const fail = msg => { const e = new Error(msg); e.boot = true; throw e; };

  if (!config.mongoUri) {
    fail('MONGODB_URI is not set.\n' +
      '  Is backend/.env present, and named exactly ".env" (not ".env.txt")?\n' +
      '  Copy .env.example to .env and fill it in, then run npm start from the backend folder.');
  }
  if (!/^mongodb(\+srv)?:\/\//.test(config.mongoUri)) {
    fail('MONGODB_URI does not start with "mongodb://" or "mongodb+srv://".\n' +
      '  Check that line in .env — a duplicated "MONGODB_URI=" prefix or stray\n' +
      '  quotes around the value are the usual cause.');
  }
  if (config.mongoUri.includes('<') || config.mongoUri.includes('>')) {
    fail('MONGODB_URI still contains angle brackets — the <db_password>\n' +
      '  placeholder was never replaced with the real password.');
  }
  mailWarnings().forEach(w => console.warn('\n[mail] WARNING — ' + w + '\n'));

  if (config.edition.opensAt && Number.isNaN(config.edition.opensAt.getTime())) {
    fail('REGISTRATION_OPENS_AT is not a valid date. Use an ISO instant such as\n' +
      '  2026-09-25T09:00:00+01:00, or leave it blank to open immediately.');
  }
}

/* Mail mistakes that don't crash anything — mail still goes out — but
   quietly break replies or get the account blocked on launch day. */
function mailWarnings() {
  const m = config.mail, out = [];
  if (!m.user) return out;                      // dry-run mode, nothing to check
  const lc = v => String(v || '').toLowerCase();
  const isGmail = /(^|\.)gmail\.com$/i.test(m.host || '') || /@gmail\.com$/i.test(m.user);
  if (!isGmail) return out;

  if (m.from && lc(m.from) !== lc(m.user)) {
    out.push(`MAIL_FROM is "${m.from}" but Gmail can only send as "${m.user}".\n` +
      '  Gmail will rewrite the sender anyway, and the contact link printed in every\n' +
      '  e-mail footer will point at the wrong address. Leave MAIL_FROM empty.');
  }
  if (m.replyTo && lc(m.replyTo) !== lc(m.user) && !/@gmail\.com$/i.test(m.replyTo)) {
    out.push(`MAIL_REPLY_TO is "${m.replyTo}". If that mailbox does not exist yet,\n` +
      '  every director who replies to a confirmation gets a bounce.\n' +
      '  Leave MAIL_REPLY_TO empty to reply to the Gmail account itself.');
  }
  const n = m.organisers.length, cap = config.edition.maxSchools;
  if (n > 1) {
    const peak = cap + cap * n;
    out.push(`ORGANISER_EMAILS lists ${n} addresses. Every registration e-mails each of them.\n` +
      `  If all ${cap} places fill in one day that is about ${peak} e-mails, and free Gmail\n` +
      '  blocks ALL sending — school confirmations included — for up to 24 hours once\n' +
      '  it passes ~500 recipients. Use a single organiser address.');
  }
  return out;
}

/* Fail at boot, not at 3am. */
function assertProductionConfig() {
  if (config.env !== 'production') return;
  const bad = [];
  if (!config.jwt.secret || config.jwt.secret.length < 32) bad.push('JWT_SECRET (>=32 chars)');
  if (!config.corsOrigins.length) bad.push('CORS_ORIGINS');
  if (config.corsOrigins.includes('*')) bad.push('CORS_ORIGINS must not be *');
  if (bad.length) throw new Error('Invalid production config: ' + bad.join(', '));
}

module.exports = { config, assertBootConfig, assertProductionConfig, mailWarnings };