// ============================================================
// SQL Account API helpers — shared by sync-v2.js and fix-invoices.js
// Uses the EXACT same auth pattern as V1's working sync-postgres.js
// ============================================================

import crypto from 'crypto';

function sign(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function getSignatureKey(key, d, r, s) { return sign(sign(sign(sign(Buffer.from('AWS4'+key), d), r), s), 'aws4_request'); }

export function buildHeaders(path, qs = '') {
  const { SQL_ACCESS_KEY, SQL_SECRET_KEY, SQL_HOST, SQL_REGION, SQL_SERVICE } = process.env;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const host = SQL_HOST.replace('https://', '');
  const payloadHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = ['GET', path, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${SQL_REGION}/${SQL_SERVICE}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
  const sig = crypto.createHmac('sha256',
    getSignatureKey(SQL_SECRET_KEY, dateStamp, SQL_REGION, SQL_SERVICE)).update(sts).digest('hex');
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${SQL_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date': amzDate,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };
}

export async function fetchPage(endpoint, offset, limit = 50) {
  const qs = `limit=${limit}&offset=${offset}`;
  const res = await fetch(`${process.env.SQL_HOST}${endpoint}?${qs}`, {
    headers: buildHeaders(endpoint, qs),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) return { blocked: true, records: [] };
  try {
    const data = JSON.parse(text);
    const records = data.data
      ? (Array.isArray(data.data) ? data.data : [data.data])
      : (Array.isArray(data) ? data : []);
    return { blocked: false, records };
  } catch { return { blocked: false, records: [] }; }
}

export function safe(v) { return v == null ? null : String(v); }
export function safeDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0,10); }
