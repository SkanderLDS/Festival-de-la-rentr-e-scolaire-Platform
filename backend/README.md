# FIESTADREAM 2026 — registration API

Backend for **bellaqueenfestival.tn**. Node 18+, Express, MongoDB.

---

## What this service guarantees

| Guarantee | How |
|---|---|
| Slot 150 can never be sold twice | One compound-filter `findOneAndUpdate` claims the global slot **and** the day's seats in a single atomic Mongo operation. No read-then-write window. |
| A rank cannot be disputed | `registeredAt` is stamped by the server on arrival. The browser clock is ignored. Ties break on `slot`, a monotonic sequence from the counter. |
| A reference is never reused | `seqCounter` only ever increments. Releasing a slot decrements occupancy, never the sequence. |
| 10 000 concurrent readers don't touch Mongo | The dataset is capped at 150 rows, so the whole public snapshot is held in memory and rebuilt only on writes. |
| No school registers twice | Partial unique index on a normalised `schoolKey` — accents, Arabic tatweel/harakat, case and punctuation folded. |
| A crash can't corrupt the count | `reconcile()` recomputes the counter from the registrations themselves. Runs at every boot. |
| No PII leaks publicly | The public snapshot carries school name, timestamp and status only. Director, phone and e-mail exist solely behind `/api/admin`. The waiting list exposes a **count** and nothing else. |
| Bots don't eat slots | Honeypot field plus a minimum fill time on both public forms. Chosen over a tight IP limit, which would punish schools behind carrier-grade NAT — common in Tunisia. |
| Usernames can't be enumerated | Login always spends the bcrypt cost, even for an unknown user, so response time reveals nothing. |
| A queued school can't double-book | Joining the waiting list is refused if that school already holds a live registration. |

---

## Install

```bash
npm install
cp .env.example .env        # then edit it
npm run seed:admin -- <username> <password> "Full Name" admin
npm start
```

**Before go-live**, prove the guarantees on your own machine:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/bellaqueen_stress node scripts/stress-test.js
```

It fires 400 concurrent registrations at the 150 cap and asserts every invariant
in the table above. It refuses to run unless the URI contains `stress` or `test`.

---

## Endpoints

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Uptime, occupancy, lock state. |
| `GET` | `/api/state` | Counter, four passes, four leaderboards. Served from memory. |
| `GET` | `/api/board/:gov` | One gouvernorat's leaderboard. |
| `POST` | `/api/registrations` | Register a school. Rate limited to 3/min/IP. |
| `GET` | `/api/registrations/:ref` | A school checking its own status. |
| `POST` | `/api/waitlist` | Join the queue once the 150 are gone. Same limits. |
| `WS` | `/live` | Snapshot on connect, then on every change. |

`POST /api/registrations` body:

```json
{
  "school": "École Primaire Privée Ennour",
  "gov": "tunis",
  "director": "Ali Ben Salah",
  "phone": "20111222",
  "email": "direction@ennour.tn",
  "lang": "fr",
  "booklets": 1,
  "charterAccepted": true
}
```

Error codes: `FULL`, `DAY_FULL`, `DUPLICATE`, `LOCKED`, `NOT_OPEN`,
`VALIDATION` (with a `fields` map), `RATE_LIMITED`.

### Admin — `Authorization: Bearer <token>`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/login` | Returns a JWT. 10 attempts / 15 min. |
| `GET` | `/api/admin/stats` | Totals by status and gouvernorat, expected deposits, failed mails. |
| `GET` | `/api/admin/registrations` | Full records. Filters: `status`, `gov`, `search`, `limit`, `skip`. |
| `POST` | `/api/admin/registrations/:ref/approve` | Call when the 500 DT avance is collected. Body: `{ "depositRef": "CHQ 1234" }`. |
| `POST` | `/api/admin/registrations/:ref/release` | Frees the slot. Body: `{ "status": "cancelled", "note": "..." }`. |
| `POST` | `/api/admin/registrations/:ref/resend` | Re-send the confirmation e-mail. |
| `POST` | `/api/admin/lock` | Manual kill switch. Body: `{ "locked": true }`. |
| `POST` | `/api/admin/reconcile` | Recompute the counter from the rows. |
| `GET` | `/api/admin/waitlist` | The queue, in order, with contact details. |
| `POST` | `/api/admin/waitlist/:ref/invite` | Call when a place frees up. |
| `POST` | `/api/admin/waitlist/:ref/status` | `waiting` / `invited` / `converted` / `withdrawn`. |
| `GET` | `/api/admin/waitlist.csv` | The queue as CSV. |
| `GET` | `/api/admin/export.csv` | Semicolon-separated, UTF-8 BOM so Excel reads the Arabic. |

---

## The registration lifecycle

```
POST /api/registrations
        │
        ├─ validate (Tunisian mobile, e-mail, charter accepted)
        ├─ atomic claim: global slot + that day's 50 seats   ← the only contended write
        ├─ insert row, status = pending, registeredAt = now
        ├─ rebuild snapshot, broadcast over WebSocket
        ├─ 201 with ref + rank + timestamp          ← director sees this immediately
        └─ send confirmation e-mail (after the response, never blocking)

        pending ──(delegate collects 500 DT)──► approved
           │
           └──(72 h elapse, cron every 15 min)──► expired, slot returned
```

A mail failure never fails a registration. The school *is* registered; the error
is recorded on the row and surfaces in `/api/admin/stats` as `mailFailed`, and
you re-send from the admin panel.

---

## Deployment (OVH VPS, nginx + PM2)

```bash
# 1. MongoDB bound to localhost only
sudo systemctl enable --now mongod

# 2. App
cd /srv/bellaqueen-backend
npm ci --omit=dev
cp .env.example .env && nano .env      # JWT_SECRET: openssl rand -hex 48
npm run seed:admin -- hosni 'a-long-password' "Hosni Events" admin
pm2 start src/server.js --name bqf-api
pm2 save && pm2 startup
```

nginx — API on its own subdomain, static site on the apex:

```nginx
server {
  server_name api.bellaqueenfestival.tn;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;     # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_set_header X-Real-IP  $remote_addr;      # needed for rate limiting
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 70s;
  }
}

server {
  server_name bellaqueenfestival.tn www.bellaqueenfestival.tn;
  root /var/www/bellaqueen;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
  gzip on;
  gzip_types text/html text/css application/javascript image/svg+xml;
}
```

```bash
sudo certbot --nginx -d bellaqueenfestival.tn -d www.bellaqueenfestival.tn -d api.bellaqueenfestival.tn
```

Then set `TRUST_PROXY=1` in `.env` — without it every request looks like it came
from 127.0.0.1 and the rate limiter throttles all of Tunisia as one client.

---

## Connecting the front-end

In `index.html`, one line near the top of the script:

```js
const API_BASE = "https://api.bellaqueenfestival.tn";
```

Empty string = demo mode (localStorage, no server). Setting it switches the page
to the live API + WebSocket and hides the developer bar automatically.

---

## Security posture

Audited, not assumed. What was found and fixed:

| Finding | Fix |
|---|---|
| `nodemailer@6` carried **SMTP command injection**, CRLF header injection and recipient-domain-bypass advisories | upgraded to `10.0.10` — `npm audit` now reports **0 vulnerabilities** |
| `node-cron@3` pulled a vulnerable `uuid` | upgraded to `4.x` |
| `jwt.verify` accepted any `alg` the token claimed — classic algorithm-confusion bypass | pinned to `HS256` on both sign and verify |
| `esc()` did not escape `'` or `/` | full escape set, both frontend and mail templates |
| Login returned instantly for unknown usernames, revealing valid ones by timing | always spends the bcrypt cost |
| `CORS_ORIGINS` empty meant wide-open in production | fails closed in production, permissive only in dev |
| Repeated query params (`?status=a&status=b`) arrived as arrays and were silently half-read | rejected with 400 |
| Registration rate limit of 3/min/IP would have locked out schools sharing carrier-grade NAT | raised to 8/min; real protection is a honeypot + minimum fill time |
| Waiting list had no size cap | capped at 1000 |
| Sequential refs made `/api/registrations/:ref` enumerable | 20/min limit (data is already public on the leaderboard) |
| `.env` holds SMTP password, JWT key and Mongo credentials with no `.gitignore` | `.gitignore` added — **if it ever reached a commit, rotate every value** |

Still enforced from the start: helmet with HSTS and `frameguard: deny`, 16 kb body cap,
bcrypt cost 12, NoSQL operator stripping, explicit field assignment (no mass assignment),
and no PII in any public response.

## Go-live checklist

- [ ] `npm ci` then `npm audit` — expect 0 vulnerabilities
- [ ] `openssl rand -hex 48` into `JWT_SECRET`
- [ ] Confirm `.env` is NOT in git: `git check-ignore -v .env`
- [ ] `CHARTER_PDF_PATH` points at the signed Charte, or approval mails ship without it
- [ ] `CORS_ORIGINS` set to the real domains, no wildcard
- [ ] `TRUST_PROXY=1`
- [ ] MongoDB bound to `127.0.0.1`, auth enabled, firewalled
- [ ] `node scripts/stress-test.js` passes on the VPS
- [ ] SPF, DKIM and DMARC published for bellaqueenfestival.tn
- [ ] One test registration in each language, both e-mails received and read correctly
- [ ] `node scripts/reset-edition.js --yes` to clear test data
- [ ] `REGISTRATION_OPENS_AT` set to the announced instant, if you want a hard start
- [ ] `mongodump` on a nightly cron
