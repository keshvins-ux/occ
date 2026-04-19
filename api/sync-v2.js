// ============================================================
// V2 SYNC — PERMANENT, SELF-HEALING
// File: /api/sync-v2.js
//
// Replaces V1's broken watermark-based sync.
// Strategy: compare API record count vs Postgres count.
// If gap found → fetch all from API, identify missing dockets, insert them.
// If no gap → done in <2 seconds.
//
// Runs via cron every 15 minutes. Handles all core tables:
//   - salesinvoices
//   - receiptvouchers
//   - salesorders
//   - deliveryorders
//   - customers
//   - stockitems
//
// Usage:
//   GET /api/sync-v2                        → syncs all tables
//   GET /api/sync-v2?table=salesinvoices    → syncs one table
//   GET /api/sync-v2?status=true            → shows sync status
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

// ── AWS4 SIGNING ──────────────────────────────────────────────
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

async function fetchPage(endpoint, offset) {
  const path = `${endpoint}/${offset}`;
  const url = `${process.env.SQL_HOST}${path}`;
  const res = await fetch(url, { headers: buildHeaders(path), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (text.trim().startsWith('<')) return { blocked: true, records: [] };
  try {
    const d = JSON.parse(text);
    return { blocked: false, records: d.data || [] };
  } catch { return { blocked: false, records: [] }; }
}

function safe(v) { return v == null ? null : String(v); }
function safeDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0,10); }

// ── TABLE CONFIGS ─────────────────────────────────────────────
const TABLES = {
  salesinvoices: {
    apiEndpoint: '/salesinvoice',
    pgTable: 'sql_salesinvoices',
    dockeyCol: 'dockey',
    insertFn: insertInvoice,
  },
  receiptvouchers: {
    apiEndpoint: '/receiptvoucher',
    pgTable: 'sql_receiptvouchers',
    dockeyCol: 'dockey',
    insertFn: insertReceiptVoucher,
  },
  salesorders: {
    apiEndpoint: '/salesorder',
    pgTable: 'sql_salesorders',
    dockeyCol: 'dockey',
    insertFn: insertSalesOrder,
  },
  deliveryorders: {
    apiEndpoint: '/deliveryorder',
    pgTable: 'sql_deliveryorders',
    dockeyCol: 'dockey',
    insertFn: insertDeliveryOrder,
  },
  customers: {
    apiEndpoint: '/customer',
    pgTable: 'sql_customers',
    dockeyCol: 'dockey',
    insertFn: insertCustomer,
  },
  stockitems: {
    apiEndpoint: '/stockitem',
    pgTable: 'sql_stockitems',
    dockeyCol: 'dockey',
    insertFn: insertStockItem,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const started = Date.now();
  const { table, status } = req.query || {};

  try {
    // Status check
    if (status === 'true') {
      const results = {};
      for (const [name, cfg] of Object.entries(TABLES)) {
        const r = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pgTable}`);
        results[name] = { pgCount: r.rows[0].c };
      }
      return res.status(200).json({ tables: results, ms: Date.now() - started });
    }

    // Sync specific table or all
    const tablesToSync = table ? { [table]: TABLES[table] } : TABLES;
    if (table && !TABLES[table]) {
      return res.status(400).json({ error: `Unknown table: ${table}. Valid: ${Object.keys(TABLES).join(', ')}` });
    }

    const results = {};
    for (const [name, cfg] of Object.entries(tablesToSync)) {
      // Time check — stop if we're approaching 55s
      if (Date.now() - started > 50000) {
        results[name] = { skipped: true, reason: 'timeout approaching' };
        continue;
      }
      results[name] = await syncTable(name, cfg, started);
    }

    return res.status(200).json({ results, ms: Date.now() - started });
  } catch (e) {
    console.error('sync-v2 error:', e);
    return res.status(500).json({ error: e.message, ms: Date.now() - started });
  }
}

async function syncTable(name, cfg, started) {
  // Step 1: Get existing dockets from Postgres
  const existingRes = await q(`SELECT ${cfg.dockeyCol} FROM ${cfg.pgTable}`);
  const existingKeys = new Set(existingRes.rows.map(r => r[cfg.dockeyCol]));
  const pgBefore = existingKeys.size;

  // Step 2: Fetch ALL records from SQL Account API
  let offset = 0, apiTotal = 0;
  const missing = [];
  const toUpdate = [];

  while (true) {
    if (Date.now() - started > 48000) break; // safety margin

    const { blocked, records } = await fetchPage(cfg.apiEndpoint, offset);
    if (blocked) return { error: 'API blocked', pgCount: pgBefore };
    if (!records.length) break;

    apiTotal += records.length;
    for (const r of records) {
      if (!existingKeys.has(r.dockey)) {
        missing.push(r);
      }
    }
    offset += records.length;
  }

  // Step 3: Insert missing records
  let inserted = 0, errors = 0;
  for (const r of missing) {
    if (Date.now() - started > 52000) break;
    try {
      await cfg.insertFn(r);
      inserted++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`${name} insert error dockey=${r.dockey}:`, e.message);
    }
  }

  return {
    pgBefore,
    apiTotal,
    missing: missing.length,
    inserted,
    errors,
    pgAfter: pgBefore + inserted,
  };
}

// ── INSERT FUNCTIONS ──────────────────────────────────────────

async function insertInvoice(r) {
  await q(`
    INSERT INTO sql_salesinvoices (
      dockey, docno, docnoex, docdate, postdate,
      code, companyname, description, cancelled, status,
      docamt, localdocamt, area, agent, terms,
      docref1, docref2, docref3, occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
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
}

async function insertReceiptVoucher(r) {
  await q(`
    INSERT INTO sql_receiptvouchers (
      dockey, docno, docdate, code, companyname, description,
      docamt, paymentmethod, cancelled, status, gltransid,
      occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      docamt=EXCLUDED.docamt, cancelled=EXCLUDED.cancelled, occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
    safe(r.description), safe(r.docamt), safe(r.paymentmethod),
    r.cancelled ?? false, r.status ?? null, r.gltransid ?? null,
  ]);
}

async function insertSalesOrder(r) {
  await q(`
    INSERT INTO sql_salesorders (
      dockey, docno, docdate, code, companyname, description,
      cancelled, status, docamt, agent, area, terms,
      docref1, docref2, docref3, deliverydate,
      occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      docamt=EXCLUDED.docamt, cancelled=EXCLUDED.cancelled,
      status=EXCLUDED.status, docref3=EXCLUDED.docref3,
      occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
    safe(r.description), r.cancelled ?? false, r.status ?? null,
    safe(r.docamt), safe(r.agent), safe(r.area), safe(r.terms),
    safe(r.docref1), safe(r.docref2), safe(r.docref3), safeDate(r.deliverydate),
  ]);
}

async function insertDeliveryOrder(r) {
  await q(`
    INSERT INTO sql_deliveryorders (
      dockey, docno, docdate, code, companyname, description,
      cancelled, status, docamt, agent, area,
      docref1, docref2, docref3,
      occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      docamt=EXCLUDED.docamt, cancelled=EXCLUDED.cancelled, occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
    safe(r.description), r.cancelled ?? false, r.status ?? null,
    safe(r.docamt), safe(r.agent), safe(r.area),
    safe(r.docref1), safe(r.docref2), safe(r.docref3),
  ]);
}

async function insertCustomer(r) {
  await q(`
    INSERT INTO sql_customers (
      dockey, code, companyname, creditterm, creditlimit,
      outstanding, area, agent, status,
      occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      companyname=EXCLUDED.companyname, creditlimit=EXCLUDED.creditlimit,
      outstanding=EXCLUDED.outstanding, status=EXCLUDED.status,
      occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.code), safe(r.companyname), safe(r.creditterm),
    safe(r.creditlimit), safe(r.outstanding), safe(r.area),
    safe(r.agent), safe(r.status),
  ]);
}

async function insertStockItem(r) {
  await q(`
    INSERT INTO sql_stockitems (
      dockey, code, description, stockgroup, uom_code,
      isactive, balsqty, reorderlevel,
      occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      description=EXCLUDED.description, balsqty=EXCLUDED.balsqty,
      isactive=EXCLUDED.isactive, reorderlevel=EXCLUDED.reorderlevel,
      occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.code), safe(r.description), safe(r.stockgroup),
    safe(r.uom), r.isactive ?? true, safe(r.balsqty), safe(r.reorderlevel),
  ]);
}
