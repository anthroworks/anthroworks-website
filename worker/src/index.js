/**
 * AnthroWorks — lead-capture Worker
 *
 * Endpoints
 *   POST /api/leads        — accept a contact-form submission
 *   GET  /api/health       — health probe
 *
 * Bindings
 *   env.DB                 — D1 database (binding name: DB)
 *
 * Vars
 *   env.ALLOWED_ORIGINS    — CSV of allowed origins for CORS
 *   env.NOTIFY_TO          — address that receives the email notification
 *   env.NOTIFY_FROM        — From: address (must be a verified Resend sender)
 *   env.TURNSTILE_ENABLED  — "true" / "false"
 *
 * Secrets
 *   env.RESEND_API_KEY     — optional; if absent, the lead is stored but no email goes out
 *   env.TURNSTILE_SECRET_KEY — required if TURNSTILE_ENABLED === "true"
 */

const MAX_FIELD = {
  name: 120,
  email: 160,
  company: 160,
  subject: 80,
  message: 5000,
};

const ALLOWED_SUBJECTS = new Set([
  'ai-strategy',
  'partnership',
  'studio',
  'research',
  'investment',
  'other',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env, origin) });
    }

    // Health
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, service: 'anthroworks-api', ts: Date.now() }, 200, env, origin);
    }

    // Lead capture
    if (url.pathname === '/api/leads' && request.method === 'POST') {
      return handleLead(request, env, ctx, origin);
    }

    return json({ error: 'not_found' }, 404, env, origin);
  },
};

async function handleLead(request, env, ctx, origin) {
  // 1. Origin check (defence-in-depth; real protection is DB-side)
  if (!isOriginAllowed(env, origin)) {
    return json({ error: 'origin_not_allowed' }, 403, env, origin);
  }

  // 2. Parse JSON
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, env, origin);
  }

  // 3. Honeypot — if the hidden "website" field is filled, silently succeed
  if (body.website && String(body.website).trim() !== '') {
    // Pretend success to not tip off the bot
    return json({ ok: true }, 200, env, origin);
  }

  // 4. Validate
  const errors = {};
  const clean = {
    name:    trimField(body.name,    MAX_FIELD.name),
    email:   trimField(body.email,   MAX_FIELD.email),
    company: trimField(body.company, MAX_FIELD.company),
    subject: trimField(body.subject, MAX_FIELD.subject),
    message: trimField(body.message, MAX_FIELD.message),
  };

  if (!clean.name)                       errors.name = 'required';
  if (!clean.email || !isEmail(clean.email)) errors.email = 'invalid';
  if (!clean.subject || !ALLOWED_SUBJECTS.has(clean.subject)) errors.subject = 'invalid';
  if (!clean.message || clean.message.length < 10) errors.message = 'too_short';

  if (Object.keys(errors).length > 0) {
    return json({ error: 'validation_failed', fields: errors }, 422, env, origin);
  }

  // 5. Optional Turnstile verification
  if ((env.TURNSTILE_ENABLED || '').toLowerCase() === 'true') {
    const token = body['cf-turnstile-response'];
    const ok = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, request);
    if (!ok) {
      return json({ error: 'captcha_failed' }, 422, env, origin);
    }
  }

  // 6. Insert into D1
  const cf = request.cf || {};
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 512);
  const referrer = (request.headers.get('Referer') || '').slice(0, 512);
  const country = cf.country || '';

  try {
    await env.DB.prepare(
      `INSERT INTO leads
         (name, email, company, subject, message, source, ip, user_agent, country, referrer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      clean.name,
      clean.email,
      clean.company || null,
      clean.subject,
      clean.message,
      'contact-form',
      ip,
      ua,
      country,
      referrer,
    ).run();
  } catch (err) {
    console.error('D1 insert failed', err);
    return json({ error: 'store_failed' }, 500, env, origin);
  }

  // 7. Fire-and-forget email notification (non-blocking for the user)
  if (env.RESEND_API_KEY && env.NOTIFY_TO && env.NOTIFY_FROM) {
    ctx.waitUntil(sendResendEmail(env, clean, { ip, country, referrer }));
  }

  return json({ ok: true }, 200, env, origin);
}

// ---------- helpers ----------

function trimField(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

function isEmail(s) {
  // Deliberately simple — real verification is the reply step
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function isOriginAllowed(env, origin) {
  if (!origin) return true; // server-to-server or same-origin
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin);
}

function corsHeaders(env, origin) {
  const allow = isOriginAllowed(env, origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(payload, status, env, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(env, origin),
    },
  });
}

async function verifyTurnstile(token, secret, request) {
  if (!token || !secret) return false;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    return !!data.success;
  } catch (err) {
    console.error('turnstile error', err);
    return false;
  }
}

async function sendResendEmail(env, lead, meta) {
  const subjectLabels = {
    'ai-strategy': 'AI Strategy & Consulting',
    'partnership': 'Partnership Enquiry',
    'studio':      'Studio / Product Interest',
    'research':    'Cultural Research',
    'investment':  'Investment',
    'other':       'Other',
  };
  const subjectLabel = subjectLabels[lead.subject] || lead.subject;
  const plain = [
    `New lead from anthroworks.co.za`,
    `--------------------------------`,
    `Name:    ${lead.name}`,
    `Email:   ${lead.email}`,
    `Company: ${lead.company || '—'}`,
    `Topic:   ${subjectLabel}`,
    ``,
    `Message:`,
    lead.message,
    ``,
    `--------------------------------`,
    `IP:       ${meta.ip || '—'}`,
    `Country:  ${meta.country || '—'}`,
    `Referrer: ${meta.referrer || '—'}`,
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:     env.NOTIFY_FROM,
        to:       [env.NOTIFY_TO],
        reply_to: lead.email,
        subject:  `[AnthroWorks] ${subjectLabel} — ${lead.name}`,
        text:     plain,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('resend failed', res.status, t);
    }
  } catch (err) {
    console.error('resend error', err);
  }
}
