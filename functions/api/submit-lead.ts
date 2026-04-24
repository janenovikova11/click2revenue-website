/**
 * Cloudflare Pages Function — handles lead form submissions server-side.
 *
 * Route: POST /api/submit-lead
 *
 * Env bindings (set in Cloudflare Pages dashboard or via `wrangler pages secret put`):
 *   GHL_API_KEY          - Go High Level Private Integration Token (format: pit-xxxx-xxxx)
 *   GHL_LOCATION_ID      - Go High Level sub-account location ID
 *   TURNSTILE_SECRET_KEY - Cloudflare Turnstile secret key (pairs with PUBLIC_TURNSTILE_SITE_KEY)
 *
 * Secrets are held server-side and never exposed to the browser.
 */

interface Env {
  GHL_API_KEY?: string;
  GHL_LOCATION_ID?: string;
  TURNSTILE_SECRET_KEY?: string;
}

const GHL_API_VERSION = '2021-07-28';
const GHL_ENDPOINT = 'https://services.leadconnectorhq.com/contacts/';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

/**
 * Server-side phone validator. Must stay in sync with LeadForm.astro's validatePhone.
 * Accepts AU (10 digits starting 0, or +61 + 9 digits) and US (10 digits, or +1 + 10).
 */
function isValidPhone(raw: string): boolean {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (digits.length === 10 && digits.startsWith('0')) return true;            // AU local
  if (digits.length === 11 && digits.startsWith('61')) return true;           // AU +61
  if (digits.length === 10 && /^[2-9]/.test(digits)) return true;             // US local
  if (digits.length === 11 && digits.startsWith('1')) return true;            // US +1
  return false;
}

function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || '').trim());
}

async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  try {
    const body = new URLSearchParams();
    body.append('secret', secret);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body });
    if (!res.ok) return false;
    const data = await res.json() as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const data = await ctx.request.json<Record<string, unknown>>();
    const name    = String(data?.name || '').trim();
    const email   = String(data?.email || '').trim();
    const phone   = String(data?.phone || '').trim();
    const message = String(data?.message || '');
    const service = String(data?.service || 'general_enquiry');
    const source  = String(data?.source || 'website');
    const consent = Boolean(data?.consent);
    const turnstileToken = String(data?.turnstileToken || '');

    // --- Validation (defense-in-depth against bypassed client JS) ---
    if (!name || !email || !phone) {
      return json({ ok: false, error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidEmail(email)) {
      return json({ ok: false, error: 'Invalid email address' }, { status: 400 });
    }
    if (!isValidPhone(phone)) {
      return json({ ok: false, error: 'Invalid phone number' }, { status: 400 });
    }
    if (!consent) {
      return json({ ok: false, error: 'Privacy Policy and Terms must be accepted' }, { status: 400 });
    }

    // --- Turnstile verification (only if secret is configured) ---
    const turnstileSecret = ctx.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!turnstileToken) {
        return json({ ok: false, error: 'Missing captcha token' }, { status: 400 });
      }
      const ip = ctx.request.headers.get('CF-Connecting-IP');
      const ok = await verifyTurnstile(turnstileSecret, turnstileToken, ip);
      if (!ok) {
        return json({ ok: false, error: 'Captcha verification failed' }, { status: 400 });
      }
    }

    // --- Forward to GHL ---
    const apiKey     = ctx.env.GHL_API_KEY;
    const locationId = ctx.env.GHL_LOCATION_ID;

    if (!apiKey || !locationId) {
      console.warn('[submit-lead] GHL_API_KEY or GHL_LOCATION_ID not set; skipping GHL call.');
      return json({ ok: true, stubbed: true });
    }

    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ') || '-';

    const ghlRes = await fetch(GHL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Version':       GHL_API_VERSION,
      },
      body: JSON.stringify({
        locationId,
        firstName,
        lastName,
        email,
        phone,
        source,
        customFields: [
          { key: 'service_interest', field_value: service },
          { key: 'message',          field_value: message },
          { key: 'consent_accepted', field_value: 'true' },
        ],
        tags: [
          `service:${service}`,
          `source:${source}`,
        ],
      }),
    });

    if (!ghlRes.ok) {
      const errText = await ghlRes.text();
      console.error('[submit-lead] GHL error', ghlRes.status, errText);
      return json({ ok: false, error: 'Lead submission failed' }, { status: 502 });
    }

    return json({ ok: true });
  } catch (err) {
    console.error('[submit-lead] error', err);
    return json({ ok: false, error: 'Server error' }, { status: 500 });
  }
};

// Handle CORS preflight (same-origin, but belt-and-braces)
export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
