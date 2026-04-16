-- AnthroWorks lead-capture schema
-- Apply locally:  wrangler d1 execute anthroworks_leads --local  --file=schema.sql
-- Apply remote:   wrangler d1 execute anthroworks_leads --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  company       TEXT,
  subject       TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'contact-form',
  ip            TEXT,
  user_agent    TEXT,
  country       TEXT,
  referrer      TEXT,
  status        TEXT    NOT NULL DEFAULT 'new'   -- new | read | replied | spam
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_email      ON leads(email);
