// ============================================================
// PURCHASE INVOICE LINES SYNC
// File: /api/sync-pilines.js
// Fetches detail lines for each purchase invoice from SQL Account API
// and inserts into sql_pi_lines table.
//
// Usage: GET /api/sync-pilines              → syncs next batch of 20 PIs
//        GET /api/sync-pilines?dockey=1234  → syncs lines for specific PI
//        GET /api/sync-pilines?status=true  → shows sync progress
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

// ── SQL Account AWS4 HMAC Auth ────────────────────────────────
function buildAuthHeaders(method, path) {
  const accessKey  = process.env.SQL_ACCESS_KEY;
  const secretKey  = process.env.SQL_SECRET_KEY;
  const host       = (process.env.SQL_HOST || 'https://api.sql.my').replace('https://', '');
  const region     = process.env.SQL_REGION || 'ap-southeast-5';
  const service    = process.env.SQL_SERVICE || 'sqlaccount';

  const now = new Date();
  const dateStamp  = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate    = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';
  const scope      = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonical = [
    method, path, '',
    `host:${host}`, `x-amz-date:${amzDate}`, '',
    'host;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n');

  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope,
    crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');

  const kDate    = crypto.createHmac('sha256', 'AWS4' + secretKey).update(dateStamp).digest();
  const kRegion  = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');

  return {
    'Host': host,
    'X-Amz-Date': amzDate,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=host;x-amz-date, Signature=${signature}`,
  };
}

async function fetchDetail(endpoint, dockey) {
  const host = process.env.SQL_HOST || 'https://api.sql.my';
  const path = `/${endpoint.replace(/^\//, '')}/${dockey}`;
  const url  = `${host}${path}`;
  const headers = buildAuthHeaders('GET', path);

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    console.error(`SQL API ${path}: ${res.status}`);
    return null;
  }
  return res.json();
}

function safe(v) { return v == null ? null : String(v); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const started = Date.now();
  const { dockey, status } = req.query || {};

  try {
    // Status check
    if (status === 'true') {
      const total = await q(`SELECT COUNT(*)::int AS c FROM sql_purchaseinvoices`);
      const synced = await q(`SELECT COUNT(DISTINCT dockey)::int AS c FROM sql_pi_lines`);
      const lineCount = await q(`SELECT COUNT(*)::int AS c FROM sql_pi_lines`);
      return res.status(200).json({
        totalPIs: total.rows[0].c,
        pisSynced: synced.rows[0].c,
        totalLines: lineCount.rows[0].c,
        remaining: total.rows[0].c - synced.rows[0].c,
      });
    }

    // Sync specific dockey
    if (dockey) {
      const count = await syncOnePi(parseInt(dockey));
      return res.status(200).json({ dockey: parseInt(dockey), lines: count, ms: Date.now() - started });
    }

    // Batch sync — find PIs without lines and sync them
    const pending = await q(`
      SELECT pi.dockey
      FROM sql_purchaseinvoices pi
      WHERE NOT EXISTS (SELECT 1 FROM sql_pi_lines l WHERE l.dockey = pi.dockey)
        AND pi.docamt != '0' AND pi.docamt IS NOT NULL
        AND (pi.cancelled = false OR pi.cancelled IS NULL)
      ORDER BY pi.dockey
      LIMIT 20
    `);

    if (pending.rows.length === 0) {
      return res.status(200).json({ message: 'All purchase invoices synced', done: true, ms: Date.now() - started });
    }

    let totalLines = 0;
    let synced = 0;
    let errors = 0;

    for (const row of pending.rows) {
      try {
        const count = await syncOnePi(row.dockey);
        totalLines += count;
        synced++;
      } catch (e) {
        console.error(`PI ${row.dockey} sync error:`, e.message);
        errors++;
      }
    }

    return res.status(200).json({
      synced,
      errors,
      totalLines,
      remaining: (await q(`
        SELECT COUNT(*)::int AS c FROM sql_purchaseinvoices pi
        WHERE NOT EXISTS (SELECT 1 FROM sql_pi_lines l WHERE l.dockey = pi.dockey)
          AND pi.docamt != '0' AND pi.docamt IS NOT NULL
          AND (pi.cancelled = false OR pi.cancelled IS NULL)
      `)).rows[0].c,
      done: false,
      ms: Date.now() - started,
    });
  } catch (e) {
    console.error('sync-pilines error:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function syncOnePi(dockey) {
  const detail = await fetchDetail('purchaseinvoice', dockey);
  if (!detail) return 0;

  const lines = detail.sdsdocdetail || detail.lines || [];
  let count = 0;

  for (const line of lines) {
    try {
      await q(`
        INSERT INTO sql_pi_lines (
          dtlkey, dockey, seq, itemcode, location, batch, project,
          description, description2, qty, uom, unitprice,
          amount, localamount, disc, tax, taxrate, taxamt,
          account, fromdoctype, fromdockey, fromdtlkey,
          remark1, remark2, companyitemcode, occ_synced_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW()
        )
        ON CONFLICT (dtlkey) DO UPDATE SET
          qty = EXCLUDED.qty,
          unitprice = EXCLUDED.unitprice,
          amount = EXCLUDED.amount,
          occ_synced_at = NOW()
      `, [
        line.dtlkey, line.dockey, line.seq ?? null,
        safe(line.itemcode), safe(line.location), safe(line.batch), safe(line.project),
        safe(line.description), safe(line.description2),
        safe(line.qty), safe(line.uom), safe(line.unitprice),
        safe(line.amount), safe(line.localamount),
        safe(line.disc), safe(line.tax), safe(line.taxrate), safe(line.taxamt),
        safe(line.account), safe(line.fromdoctype),
        line.fromdockey ?? null, line.fromdtlkey ?? null,
        safe(line.remark1), safe(line.remark2), safe(line.companyitemcode),
      ]);
      count++;
    } catch (e) {
      console.error(`PI line ${line.dtlkey} error:`, e.message);
    }
  }
  return count;
}
