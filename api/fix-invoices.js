// ============================================================
// FIX MISSING INVOICES — One-time endpoint
// File: /api/fix-invoices.js
//
// Compares SQL Account API invoice list against Postgres,
// identifies missing dockets, and inserts them.
// Processes in small batches to stay under Vercel 60s timeout.
//
// Usage:
//   GET /api/fix-invoices?check=true   → shows count of missing invoices
//   GET /api/fix-invoices              → inserts missing invoices (batch of 50)
//   GET /api/fix-invoices?offset=100   → starts from offset 100 in API results
// ============================================================

import { Pool } from 'pg';
import crypto from 'crypto';

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}
async function q(sql, params = []) {
  const client = await getPool().connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

function sign(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function getSignatureKey(key, d, r, s) { return sign(sign(sign(sign(Buffer.from('AWS4'+key), d), r), s), 'aws4_request'); }

function buildHeaders(path) {
  const { SQL_ACCESS_KEY, SQL_SECRET_KEY, SQL_HOST, SQL_REGION, SQL_SERVICE } = process.env;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0,15) + 'Z';
  const dateStamp = amzDate.slice(0,8);
  const host = SQL_HOST.replace('https://','');
  const payloadHash = crypto.createHash('sha256').update('','utf8').digest('hex');
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = ['GET',path,'',canonicalHeaders,signedHeaders,payloadHash].join('\n');
  const credScope = `${dateStamp}/${SQL_REGION}/${SQL_SERVICE}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256',amzDate,credScope,
    crypto.createHash('sha256').update(canonicalRequest,'utf8').digest('hex')].join('\n');
  const sig = crypto.createHmac('sha256',
    getSignatureKey(SQL_SECRET_KEY,dateStamp,SQL_REGION,SQL_SERVICE)).update(sts).digest('hex');
  return {
    'Host': host,
    'X-Amz-Date': amzDate,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${SQL_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

function safe(v) { return v == null ? null : String(v); }
function safeDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0,10); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const started = Date.now();
  const { check, offset: rawOffset } = req.query || {};
  const startOffset = parseInt(rawOffset, 10) || 0;

  try {
    // Get existing dockets from Postgres
    const existingRes = await q('SELECT dockey FROM sql_salesinvoices');
    const existingKeys = new Set(existingRes.rows.map(r => r.dockey));
    const pgCount = existingKeys.size;

    // Fetch from SQL Account API, starting at offset
    let offset = startOffset;
    let apiTotal = 0;
    const missing = [];
    const allApiDockets = [];

    while (true) {
      if (Date.now() - started > 45000) break; // stop before 60s timeout

      const path = `/salesinvoice/${offset}`;
      const url = `${process.env.SQL_HOST}${path}`;
      const apiRes = await fetch(url, { headers: buildHeaders(path), signal: AbortSignal.timeout(15000) });
      const text = await apiRes.text();
      
      if (text.trim().startsWith('<')) break;
      
      let records;
      try { records = JSON.parse(text).data || []; } catch { records = []; }
      if (!records.length) break;

      apiTotal += records.length;
      for (const r of records) {
        allApiDockets.push(r.dockey);
        if (!existingKeys.has(r.dockey)) {
          missing.push(r);
        }
      }
      offset += records.length;
    }

    // Check mode — just report
    if (check === 'true') {
      return res.status(200).json({
        postgresCount: pgCount,
        apiFetched: apiTotal,
        apiOffset: startOffset,
        apiEndOffset: offset,
        missingCount: missing.length,
        missingDockets: missing.map(r => ({ dockey: r.dockey, docno: r.docno, date: r.docdate, customer: r.companyname, amt: r.docamt })),
        ms: Date.now() - started,
      });
    }

    // Insert missing invoices
    let inserted = 0;
    const errors = [];
    for (const r of missing) {
      try {
        await q(`
          INSERT INTO sql_salesinvoices (
            dockey, docno, docnoex, docdate, postdate,
            code, companyname, description, cancelled, status,
            docamt, localdocamt, area, agent, terms,
            docref1, docref2, docref3,
            occ_synced_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW()
          )
          ON CONFLICT (dockey) DO UPDATE SET
            docamt=EXCLUDED.docamt, docdate=EXCLUDED.docdate,
            cancelled=EXCLUDED.cancelled, companyname=EXCLUDED.companyname,
            occ_synced_at=NOW()
        `, [
          r.dockey, safe(r.docno), safe(r.docnoex), safeDate(r.docdate), safeDate(r.postdate),
          safe(r.code), safe(r.companyname), safe(r.description),
          r.cancelled ?? false, r.status ?? null,
          safe(r.docamt), safe(r.localdocamt),
          safe(r.area), safe(r.agent), safe(r.terms),
          safe(r.docref1), safe(r.docref2), safe(r.docref3),
        ]);
        inserted++;
      } catch (e) {
        errors.push({ dockey: r.dockey, docno: r.docno, error: e.message });
      }
    }

    // Verify April totals
    const verify = await q(`
      SELECT COUNT(*) AS c, COALESCE(SUM(docamt::numeric), 0) AS total
      FROM sql_salesinvoices
      WHERE docdate >= '2026-04-01' AND (cancelled = false OR cancelled IS NULL)
    `);

    return res.status(200).json({
      postgresBeforeCount: pgCount,
      apiFetched: apiTotal,
      missingFound: missing.length,
      inserted,
      errors: errors.length > 0 ? errors : undefined,
      aprilAfter: {
        count: Number(verify.rows[0].c),
        total: Number(verify.rows[0].total).toFixed(2),
        target: '77 invoices / RM 203,683.25',
      },
      nextOffset: offset < apiTotal ? offset : null,
      done: missing.length === 0 || offset >= apiTotal,
      ms: Date.now() - started,
    });

  } catch (e) {
    console.error('fix-invoices error:', e);
    return res.status(500).json({ error: e.message, ms: Date.now() - started });
  }
}
