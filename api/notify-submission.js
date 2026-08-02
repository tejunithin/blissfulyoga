// Sends an email to the instructor when a new welcome-kit submission is saved.
//
// Called by index.html immediately after the Firestore write succeeds.
//
// Sends over Gmail SMTP rather than a transactional provider because the studio
// has no domain of its own, and the shared sender addresses those providers
// hand out can only deliver back to the account holder -- which would drop the
// bcc.
//
// Required env vars (Vercel -> Settings -> Environment Variables):
//   GMAIL_USER           the full Gmail address that sends the mail
//   GMAIL_APP_PASSWORD   16-character app password, NOT the account password
//
// Optional:
//   MAIL_TO          override recipient    (default tejunithin@gmail.com)
//   MAIL_BCC         override bcc          (default prashanthtwt@gmail.com)
//   MAIL_FROM_NAME   sender display name   (default "Blissful Yoga")
//   ALLOWED_ORIGIN   extra origin to accept, e.g. a custom domain

const nodemailer = require('nodemailer');

const DEFAULT_TO = 'tejunithin@gmail.com';
const DEFAULT_BCC = 'prashanthtwt@gmail.com';
const DEFAULT_FROM_NAME = 'Blissful Yoga';

// Field order and labels for the email, mirroring the form's own wording.
// Anything not listed here is ignored, so a crafted request cannot smuggle
// extra content into the instructor's inbox.
const FIELDS = [
  ['fullName', 'Full name'],
  ['dob', 'Date of birth'],
  ['gender', 'Gender'],
  ['weightValue', 'Weight (kg)'],
  ['contactNumber', 'Contact number'],
  ['email', 'Email'],
  ['profession', 'Profession'],
  ['sleepHours', 'Sleep (hours/night)'],
  ['waterIntake', 'Water intake (litres/day)'],
  ['exerciseFrequency', 'Exercise frequency'],
  ['bloodPressure', 'Blood pressure'],
  ['diabetes', 'Diabetes'],
  ['thyroid', 'Thyroid'],
  ['pregnancy', 'Pregnancy'],
  ['surgeryHistory', 'Surgery history'],
  ['medications', 'Current medications'],
  ['goals', 'What brings you to yoga'],
  ['experience', 'Experience level'],
  ['emergencyName', 'Emergency contact'],
  ['emergencyRelationship', 'Relationship'],
  ['emergencyPhone', 'Emergency phone']
];

const MAX_LEN = 2000;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Replace control characters with spaces. Written as code comparisons rather
// than a regex escape so the source stays pure ASCII and cannot be mangled by
// an editor or encoding round-trip.
function stripControls(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out;
}

// Coerce whatever arrived into a short, single-line plain string.
function clean(value) {
  const raw = Array.isArray(value) ? value.join(', ') : value;
  if (raw === undefined || raw === null || raw === '') return '';
  return stripControls(String(raw).slice(0, MAX_LEN)).trim();
}

// Strip anything that could inject an extra header if it reached one.
function headerSafe(s) {
  return clean(s).replace(/[\r\n]/g, ' ').slice(0, 200);
}

// Only use the client's address as Reply-To if it actually looks like one.
// The form's own validation is not authoritative here, and handing a malformed
// address to the SMTP layer would throw away the whole notification.
function asReplyTo(s) {
  const v = headerSafe(s);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
}

// The form is the only intended caller, so require the request to come from
// this same deployment. Origin is trivially forged outside a browser -- this
// turns away drive-by abuse, it is not a security boundary. The rate limit
// below is what caps the damage if someone bothers to forge it.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.headers.host) return true;
  if (process.env.ALLOWED_ORIGIN) {
    try {
      if (host === new URL(process.env.ALLOWED_ORIGIN).host) return true;
    } catch {
      /* malformed override, ignore */
    }
  }
  return false;
}

// Per-instance throttle. Vercel may run several instances, so this is a soft
// cap rather than a global one -- enough for a form that sees an entry a week.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;
let hits = [];

function rateLimited() {
  const now = Date.now();
  hits = hits.filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) return true;
  hits.push(now);
  return false;
}

function buildEmail(data) {
  const rows = FIELDS.map(([key, label]) => {
    const value = clean(data[key]) || '—';
    return `<tr>
      <td style="padding:8px 14px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#111827;font-size:14px;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`;
  }).join('');

  const stamp = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;">
    <h2 style="font-size:18px;color:#111827;margin:0 0 4px;">New welcome-kit submission</h2>
    <p style="color:#6b7280;font-size:13px;margin:0 0 18px;">Submitted ${escapeHtml(stamp)} IST</p>
    <table style="border-collapse:collapse;width:100%;">${rows}</table>
  </div>`;

  const text = FIELDS.map(([key, label]) => `${label}: ${clean(data[key]) || '-'}`).join('\n');

  return { html, text };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (rateLimited()) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error('GMAIL_USER / GMAIL_APP_PASSWORD are not set -- cannot send notification.');
    return res.status(500).json({ error: 'Mail not configured' });
  }

  const data = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const name = headerSafe(data.fullName) || 'Unnamed client';
  const replyTo = asReplyTo(data.email);
  const { html, text } = buildEmail(data);

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass }
    });

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || DEFAULT_FROM_NAME}" <${user}>`,
      to: process.env.MAIL_TO || DEFAULT_TO,
      bcc: process.env.MAIL_BCC || DEFAULT_BCC,
      replyTo,
      subject: `New welcome-kit submission - ${name}`,
      html,
      text
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Gmail SMTP send failed:', err && err.message);
    return res.status(502).json({ error: 'Mail send failed' });
  }
};

function safeParse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
