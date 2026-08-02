// Sends an email to the instructor when a new welcome-kit submission is saved.
//
// Called by index.html immediately after the Firestore write succeeds. This is
// a Vercel serverless function; no dependencies, so there is nothing to install
// and the site stays a plain static deploy.
//
// Required env var (set in Vercel â†’ Settings â†’ Environment Variables):
//   RESEND_API_KEY   API key from resend.com
//
// Optional:
//   MAIL_TO          override recipient   (default tejunithin@gmail.com)
//   MAIL_BCC         override bcc         (default prashanthtwt@gmail.com)
//   MAIL_FROM        override sender      (default onboarding@resend.dev)
//   ALLOWED_ORIGIN   extra origin to accept, e.g. a custom domain

const DEFAULT_TO = 'tejunithin@gmail.com';
const DEFAULT_BCC = 'prashanthtwt@gmail.com';
const DEFAULT_FROM = 'Blissful Yoga <onboarding@resend.dev>';

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

// Coerce whatever arrived into a short, single plain string.
function clean(value) {
  const raw = Array.isArray(value) ? value.join(', ') : value;
  if (raw === undefined || raw === null || raw === '') return '';
  return String(raw).slice(0, MAX_LEN).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

// The form is the only intended caller, so require the request to come from
// this same deployment. Origin is trivially forged outside a browser â€” this
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
// cap rather than a global one â€” enough for a form that sees an entry a week.
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
    const value = clean(data[key]) || 'â€”';
    return `<tr>
      <td style="padding:8px 14px 8px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#111827;font-size:14px;vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;">
    <h2 style="font-size:18px;color:#111827;margin:0 0 4px;">New welcome-kit submission</h2>
    <p style="color:#6b7280;font-size:13px;margin:0 0 18px;">Submitted ${escapeHtml(
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
    )} IST</p>
    <table style="border-collapse:collapse;width:100%;">${rows}</table>
  </div>`;

  const text = FIELDS.map(([key, label]) => `${label}: ${clean(data[key]) || 'â€”'}`).join('\n');

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

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set â€” cannot send notification.');
    return res.status(500).json({ error: 'Mail not configured' });
  }

  const data = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const name = clean(data.fullName) || 'Unnamed client';
  const { html, text } = buildEmail(data);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || DEFAULT_FROM,
        to: [process.env.MAIL_TO || DEFAULT_TO],
        bcc: [process.env.MAIL_BCC || DEFAULT_BCC],
        reply_to: clean(data.email) || undefined,
        subject: `New welcome-kit submission â€” ${name}`,
        html,
        text
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Resend rejected the email:', response.status, detail);
      return res.status(502).json({ error: 'Mail send failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Failed to reach Resend:', err);
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
