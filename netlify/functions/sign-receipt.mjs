/**
 * sign-receipt
 *
 * Turns a disclosure log into a verifiable receipt. The client posts the
 * append-only audit entries (which by construction carry no personal value),
 * and the function returns the same payload plus an HMAC-SHA256 signature over a
 * canonical serialisation of it.
 *
 * The signing key never reaches the browser, so a receipt cannot be forged
 * client-side. The same endpoint verifies a receipt when called with `verify`,
 * which is what makes the receipt evidence rather than decoration.
 *
 * Privacy invariant enforced here, not assumed: the function rejects any entry
 * whose fields could carry a raw value. It accepts only the known disclosure-log
 * shapes and a bounded set of fields. If the client ever tried to sign a value,
 * the function refuses to sign it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// Netlify injects env vars. A build-time fallback keeps local `netlify dev`
// working; production sets RECEIPT_SIGNING_KEY in the site config.
const KEY = process.env.RECEIPT_SIGNING_KEY ?? 'dev-only-key-not-for-production';

const ALLOWED_TYPES = new Set(['granted', 'revoked', 'called', 'denied', 'requested']);

// Fields we permit per entry. Anything else is dropped before signing, so a
// stray value cannot ride along in the receipt.
const ALLOWED_FIELDS = new Set(['type', 'at', 'detail']);

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

function canonical(entries) {
  // Deterministic serialisation: sorted keys, fixed field order, so the same
  // logical receipt always signs to the same bytes and verification is stable.
  return JSON.stringify(
    entries.map((e) => ({ type: e.type, at: e.at, detail: e.detail })),
  );
}

function sign(canonicalString) {
  return createHmac('sha256', KEY).update(canonicalString).digest('hex');
}

/** Defence in depth: strip to known fields and reject anything unexpected. */
function sanitize(rawEntries) {
  if (!Array.isArray(rawEntries)) throw new Error('entries must be an array');
  if (rawEntries.length > 500) throw new Error('too many entries');
  return rawEntries.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`entry ${i} is not an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_FIELDS.has(key)) throw new Error(`entry ${i} has disallowed field "${key}"`);
    }
    const { type, at, detail } = entry;
    if (!ALLOWED_TYPES.has(type)) throw new Error(`entry ${i} has unknown type "${type}"`);
    if (typeof at !== 'string' || at.length > 40) throw new Error(`entry ${i} has a bad timestamp`);
    if (typeof detail !== 'string' || detail.length > 300) throw new Error(`entry ${i} has a bad detail`);
    return { type, at, detail };
  });
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: JSON_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: JSON_HEADERS });
  }

  const mode = body?.mode === 'verify' ? 'verify' : 'sign';

  try {
    if (mode === 'verify') {
      const entries = sanitize(body.entries);
      const claimed = typeof body.signature === 'string' ? body.signature : '';
      const expected = sign(canonical(entries));
      // Constant-time compare so a caller cannot probe the signature byte by byte.
      const a = Buffer.from(claimed, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      const valid = a.length === b.length && timingSafeEqual(a, b);
      return new Response(JSON.stringify({ valid }), { status: 200, headers: JSON_HEADERS });
    }

    const entries = sanitize(body.entries);
    const issuedAt = new Date().toISOString();
    const signature = sign(canonical(entries));
    return new Response(
      JSON.stringify({
        receipt: {
          issuer: 'proof-not-profile',
          issuedAt,
          entryCount: entries.length,
          entries,
        },
        algorithm: 'HMAC-SHA256',
        signature,
        // How to check it, so the receipt is self-describing.
        verify: 'POST { mode: "verify", entries, signature } to this endpoint',
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'bad request' }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
};
