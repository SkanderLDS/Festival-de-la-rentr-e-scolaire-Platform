# Bella Queen Festival — FIESTADREAM 2026

Registration platform for the Festival de la Rentrée Scolaire 2026,
Cité des Sciences de Tunis, 28–31 October 2026.

**Live domain:** bellaqueenfestival.tn
**Client:** Association Enfants de Tunisie · Agence Hosni's Events
**Founder:** M. Rafik Nour Ben Kilani

---

## What this platform does

300 private primary schools across Grand Tunis are invited. Only **150 places**
exist. The platform runs that race fairly and keeps the queue behind it.

**No money passes through this software.** A director registers online; the
agency's delegate then visits the school in person and collects the 500 DT
advance by cheque or bank transfer. An admin marks the registration confirmed,
and the school receives a receipt by e-mail. That is the whole payment flow.

```
director fills the form
   -> server stamps the arrival time to the millisecond   (decides rank)
   -> atomic claim on 1 of 150 places + 50 of that day's 2000 seats
   -> confirmation e-mail, in the language they used
   -> delegate visits, collects 500 DT in person
   -> admin confirms -> receipt e-mail + Charte d'honneur
```

Schools arriving after the 150th land on a waiting list rather than a dead end.

---

## Layout

| Path | What it is |
|---|---|
| `frontend/index.html` | The whole public site. One self-contained file. |
| `frontend/assets/` | Share card, icons, the Paparouni loop and its poster. |
| `backend/` | Express + MongoDB API. See `backend/README.md`. |
| `media/` | Source material not served to the web (full 30s film, original logo). |

---

## Running it locally

```bash
# backend
cd backend
npm install
cp .env.example .env          # then fill it in — see backend/README.md
npm run seed:admin -- <user> <password> "Full Name" admin
npm start                     # http://localhost:4000/health

# frontend
# set  const API_BASE = "http://localhost:4000";  near the top of the script,
# then open frontend/index.html, or serve it:
cd frontend && python3 -m http.server 8000
```

---

## Before anything goes live

- [ ] `backend/.env` is NOT in git — verify with `git check-ignore -v backend/.env`
- [ ] `npm audit` in `backend/` reports 0 vulnerabilities
- [ ] `og.jpg` served from a real https URL — Facebook's scraper cannot read data URIs
- [ ] SPF, DKIM and DMARC published for bellaqueenfestival.tn
- [ ] `node scripts/stress-test.js` passes against the real MongoDB
- [ ] Atlas IP allow-list narrowed from `0.0.0.0/0` to the VPS address
- [ ] `CORS_ORIGINS` set to the real domain
- [ ] Charte d'honneur PDF written and `CHARTER_PDF_PATH` pointed at it
- [ ] `node scripts/reset-edition.js --yes` to clear test data

---

## Still to build

- Admin panel UI — approvals currently require curl
- School status lookup page
- Legal pages (mentions légales, confidentialité)
- The Charte d'honneur document itself
