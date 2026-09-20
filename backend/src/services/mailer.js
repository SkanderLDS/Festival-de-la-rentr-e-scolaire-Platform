'use strict';
/* ============================================================================
 * mailer.js — bilingual (FR / AR) registration confirmation.
 * Until SMTP_USER is set, messages are printed to stdout and resolve, so the
 * whole flow is testable before contact@bellaqueenfestival.tn exists.
 * ========================================================================== */

const nodemailer = require('nodemailer');
const fs = require('fs');
const { config } = require('../config');

/* Full escape set. School and director names reach the HTML e-mail body
   verbatim, so anything less than this is a stored-XSS vector aimed at
   whoever opens the message in a webmail client. */
const esc = s => String(s == null ? '' : s).replace(/[&<>"'\/]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#47;'
}[c]));

/* The order schools are ranked in never depended on server timezone — Mongo
   compares Date objects as absolute instants regardless of what clock wrote
   them. This is purely about DISPLAY: a Windows dev machine and an OVH VPS
   can each default to a different OS timezone (the VPS often defaults to
   UTC), which would otherwise make the same instant print as two different
   times. Pinning to Africa/Tunis means the printed time is always real Tunis
   wall-clock time, wherever this process happens to be running. */
const DISPLAY_TZ = 'Africa/Tunis';
function stamp(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d);
  const v = type => parts.find(p => p.type === type).value;
  const ms = String(d.getMilliseconds()).padStart(3, '0');   // ms-within-a-second is timezone-invariant
  return `${v('hour')}:${v('minute')}:${v('second')}.${ms} · ${v('day')}/${v('month')}/${v('year')}`;
}

const COPY = {
  fr: {
    lang: 'fr', dir: 'ltr',
    subject: 'Inscription confirmée — FIESTADREAM 2026, Festival de la Rentrée Scolaire',
    preheader: 'Votre établissement est inscrit. Bienvenue dans la Cité des Rêves.',
    hello: 'Madame, Monsieur le Directeur,',
    intro: s => `Nous avons le plaisir de confirmer l'inscription de <b>${esc(s)}</b> au Festival de la Rentrée Scolaire 2026 — FIESTADREAM, à la Cité des Sciences de Tunis, du 28 au 31 octobre 2026.`,
    welcome: 'Bienvenue dans la Cité des Rêves.',
    rows: { day:'Votre journée', pass:'Votre Pass', ref:'Référence',
            ts:"Horodatage d'inscription", rank:'Rang dans votre gouvernorat' },
    nextH: 'Prochaine étape',
    nextP: "Un délégué de l'agence Hosni's Events se déplacera dans votre établissement pour vous remettre votre carnet de 50 Pass Voyage et la Charte d'honneur, contre une avance de 500 DT (chèque ou virement sur le compte dédié du festival). Le solde de 500 DT est à verser avant le jour de votre visite.",
    ttl: h => `Votre place est réservée pendant ${h} heures. Passé ce délai sans avance, elle est libérée au profit de la liste d'attente.`,
    sovereign: "Votre établissement conserve la souveraineté totale sur la distribution des 50 Pass : cadeaux de mérite, contribution des parents, ou tout autre choix qui vous appartient.",
    devise: "« Façonner l'espoir à partir du rêve, et faire de l'espoir une réalité »",
    signoff: "L'Équipe d'Organisation",
    org: "Association Enfants de Tunisie &amp; Agence Hosni's Events",
    foot: "Vous recevez cet e-mail parce que votre établissement s'est inscrit sur bellaqueenfestival.tn."
  },
  ar: {
    lang: 'ar', dir: 'rtl',
    subject: 'تأكيد التسجيل — فييستادريم 2026، مهرجان العودة المدرسية',
    preheader: 'تمّ تسجيل مؤسستكم. مرحباً بكم في مدينة الأحلام.',
    hello: 'حضرة السيد(ة) المدير(ة)،',
    intro: s => `يسعدنا أن نؤكّد لكم تسجيل <b>${esc(s)}</b> في مهرجان العودة المدرسية 2026 — فييستادريم، بمدينة العلوم بتونس، من 28 إلى 31 أكتوبر 2026.`,
    welcome: 'مرحباً بكم في مدينة الأحلام.',
    rows: { day:'يومكم', pass:'جوازكم', ref:'المرجع',
            ts:'توقيت التسجيل', rank:'رتبتكم داخل ولايتكم' },
    nextH: 'الخطوة الموالية',
    nextP: "يتنقّل مندوب من وكالة Hosni's Events إلى مؤسستكم لتسليمكم دفتر 50 جواز سفر وميثاق الشرف، مقابل تسبقة قدرها 500 دينار (شيك أو تحويل بنكي على الحساب المخصّص للمهرجان). ويُدفع الباقي 500 دينار قبل يوم زيارتكم.",
    ttl: h => `مقعدكم محجوز لمدة ${h} ساعة. وبعد هذا الأجل دون تسبقة، يُحرَّر لفائدة قائمة الانتظار.`,
    sovereign: 'تحتفظ مؤسستكم بالسيادة الكاملة في توزيع الجوازات الخمسين: هدايا استحقاق، أو مساهمة من الأولياء، أو أي خيار آخر يعود إليكم.',
    devise: '«فاصنع من الحلم أملاً... واجعل الأمل حقيقة تبرق بالسعادة»',
    signoff: 'فريق التنظيم',
    org: "جمعية أطفال تونس ووكالة Hosni's Events",
    foot: 'تلقّيتم هذه الرسالة لأن مؤسستكم سجّلت عبر bellaqueenfestival.tn.'
  }
};

function buildHtml(L, d) {
  const g = config.GOVS[d.gov];
  const isAr = L.lang === 'ar';
  const font = isAr ? "'Segoe UI','Tahoma',Arial,sans-serif" : "'Segoe UI',Helvetica,Arial,sans-serif";
  const A = isAr ? 'right' : 'left';
  const B = isAr ? 'left' : 'right';

  const row = (k, v, mono) => `
    <tr>
      <td align="${A}" style="padding:9px 0;border-bottom:1px solid #2A1F52;color:#9C92BC;font-size:13px;">${esc(k)}</td>
      <td align="${B}" style="padding:9px 0;border-bottom:1px solid #2A1F52;color:#F2ECDD;font-size:14px;font-weight:700;${mono ? "font-family:'Courier New',monospace;" : ''}">${esc(v)}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="${L.lang}" dir="${L.dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(L.subject)}</title></head>
<body style="margin:0;padding:0;background:#0D0722;font-family:${font};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(L.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0722;padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${L.dir}" style="max-width:600px;background:#150E33;border:1px solid #2A1F52;border-radius:16px;overflow:hidden;">
    <tr><td align="${A}" style="background:linear-gradient(135deg,#1D1444,#150E33);padding:30px 28px 24px;border-bottom:2px solid ${g.hex};">
      <div style="color:#D4A32C;font-size:12px;letter-spacing:3px;font-weight:700;">FIESTADREAM 2026</div>
      <div style="color:#FBF6EA;font-size:23px;font-weight:800;margin-top:6px;line-height:1.3;">${esc(L.welcome)}</div>
    </td></tr>
    <tr><td align="${A}" style="padding:28px;">
      <p style="margin:0 0 14px;color:#BDB3D4;font-size:15px;">${esc(L.hello)}</p>
      <p style="margin:0 0 22px;color:#D8D0EA;font-size:15px;line-height:1.7;">${L.intro(d.school)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1A1140;border:1px solid #2A1F52;border-${isAr ? 'right' : 'left'}:4px solid ${g.hex};border-radius:10px;padding:6px 18px;margin-bottom:24px;">
        ${row(L.rows.day,  isAr ? g.dAr : g.dFr)}
        ${row(L.rows.pass, isAr ? g.pAr : g.pFr)}
        ${row(L.rows.ref,  d.ref, true)}
        ${row(L.rows.ts,   stamp(d.registeredAt), true)}
        ${row(L.rows.rank, `${String(d.rank).padStart(2, '0')} — ${isAr ? g.ar : g.fr}`, true)}
      </table>
      <div style="color:#D4A32C;font-size:13px;font-weight:800;margin-bottom:7px;">${esc(L.nextH)}</div>
      <p style="margin:0 0 14px;color:#BDB3D4;font-size:14px;line-height:1.7;">${esc(L.nextP)}</p>
      <p style="margin:0 0 18px;padding:12px 16px;background:#1A1140;border-radius:8px;color:#E8A317;font-size:13px;line-height:1.6;">${esc(L.ttl(config.edition.pendingTtlHours))}</p>
      <p style="margin:0 0 24px;color:#9C92BC;font-size:13px;line-height:1.7;">${esc(L.sovereign)}</p>
      <p style="margin:0;padding:16px 18px;background:#1A1140;border-radius:10px;color:#F2CB63;font-size:14px;line-height:1.6;">${esc(L.devise)}</p>
    </td></tr>
    <tr><td align="${A}" style="padding:22px 28px;border-top:1px solid #2A1F52;">
      <div style="color:#F2ECDD;font-size:14px;font-weight:700;">${esc(L.signoff)}</div>
      <div style="color:#9C92BC;font-size:13px;margin-top:4px;">${L.org}</div>
      <div style="margin-top:12px;">
        <a href="mailto:${esc(config.mail.from)}" style="color:#D4A32C;font-size:13px;text-decoration:none;">${esc(config.mail.from)}</a>
        <span style="color:#4A3D6B;">&nbsp;|&nbsp;</span>
        <span style="color:#9C92BC;font-size:13px;">${esc(config.mail.phone)}</span>
      </div>
    </td></tr>
    <tr><td align="${A}" style="padding:16px 28px;background:#0D0722;">
      <div style="color:#6E648C;font-size:11px;line-height:1.6;">${esc(L.foot)}</div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function buildText(L, d) {
  const g = config.GOVS[d.gov], isAr = L.lang === 'ar';
  return [
    L.hello, '',
    L.intro(d.school).replace(/<\/?b>/g, ''), '',
    L.welcome, '',
    `• ${L.rows.day}: ${isAr ? g.dAr : g.dFr}`,
    `• ${L.rows.pass}: ${isAr ? g.pAr : g.pFr}`,
    `• ${L.rows.ref}: ${d.ref}`,
    `• ${L.rows.ts}: ${stamp(d.registeredAt)}`,
    `• ${L.rows.rank}: ${String(d.rank).padStart(2, '0')} — ${isAr ? g.ar : g.fr}`, '',
    `${L.nextH} — ${L.nextP}`, '',
    L.ttl(config.edition.pendingTtlHours), '',
    L.sovereign, '', L.devise, '',
    L.signoff, L.org.replace('&amp;', '&'), config.mail.from
  ].join('\n');
}

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  if (!config.mail.user) return null;
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
    pool: true, maxConnections: 3, maxMessages: 100
  });
  return transporter;
}

/** @param {{to,lang,school,gov,ref,registeredAt,rank}} d */
async function sendConfirmation(d) {
  if (!config.GOVS[d.gov]) throw new Error(`unknown gouvernorat: ${d.gov}`);
  const L = COPY[d.lang === 'ar' ? 'ar' : 'fr'];

  const message = {
    from: `"${config.mail.fromName}" <${config.mail.from}>`,
    replyTo: config.mail.replyTo,
    to: d.to,
    subject: L.subject,
    text: buildText(L, d),
    html: buildHtml(L, d),
    headers: { 'Content-Language': L.lang, 'X-Entity-Ref-ID': d.ref }
  };

  const tx = getTransport();
  if (!tx) {
    console.log(`\n[mail:DRY-RUN ${L.lang}] → ${d.to}\n${message.subject}\n${'-'.repeat(60)}\n${message.text}\n`);
    return { dryRun: true };
  }
  const info = await tx.sendMail(message);
  return { dryRun: false, messageId: info.messageId };
}


/* ── waiting-list acknowledgement ──────────────────────────────────────────
   Half of the 300 invited schools land here by design. The tone matters: this
   is a queue with a real second edition behind it, not a rejection slip. */
const WAIT_COPY = {
  fr: {
    lang:'fr', dir:'ltr',
    subject:"Vous êtes sur la liste d'attente — FIESTADREAM 2026",
    preheader:"Votre place dans la file est enregistrée.",
    hello:'Madame, Monsieur le Directeur,',
    intro: (s,r) => `Les 150 places de la première édition sont pourvues, mais <b>${esc(s)}</b> figure désormais sur la liste d'attente officielle, en <b>position ${r}</b>.`,
    what:'Concrètement, cela signifie deux choses.',
    b1:"Si une école inscrite ne verse pas son avance dans les délais, sa place est libérée — et nous contactons la liste d'attente dans l'ordre d'arrivée.",
    b2:"À l'ouverture de la deuxième édition, vous serez prévenu avant l'annonce publique.",
    fair:"Votre position est fixée par l'heure d'arrivée de votre demande sur le serveur, exactement comme pour les inscriptions.",
    signoff:"L'Équipe d'Organisation",
    org:"Association Enfants de Tunisie &amp; Agence Hosni's Events",
    rows:{ ref:'Référence', pos:'Position dans la file', gov:'Gouvernorat', ts:'Horodatage' }
  },
  ar: {
    lang:'ar', dir:'rtl',
    subject:'أنتم على قائمة الانتظار — فييستادريم 2026',
    preheader:'تمّ تسجيل موقعكم في الصف.',
    hello:'حضرة السيد(ة) المدير(ة)،',
    intro: (s,r) => `اكتملت المقاعد الـ150 للدورة الأولى، غير أنّ <b>${esc(s)}</b> صارت مُدرَجة على قائمة الانتظار الرسمية، في <b>الموقع ${r}</b>.`,
    what:'وهذا يعني أمرين على وجه التحديد.',
    b1:'إن لم تدفع إحدى المدارس المسجّلة تسبقتها في الآجال، يُحرَّر مقعدها — ونتّصل حينها بقائمة الانتظار حسب ترتيب الوصول.',
    b2:'وعند فتح الدورة الثانية، سيصلكم الإعلام قبل الإعلان العلني.',
    fair:'موقعكم يُحدَّد بلحظة وصول طلبكم إلى الخادم، تماماً كما هو الحال في التسجيل.',
    signoff:'فريق التنظيم',
    org:"جمعية أطفال تونس ووكالة Hosni's Events",
    rows:{ ref:'المرجع', pos:'الموقع في الصف', gov:'الولاية', ts:'التوقيت' }
  }
};

function buildWaitHtml(L, d) {
  const g = config.GOVS[d.gov];
  const isAr = L.lang === 'ar';
  const font = isAr ? "'Segoe UI','Tahoma',Arial,sans-serif" : "'Segoe UI',Helvetica,Arial,sans-serif";
  const A = isAr ? 'right' : 'left', B = isAr ? 'left' : 'right';
  const row = (k,v,mono) => `<tr>
      <td align="${A}" style="padding:9px 0;border-bottom:1px solid #2A1F52;color:#9C92BC;font-size:13px;">${esc(k)}</td>
      <td align="${B}" style="padding:9px 0;border-bottom:1px solid #2A1F52;color:#F2ECDD;font-size:14px;font-weight:700;${mono?"font-family:'Courier New',monospace;":''}">${esc(v)}</td></tr>`;
  const li = txt => `<tr><td align="${A}" style="padding:6px 0;color:#BDB3D4;font-size:14px;line-height:1.7;">&bull;&nbsp; ${esc(txt)}</td></tr>`;

  return `<!DOCTYPE html><html lang="${L.lang}" dir="${L.dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(L.subject)}</title></head>
<body style="margin:0;padding:0;background:#0D0722;font-family:${font};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(L.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0722;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${L.dir}" style="max-width:600px;background:#150E33;border:1px solid #2A1F52;border-radius:16px;overflow:hidden;">
  <tr><td align="${A}" style="background:linear-gradient(135deg,#1D1444,#150E33);padding:30px 28px 24px;border-bottom:2px solid #F4A518;">
    <div style="color:#F4A518;font-size:12px;letter-spacing:3px;font-weight:700;">FIESTADREAM 2026</div>
    <div style="color:#FBF6EA;font-size:22px;font-weight:800;margin-top:6px;line-height:1.35;">${esc(L.subject)}</div></td></tr>
  <tr><td align="${A}" style="padding:28px;">
    <p style="margin:0 0 14px;color:#BDB3D4;font-size:15px;">${esc(L.hello)}</p>
    <p style="margin:0 0 22px;color:#D8D0EA;font-size:15px;line-height:1.7;">${L.intro(d.school, d.rank)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1A1140;border:1px solid #2A1F52;border-${isAr?'right':'left'}:4px solid ${g.hex};border-radius:10px;padding:6px 18px;margin-bottom:24px;">
      ${row(L.rows.pos, String(d.rank), true)}
      ${row(L.rows.ref, d.ref, true)}
      ${row(L.rows.gov, isAr ? g.ar : g.fr)}
      ${row(L.rows.ts, stamp(d.joinedAt), true)}
    </table>
    <p style="margin:0 0 6px;color:#F4A518;font-size:13px;font-weight:800;">${esc(L.what)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      ${li(L.b1)}${li(L.b2)}
    </table>
    <p style="margin:0;padding:14px 16px;background:#1A1140;border-radius:10px;color:#9C92BC;font-size:13px;line-height:1.65;">${esc(L.fair)}</p>
  </td></tr>
  <tr><td align="${A}" style="padding:22px 28px;border-top:1px solid #2A1F52;">
    <div style="color:#F2ECDD;font-size:14px;font-weight:700;">${esc(L.signoff)}</div>
    <div style="color:#9C92BC;font-size:13px;margin-top:4px;">${L.org}</div>
    <div style="margin-top:12px;"><a href="mailto:${esc(config.mail.from)}" style="color:#F4A518;font-size:13px;text-decoration:none;">${esc(config.mail.from)}</a></div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function buildWaitText(L, d) {
  const g = config.GOVS[d.gov], isAr = L.lang === 'ar';
  return [ L.hello, '', L.intro(d.school, d.rank).replace(/<\/?b>/g,''), '',
    `${L.rows.pos}: ${d.rank}`, `${L.rows.ref}: ${d.ref}`,
    `${L.rows.gov}: ${isAr ? g.ar : g.fr}`, `${L.rows.ts}: ${stamp(d.joinedAt)}`, '',
    L.what, `- ${L.b1}`, `- ${L.b2}`, '', L.fair, '',
    L.signoff, L.org.replace('&amp;','&'), config.mail.from ].join('\n');
}

/** @param {{to,lang,school,gov,ref,joinedAt,rank}} d */
async function sendWaitlist(d) {
  if (!config.GOVS[d.gov]) throw new Error(`unknown gouvernorat: ${d.gov}`);
  const L = WAIT_COPY[d.lang === 'ar' ? 'ar' : 'fr'];
  const message = {
    from: `"${config.mail.fromName}" <${config.mail.from}>`,
    replyTo: config.mail.replyTo, to: d.to, subject: L.subject,
    text: buildWaitText(L, d), html: buildWaitHtml(L, d),
    headers: { 'Content-Language': L.lang, 'X-Entity-Ref-ID': d.ref }
  };
  const tx = getTransport();
  if (!tx) {
    console.log(`\n[mail:DRY-RUN waitlist ${L.lang}] -> ${d.to}\n${message.subject}\n${'-'.repeat(60)}\n${message.text}\n`);
    return { dryRun: true };
  }
  const info = await tx.sendMail(message);
  return { dryRun: false, messageId: info.messageId };
}


/* ── approval / receipt ────────────────────────────────────────────────────
   Spec section 5: once the agency has collected the 500 DT avance, the school
   must receive a receipt for the carnet AND a digital copy of the Charte
   d'honneur. Sent by registry.approve(), never by hand. */
const OK_COPY = {
  fr: {
    lang:'fr', dir:'ltr',
    subject:'Place confirmée — reçu du carnet et Charte d\'honneur | FIESTADREAM 2026',
    preheader:'Votre avance est enregistrée. Votre place est définitive.',
    hello:'Madame, Monsieur le Directeur,',
    intro: s => `Nous accusons réception de votre avance. La place de <b>${esc(s)}</b> au Festival de la Rentrée Scolaire 2026 est désormais <b>confirmée</b>.`,
    receiptH:'Reçu de remise du carnet',
    rows:{ ref:'Référence', school:'Établissement', day:'Journée', pass:'Pass',
           seats:'Pass remis', deposit:'Avance reçue', balance:'Solde à verser',
           depref:'Référence du règlement', on:'Confirmée le' },
    balanceNote:"Le solde de 500 DT est à verser avant le jour de votre visite, selon les mêmes modalités.",
    charterH:"Charte d'honneur et de solidarité éducative",
    charterP:"Vous avez adhéré à la Charte lors de votre inscription. Elle est jointe à ce message et reste consultable à tout moment sur la plateforme.",
    nextH:'Le jour J',
    nextP:"Présentez-vous à la Cité des Sciences avec vos Pass Voyage. L'accès est organisé par couleur de gouvernorat : merci de garder le groupe ensemble à l'arrivée.",
    signoff:"L'Équipe d'Organisation",
    org:"Association Enfants de Tunisie &amp; Agence Hosni's Events"
  },
  ar: {
    lang:'ar', dir:'rtl',
    subject:'تأكيد المقعد — وصل الدفتر وميثاق الشرف | فييستادريم 2026',
    preheader:'تمّ تسجيل تسبقتكم. مقعدكم صار نهائياً.',
    hello:'حضرة السيد(ة) المدير(ة)،',
    intro: s => `نُشعركم باستلام تسبقتكم. وقد صار مقعد <b>${esc(s)}</b> في مهرجان العودة المدرسية 2026 <b>مؤكّداً</b>.`,
    receiptH:'وصل تسليم الدفتر',
    rows:{ ref:'المرجع', school:'المؤسسة', day:'اليوم', pass:'الجواز',
           seats:'الجوازات المسلّمة', deposit:'التسبقة المقبوضة', balance:'الباقي',
           depref:'مرجع الدفع', on:'تاريخ التأكيد' },
    balanceNote:'يُدفع الباقي 500 دينار قبل يوم زيارتكم، بنفس الصيغ.',
    charterH:'ميثاق الشرف والتضامن التربوي',
    charterP:'لقد وافقتم على الميثاق عند التسجيل. وهو مرفق بهذه الرسالة ويبقى متاحاً للاطّلاع على المنصة في أي وقت.',
    nextH:'يوم الموعد',
    nextP:'توجّهوا إلى مدينة العلوم بجوازات السفر. الدخول منظَّم حسب لون الولاية، فنرجو إبقاء المجموعة موحَّدة عند الوصول.',
    signoff:'فريق التنظيم',
    org:"جمعية أطفال تونس ووكالة Hosni's Events"
  }
};

function buildOkHtml(L, d) {
  const g = config.GOVS[d.gov];
  const isAr = L.lang === 'ar';
  const font = isAr ? "'Segoe UI','Tahoma',Arial,sans-serif" : "'Segoe UI',Helvetica,Arial,sans-serif";
  const A = isAr ? 'right' : 'left', B = isAr ? 'left' : 'right';
  const row = (k,v,mono) => `<tr>
      <td align="${A}" style="padding:9px 0;border-bottom:1px solid #2A1F52;color:#9C92BC;font-size:13px;">${esc(k)}</td>
      <td align="${B}" style="padding:9px 0;border-bottom:1px solid #2A1F52;color:#F2ECDD;font-size:14px;font-weight:700;${mono?"font-family:'Courier New',monospace;":''}">${esc(v)}</td></tr>`;

  return `<!DOCTYPE html><html lang="${L.lang}" dir="${L.dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(L.subject)}</title></head>
<body style="margin:0;padding:0;background:#0D0722;font-family:${font};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(L.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0722;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${L.dir}" style="max-width:600px;background:#150E33;border:1px solid #2A1F52;border-radius:16px;overflow:hidden;">
  <tr><td align="${A}" style="background:linear-gradient(135deg,#17915A,#0F5F3C);padding:28px;">
    <div style="color:#BFF3DA;font-size:12px;letter-spacing:3px;font-weight:700;">FIESTADREAM 2026</div>
    <div style="color:#FFFFFF;font-size:22px;font-weight:800;margin-top:6px;line-height:1.35;">${esc(L.receiptH)}</div></td></tr>
  <tr><td align="${A}" style="padding:28px;">
    <p style="margin:0 0 14px;color:#BDB3D4;font-size:15px;">${esc(L.hello)}</p>
    <p style="margin:0 0 22px;color:#D8D0EA;font-size:15px;line-height:1.7;">${L.intro(d.school)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1A1140;border:1px solid #2A1F52;border-${isAr?'right':'left'}:4px solid ${g.hex};border-radius:10px;padding:6px 18px;margin-bottom:18px;">
      ${row(L.rows.ref, d.ref, true)}
      ${row(L.rows.school, d.school)}
      ${row(L.rows.day, isAr ? g.dAr : g.dFr)}
      ${row(L.rows.pass, isAr ? g.pAr : g.pFr)}
      ${row(L.rows.seats, String(d.seats), true)}
      ${row(L.rows.deposit, `${config.edition.deposit ?? 500} DT`, true)}
      ${row(L.rows.balance, `${config.edition.balance ?? 500} DT`, true)}
      ${d.depositRef ? row(L.rows.depref, d.depositRef, true) : ''}
      ${row(L.rows.on, stamp(d.approvedAt), true)}
    </table>
    <p style="margin:0 0 22px;padding:12px 16px;background:#1A1140;border-radius:8px;color:#E8A317;font-size:13px;line-height:1.6;">${esc(L.balanceNote)}</p>
    <div style="color:#F4A518;font-size:13px;font-weight:800;margin-bottom:7px;">${esc(L.charterH)}</div>
    <p style="margin:0 0 20px;color:#BDB3D4;font-size:14px;line-height:1.7;">${esc(L.charterP)}</p>
    <div style="color:#F4A518;font-size:13px;font-weight:800;margin-bottom:7px;">${esc(L.nextH)}</div>
    <p style="margin:0;color:#BDB3D4;font-size:14px;line-height:1.7;">${esc(L.nextP)}</p>
  </td></tr>
  <tr><td align="${A}" style="padding:22px 28px;border-top:1px solid #2A1F52;">
    <div style="color:#F2ECDD;font-size:14px;font-weight:700;">${esc(L.signoff)}</div>
    <div style="color:#9C92BC;font-size:13px;margin-top:4px;">${L.org}</div>
    <div style="margin-top:12px;"><a href="mailto:${esc(config.mail.from)}" style="color:#F4A518;font-size:13px;text-decoration:none;">${esc(config.mail.from)}</a></div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function buildOkText(L, d) {
  const g = config.GOVS[d.gov], isAr = L.lang === 'ar';
  return [ L.hello, '', L.intro(d.school).replace(/<\/?b>/g,''), '', `== ${L.receiptH} ==`,
    `${L.rows.ref}: ${d.ref}`, `${L.rows.school}: ${d.school}`,
    `${L.rows.day}: ${isAr ? g.dAr : g.dFr}`, `${L.rows.pass}: ${isAr ? g.pAr : g.pFr}`,
    `${L.rows.seats}: ${d.seats}`, `${L.rows.deposit}: 500 DT`, `${L.rows.balance}: 500 DT`,
    d.depositRef ? `${L.rows.depref}: ${d.depositRef}` : '',
    `${L.rows.on}: ${stamp(d.approvedAt)}`, '', L.balanceNote, '',
    `== ${L.charterH} ==`, L.charterP, '', `== ${L.nextH} ==`, L.nextP, '',
    L.signoff, L.org.replace('&amp;','&'), config.mail.from
  ].filter(Boolean).join('\n');
}

/** @param {{to,lang,school,gov,ref,seats,approvedAt,depositRef,charterPath}} d */
async function sendApproval(d) {
  if (!config.GOVS[d.gov]) throw new Error(`unknown gouvernorat: ${d.gov}`);
  const L = OK_COPY[d.lang === 'ar' ? 'ar' : 'fr'];

  const message = {
    from: `"${config.mail.fromName}" <${config.mail.from}>`,
    replyTo: config.mail.replyTo, to: d.to, subject: L.subject,
    text: buildOkText(L, d), html: buildOkHtml(L, d),
    headers: { 'Content-Language': L.lang, 'X-Entity-Ref-ID': d.ref }
  };

  /* Attach the Charte only if the file is actually on disk — a missing
     document must never stop a school being told its place is confirmed. */
  const charter = d.charterPath || config.charterPath;
  if (charter && fs.existsSync(charter)) {
    message.attachments = [{
      filename: L.lang === 'ar' ? 'ميثاق-الشرف.pdf' : 'charte-honneur.pdf',
      path: charter, contentType: 'application/pdf'
    }];
  } else if (charter) {
    console.warn('[mail] charter file missing, sending without attachment:', charter);
  }

  const tx = getTransport();
  if (!tx) {
    console.log(`\n[mail:DRY-RUN approval ${L.lang}] -> ${d.to}\n${message.subject}\n${'-'.repeat(60)}\n${message.text}\n`);
    return { dryRun: true, attached: Boolean(message.attachments) };
  }
  const info = await tx.sendMail(message);
  return { dryRun: false, messageId: info.messageId, attached: Boolean(message.attachments) };
}


/* ── organiser alert ───────────────────────────────────────────────────────
   Sent to the organisation, not to the school. The confirmation flow tells
   the director their place is held; this tells the agency who to go and see.
   Everything needed to act — name, mobile, e-mail, day, rank — is in the body
   so a delegate never has to open the admin panel to make the call.

   Deliberately plain and dense rather than decorative: it is read on a phone,
   often in a car, often twenty times in a morning. */
function alertHtml(kind, d) {
  const g = config.GOVS[d.gov];
  const isReg = kind === 'registration';
  const accent = isReg ? '#17915A' : '#3FBAC7';
  const row = (k, v, mono) => `<tr>
      <td align="left" style="padding:8px 0;border-bottom:1px solid #E6E1F0;color:#6E648C;font-size:13px;white-space:nowrap;">${esc(k)}</td>
      <td align="left" style="padding:8px 0 8px 16px;border-bottom:1px solid #E6E1F0;color:#1B1140;font-size:14px;font-weight:700;${mono?"font-family:'Courier New',monospace;":''}">${v}</td></tr>`;

  const phone = String(d.phone || '').replace(/\D/g, '');

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F1FA;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1FA;padding:20px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #E0DAEE;">
  <tr><td style="background:${accent};padding:16px 22px;">
    <div style="color:#FFFFFF;font-size:12px;letter-spacing:2px;font-weight:700;opacity:.85;">FIESTADREAM 2026</div>
    <div style="color:#FFFFFF;font-size:19px;font-weight:800;margin-top:3px;">
      ${isReg ? 'Nouvelle inscription' : "Nouvelle demande — liste d'attente"}</div></td></tr>
  <tr><td style="padding:20px 22px;">
    <div style="font-size:19px;font-weight:800;color:#1B1140;margin-bottom:4px;">${esc(d.school)}</div>
    <div style="font-size:13px;color:#6E648C;margin-bottom:18px;">
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${g.hex};vertical-align:middle;margin-right:6px;"></span>
      ${esc(g.fr)} &middot; ${esc(g.dFr)} &middot; ${esc(g.pFr)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row('Responsable', esc(d.director))}
      ${row('Téléphone', `<a href="tel:+216${esc(phone)}" style="color:#1B1140;text-decoration:none;">+216 ${esc(phone)}</a>`, true)}
      ${row('E-mail', `<a href="mailto:${esc(d.email)}" style="color:#1B1140;">${esc(d.email)}</a>`)}
      ${row(isReg ? 'Rang dans la journée' : 'Position dans la file', String(d.rank).padStart(2,'0'), true)}
      ${row('Référence', esc(d.ref), true)}
      ${row('Horodatage', stamp(d.at), true)}
      ${row('Langue du contact', d.lang === 'ar' ? 'Arabe' : 'Français')}
      ${isReg ? row('Places occupées', `${d.taken} / ${config.edition.maxSchools}`, true) : ''}
    </table>
    ${isReg ? `<div style="margin-top:18px;padding:12px 14px;background:#FFF6E3;border-radius:8px;color:#8A5B00;font-size:13px;line-height:1.6;">
      Place réservée pendant ${config.edition.pendingTtlHours}&nbsp;h. Sans avance de
      ${config.edition.deposit}&nbsp;DT dans ce délai, elle repart automatiquement à la liste d'attente.</div>` : ''}
  </td></tr>
  <tr><td style="padding:14px 22px;background:#FAF8FE;border-top:1px solid #E6E1F0;">
    <div style="color:#8C82A8;font-size:11px;line-height:1.6;">
      Message automatique de bellaqueenfestival.tn &middot; ne pas répondre à cet e-mail.<br>
      Pour joindre l'école, utilisez les coordonnées ci-dessus.</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function alertText(kind, d) {
  const g = config.GOVS[d.gov];
  const isReg = kind === 'registration';
  const phone = String(d.phone || '').replace(/\D/g, '');
  return [
    isReg ? 'NOUVELLE INSCRIPTION' : "NOUVELLE DEMANDE — LISTE D'ATTENTE", '',
    d.school, `${g.fr} · ${g.dFr} · ${g.pFr}`, '',
    `Responsable : ${d.director}`,
    `Téléphone   : +216 ${phone}`,
    `E-mail      : ${d.email}`,
    `${isReg ? 'Rang' : 'Position'}        : ${String(d.rank).padStart(2,'0')}`,
    `Référence   : ${d.ref}`,
    `Horodatage  : ${stamp(d.at)}`,
    `Langue      : ${d.lang === 'ar' ? 'Arabe' : 'Français'}`,
    isReg ? `Occupation  : ${d.taken} / ${config.edition.maxSchools}` : '', '',
    isReg ? `Place réservée ${config.edition.pendingTtlHours} h sans avance de ${config.edition.deposit} DT.` : '',
    '', 'Message automatique de bellaqueenfestival.tn — ne pas répondre.'
  ].filter(Boolean).join('\n');
}

/**
 * Alert the organisation that a school just signed up.
 * @param {'registration'|'waitlist'} kind
 * @param {{school,gov,director,phone,email,lang,ref,rank,at,taken}} d
 */
async function sendOrganiserAlert(kind, d) {
  const to = config.mail.organisers;
  if (!to.length) return { skipped: 'no ORGANISER_EMAILS configured' };
  if (kind === 'waitlist' && !config.mail.alertOnWaitlist) return { skipped: 'waitlist alerts off' };
  if (!config.GOVS[d.gov]) throw new Error(`unknown gouvernorat: ${d.gov}`);

  const g = config.GOVS[d.gov];
  const subject = kind === 'registration'
    ? `[${String(d.rank).padStart(2,'0')} ${g.fr}] Inscription — ${d.school}`
    : `[Attente ${String(d.rank).padStart(2,'0')}] ${d.school}`;

  const message = {
    from: `"${config.mail.fromName}" <${config.mail.from}>`,
    /* Replying should reach the school, not the no-reply mailbox — a delegate
       will hit Reply out of habit. */
    replyTo: d.email,
    to: to.join(', '),
    subject,
    text: alertText(kind, d),
    html: alertHtml(kind, d),
    headers: { 'X-Entity-Ref-ID': d.ref, 'Auto-Submitted': 'auto-generated' }
  };

  const tx = getTransport();
  if (!tx) {
    console.log(`\n[mail:DRY-RUN organiser] -> ${message.to}\n${subject}\n${'-'.repeat(60)}\n${message.text}\n`);
    return { dryRun: true };
  }
  const info = await tx.sendMail(message);
  return { dryRun: false, messageId: info.messageId };
}

async function verify() {
  const tx = getTransport();
  if (!tx) { console.warn('[mail] SMTP_USER unset — confirmations run in DRY-RUN mode.'); return false; }
  await tx.verify();
  console.log('[mail] SMTP ready:', config.mail.user);
  return true;
}

module.exports = { sendConfirmation, sendWaitlist, sendApproval, sendOrganiserAlert,
                   verify, COPY, WAIT_COPY, OK_COPY };