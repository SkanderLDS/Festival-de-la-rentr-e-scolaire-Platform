'use strict';
const { config } = require('../config');

const RX = {
  phone: /^[2459]\d{7}$/,                         // Tunisian mobile, 8 digits
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  /* Latin + Arabic letters, digits, spaces and the usual school punctuation. */
  name:  /^[\p{L}\p{N}\s'’\-.،,()]+$/u
};

function fail(fields) {
  const e = new Error('Validation failed.');
  e.status = 422; e.code = 'VALIDATION'; e.expose = true; e.fields = fields;
  return e;
}

/** Strip $ and . from keys so a crafted body can't reach a Mongo operator. */
function sanitize(req, res, next) {
  const clean = obj => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (k.startsWith('$') || k.includes('.')) { delete obj[k]; continue; }
      if (typeof obj[k] === 'object') clean(obj[k]);
    }
  };
  clean(req.body); clean(req.query); clean(req.params);
  next();
}

/* Bots fill every field they find. A field hidden from humans that comes back
   populated, or a form "completed" in under two seconds, is not a director.
   Cheaper and fairer than tightening the IP rate limit, which would punish
   schools sharing a carrier-grade NAT — common in Tunisia. */
function antiBot(req, res, next) {
  const b = req.body || {};
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    return next(fail({ _bot: 'HONEYPOT' }));
  }
  const elapsed = Number(b.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2000) {
    return next(fail({ _bot: 'TOO_FAST' }));
  }
  next();
}

/** Shared field rules for both the registration and the waiting list. */
function validateSchoolFields(b, f) {
  const str = v => (typeof v === 'string' ? v.trim() : '');

  const school = str(b.school);
  if (school.length < 3 || school.length > 160) f.school = 'INVALID_LENGTH';
  else if (!RX.name.test(school)) f.school = 'INVALID_CHARS';

  if (!config.GOV_KEYS.includes(b.gov)) f.gov = 'INVALID';

  const director = str(b.director);
  if (director.length < 3 || director.length > 120) f.director = 'INVALID_LENGTH';
  else if (!RX.name.test(director)) f.director = 'INVALID_CHARS';

  const phone = str(b.phone).replace(/\D/g, '');
  if (!RX.phone.test(phone)) f.phone = 'INVALID';

  const email = str(b.email).toLowerCase();
  if (!RX.email.test(email) || email.length > 160) f.email = 'INVALID';

  return { school, gov: b.gov, director, phone, email,
           lang: b.lang === 'ar' ? 'ar' : 'fr' };
}

function validateWaitlist(req, res, next) {
  const b = req.body || {}, f = {};
  const v = validateSchoolFields(b, f);
  if (Object.keys(f).length) return next(fail(f));
  req.validated = v;
  next();
}

function validateRegistration(req, res, next) {
  const b = req.body || {};
  const f = {};
  const str = v => (typeof v === 'string' ? v.trim() : '');

  const school = str(b.school);
  if (school.length < 3 || school.length > 160) f.school = 'INVALID_LENGTH';
  else if (!RX.name.test(school)) f.school = 'INVALID_CHARS';

  if (!config.GOV_KEYS.includes(b.gov)) f.gov = 'INVALID';

  const director = str(b.director);
  if (director.length < 3 || director.length > 120) f.director = 'INVALID_LENGTH';
  else if (!RX.name.test(director)) f.director = 'INVALID_CHARS';

  const phone = str(b.phone).replace(/\D/g, '');
  if (!RX.phone.test(phone)) f.phone = 'INVALID';

  const email = str(b.email).toLowerCase();
  if (!RX.email.test(email) || email.length > 160) f.email = 'INVALID';

  if (b.charterAccepted !== true) f.charterAccepted = 'REQUIRED';

  const lang = b.lang === 'ar' ? 'ar' : 'fr';

  let booklets = Number(b.booklets || 1);
  if (!Number.isInteger(booklets) || booklets < 1 || booklets > 4) booklets = 1;

  if (Object.keys(f).length) return next(fail(f));

  req.validated = { school, gov: b.gov, director, phone, email, lang, booklets };
  next();
}

module.exports = { sanitize, antiBot, validateRegistration, validateWaitlist, RX };
