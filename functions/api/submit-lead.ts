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

interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gclid?: string;
  fbclid?: string;
  msclkid?: string;
  li_fat_id?: string;
  referrer?: string;
  landing_url?: string;
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

function isValidPhone(raw: string): boolean {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (digits.length === 10 && digits.startsWith('0')) return true;
  if (digits.length === 11 && digits.startsWith('61')) return true;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return true;
  if (digits.length === 11 && digits.startsWith('1')) return true;
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

/**
 * Convert our client-side attribution shape into GHL's attributionSource shape.
 * GHL exposes both snake_case UTM fields and camelCase "channel" fields in the
 * same object — we populate both to light up attribution everywhere in the UI.
 * Only defined fields are included (GHL rejects null values on some plans).
 */
function toGhlAttribution(a: Attribution | undefined | null) {
  if (!a || typeof a !== 'object') return undefined;
  const out: Record<string, string> = {};
  const set = (k: string, v: unknown) => {
    if (v && typeof v === 'string' && v.trim()) out[k] = v.trim();
  };

  set('utmSource',   a.utm_source);
  set('utmMedium',   a.utm_medium);
  set('utmCampaign', a.utm_campaign);
  set('utmContent',  a.utm_content);
  set('utmTerm',     a.utm_term);
  // Echoed in the "channel" fields GHL shows on the contact card:
  set('source',      a.utm_source);
  set('medium',      a.utm_medium);
  set('campaign',    a.utm_campaign);
  // Click IDs
  set('gclid',   a.gclid);
  set('fbclid',  a.fbclid);
  set('msclkid', a.msclkid);
  // Page context
  set('referrer', a.referrer);
  set('url',      a.landing_url);
  // Derive sessionSource label
  if (a.gclid)  out.sessionSource = 'Google Ads';
  else if (a.fbclid) out.sessionSource = 'Facebook Ads';
  else if (a.msclkid) out.sessionSource = 'Microsoft Ads';
  else if (a.utm_source) out.sessionSource = `${a.utm_source}${a.utm_medium ? ' / ' + a.utm_medium : ''}`;
  else if (a.referrer) out.sessionSource = 'Referral';
  else out.sessionSource = 'Direct';

  return Object.keys(out).length ? out : undefined;
}

/** Human-readable top-level contact source for GHL's "Source" column. */
function deriveContactSource(last: Attribution | undefined, formSource: string): string {
  if (last?.gclid) return 'Google Ads';
  if (last?.fbclid) return 'Facebook Ads';
  if (last?.msclkid) return 'Microsoft Ads';
  if (last?.utm_source) {
    const s = last.utm_source.charAt(0).toUpperCase() + last.utm_source.slice(1);
    const m = last.utm_medium ? ` (${last.utm_medium})` : '';
    return `${s}${m}`;
  }
  if (last?.referrer) return 'Referral';
  return `Website — ${formSource || 'main_form'}`;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const data = await ctx.request.json<Record<string, unknown>>();
    const name        = String(data?.name || '').trim();
    const email       = String(data?.email || '').trim();
    const phone       = String(data?.phone || '').trim();
    const message     = String(data?.message || '');
    const service     = String(data?.service || 'general_enquiry');
    const formSource  = String(data?.source || 'main_form');   // internal form location, NOT a UTM
    const consent     = Boolean(data?.consent);
    const turnstileToken = String(data?.turnstileToken || '');
    const pageUrl     = String(data?.page_url || '');
    const attribution      = data?.attribution      as Attribution | undefined;
    const firstAttribution = data?.firstAttribution as Attribution | undefined;

    // --- Validation ---
    if (!name || !email || !phone) {
      return json({ ok: false, error: 'Missing required fields' }, { status: 400 });
    }
    if (!isValidEmail(email)) return json({ ok: false, error: 'Invalid email address' }, { status: 400 });
    if (!isValidPhone(phone)) return json({ ok: false, error: 'Invalid phone number' }, { status: 400 });
    if (!consent)             return json({ ok: false, error: 'Privacy Policy and Terms must be accepted' }, { status: 400 });

    // --- Turnstile ---
    const turnstileSecret = ctx.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      if (!turnstileToken) return json({ ok: false, error: 'Missing captcha token' }, { status: 400 });
      const ip = ctx.request.headers.get('CF-Connecting-IP');
      const ok = await verifyTurnstile(turnstileSecret, turnstileToken, ip);
      if (!ok) return json({ ok: false, error: 'Captcha verification failed' }, { status: 400 });
    }

    // --- Forward to GHL ---
    const apiKey     = ctx.env.GHL_API_KEY;
    const locationId = ctx.env.GHL_LOCATION_ID;

    if (!apiKey || !locationId) {
      console.warn('[submit-lead] GHL env not set; skipping GHL call.');
      return json({ ok: true, stubbed: true });
    }

    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(' ') || '-';

    // Last-touch = attribution object (this session's most recent UTMs).
    // First-touch = firstAttribution object (stored in localStorage on first visit).
    const lastTouchGhl  = toGhlAttribution(attribution);
    const firstTouchGhl = toGhlAttribution(firstAttribution);

    const contactSource = deriveContactSource(attribution, formSource);

    // Build custom fields list. GHL's Create Contact API reliably accepts
    // UTM data via custom fields (the `attributionSource` object is primarily
    // read-only on GET). So we send UTMs both ways:
    //   - customFields keyed to utm_source/utm_medium/etc. (definitive)
    //   - attributionSource object (populated if the API accepts it)
    const customFields: Array<{ key: string; field_value: string }> = [
      { key: 'service_interest',  field_value: service },
      { key: 'areas_of_concern',  field_value: message },      // challenge textarea
      { key: 'consent_accepted',  field_value: 'true' },
      { key: 'form_source',       field_value: formSource },
      { key: 'page_url',          field_value: pageUrl },
    ];

    const pushAttr = (key: string, value: string | undefined) => {
      if (value && value.trim()) customFields.push({ key, field_value: value.trim() });
    };

    // Last-touch UTM custom fields (what Jane filters reports on).
    if (attribution) {
      pushAttr('utm_source',   attribution.utm_source);
      pushAttr('utm_medium',   attribution.utm_medium);
      pushAttr('utm_campaign', attribution.utm_campaign);
      pushAttr('utm_content',  attribution.utm_content);
      pushAttr('utm_term',     attribution.utm_term);
      pushAttr('gclid',        attribution.gclid);
      pushAttr('fbclid',       attribution.fbclid);
      pushAttr('msclkid',      attribution.msclkid);
      pushAttr('referrer',     attribution.referrer);
      pushAttr('landing_url',  attribution.landing_url);
    }
    // First-touch (how we originally acquired this contact).
    if (firstAttribution) {
      pushAttr('first_utm_source',   firstAttribution.utm_source);
      pushAttr('first_utm_medium',   firstAttribution.utm_medium);
      pushAttr('first_utm_campaign', firstAttribution.utm_campaign);
      pushAttr('first_referrer',     firstAttribution.referrer);
      pushAttr('first_landing_url',  firstAttribution.landing_url);
    }

    const ghlPayload: Record<string, unknown> = {
      locationId,
      firstName,
      lastName,
      email,
      phone,
      source: contactSource,
      customFields,
      tags: [`service:${service}`, 'web-lead'],
    };

    // Attribution objects — include in case the API version accepts them.
    // If ignored by GHL, the UTM customFields above still carry the data.
    if (lastTouchGhl)  ghlPayload.attributionSource     = lastTouchGhl;
    if (firstTouchGhl) ghlPayload.lastAttributionSource = firstTouchGhl;

    const ghlRes = await fetch(GHL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Version':       GHL_API_VERSION,
      },
      body: JSON.stringify(ghlPayload),
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

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  'https://www.click2revenue.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
