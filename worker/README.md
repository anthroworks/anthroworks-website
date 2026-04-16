# AnthroWorks — Lead Capture Worker

Cloudflare Worker + D1 behind the contact form on `anthroworks.co.za`.
One endpoint: `POST /api/leads`. Stores submissions in D1, optionally emails
`chad@anthroworks.co.za` via Resend.

## Layout

```
worker/
├── src/index.js      ES-module Worker — request handler + validation
├── schema.sql        D1 table + indexes
├── wrangler.toml     bindings, vars, route config
├── package.json      npm scripts (dev/deploy/db:init)
└── README.md         this file
```

## First-time setup

```bash
cd worker
npm install -g wrangler        # or: brew upgrade wrangler
wrangler login                 # browser OAuth — one-time

# Create the D1 database (copy the returned database_id into wrangler.toml)
wrangler d1 create anthroworks_leads

# Apply schema locally (for `wrangler dev`) and remotely
npm run db:init:local
npm run db:init:remote

# Secrets — only RESEND_API_KEY is needed to enable email notifications
wrangler secret put RESEND_API_KEY
# (paste the Resend key from https://resend.com/api-keys)
```

## Deploy

```bash
# Uncomment the [[routes]] block in wrangler.toml once your zone is attached
npm run deploy
```

Worker then lives at `anthroworks.co.za/api/*`.

## Local dev

```bash
npm run dev                    # http://localhost:8787
curl -s http://localhost:8787/api/health
```

Point the contact-form frontend at this during development by editing
`contact.html`'s `LEAD_ENDPOINT` constant to `http://localhost:8787/api/leads`.

## Data model

```
leads
├── id             int PK
├── created_at     ISO ts (default now)
├── name           varchar 120
├── email          varchar 160
├── company        varchar 160 (nullable)
├── subject        enum: ai-strategy | partnership | studio | research | investment | other
├── message        text 5000
├── source         'contact-form' (extend later)
├── ip             CF-Connecting-IP
├── user_agent     first 512 chars
├── country        cf.country
├── referrer       first 512 chars
└── status         new | read | replied | spam
```

Query recent leads:

```bash
wrangler d1 execute anthroworks_leads --remote --command \
  "SELECT id, created_at, name, email, subject FROM leads ORDER BY id DESC LIMIT 20;"
```

## Spam protection

- **Honeypot** — a hidden `website` field in the form. Bots fill it; humans
  don't. If it's non-empty the Worker returns `200 ok` without storing.
- **Turnstile** (optional) — set `TURNSTILE_ENABLED=true` in `wrangler.toml`,
  add `TURNSTILE_SECRET_KEY` as a secret, and render the Turnstile widget in
  `contact.html`. Worker verifies `cf-turnstile-response` on every submit.
- **Rate limiting** — configure in Cloudflare dashboard (Rules → Rate Limiting).
  Suggested: 5 POSTs to `/api/leads` per IP per 10 minutes.

## Email (Resend)

Worker sends a plain-text notification to `NOTIFY_TO` with Reply-To set to the
lead's address, so replying in your inbox reaches the lead directly.

If `RESEND_API_KEY` is unset the Worker still accepts + stores leads; email
delivery is the only thing that degrades.

Verify `anthroworks.co.za` in Resend (DNS: SPF, DKIM, DMARC) before going
live, otherwise deliverability will suffer.
