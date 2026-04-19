#!/usr/bin/env node
// ============================================================
// OCC V2 — SERVER-SIDE SYNC
// Runs on DO server via crontab. No timeout limits.
// Fingerprint-based: only upserts NEW or CHANGED records.
//
// Usage:
//   node sync-all.js                  → sync all tables
//   node sync-all.js salesinvoices    → sync one table
//   node sync-all.js status           → show counts
//
// Crontab:
//   */10 * * * * /opt/occ/run-sync.sh
// ============================================================
 
const { Pool } = require('pg');
const crypto = require('crypto');
 
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://occ_user:OCCseri2026!rawang@localhost:5432/occ_erp';
const SQL_HOST = process.env.SQL_HOST;
const SQL_ACCESS_KEY = process.env.SQL_ACCESS_KEY;
const SQL_SECRET_KEY = process.env.SQL_SECRET_KEY;
const SQL_REGION = process.env.SQL_REGION || 'ap-southeast-5';
const SQL_SERVICE = process.env.SQL_SERVICE || 'sqlaccount';
 
if (!SQL_ACCESS_KEY || !SQL_SECRET_KEY || !SQL_HOST) {
  console.error('ERROR: SQL_ACCESS_KEY, SQL_SECRET_KEY, and SQL_HOST must be set');
  process.exit(1);
}
 
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
async function q(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}
 
// ── AWS4 SIGNING (exact copy from V1) ─────────────────────────
function sign(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function getSignatureKey(key, d, r, s) { return sign(sign(sign(sign(Buffer.from('AWS4'+key), d), r), s), 'aws4_request'); }
 
function buildHeaders(path, qs) {
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
    'x-amz-date': amzDate, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0',
  };
}
 
async function fetchPage(endpoint, offset, limit) {
  limit = limit || 50;
  const qs = `limit=${limit}&offset=${offset}`;
  const res = await fetch(`${SQL_HOST}${endpoint}?${qs}`, { headers: buildHeaders(endpoint, qs) });
  const text = await res.text();
  if (text.trim().startsWith('<')) return { blocked: true, records: [] };
  try {
    const data = JSON.parse(text);
    const records = data.data ? (Array.isArray(data.data) ? data.data : [data.data]) : (Array.isArray(data) ? data : []);
    return { blocked: false, records };
  } catch { return { blocked: false, records: [] }; }
}
 
function safe(v) { return v == null ? null : String(v); }
function safeDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0,10); }
 
// ── TABLE DEFINITIONS ─────────────────────────────────────────
// Each table defines:
//   fpQuery: SQL to load existing fingerprints (fast, one query)
//   fpKey:   function to build fingerprint from Postgres row
//   apiKey:  function to build fingerprint from API record
//   upsert:  function to INSERT/UPDATE one record
 
const TABLES = {
 
  // ── SALES INVOICES ──────────────────────────────────────────
  // dockey = UNIQUE, docno = UNIQUE
  // Problem: different dockey can have same docno (cancelled + re-issued)
  // Solution: ON CONFLICT (dockey) with docno update, catch docno conflicts
  salesinvoices: {
    endpoint: '/salesinvoice',
    pg: 'sql_salesinvoices',
    fpQuery: 'SELECT dockey, docamt, docdate::text AS docdate, cancelled FROM sql_salesinvoices',
    fpKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}`,
    upsert: async (r) => {
      try {
        await q(`
          INSERT INTO sql_salesinvoices (
            dockey, docno, docnoex, docdate, postdate,
            code, companyname, description, cancelled, status,
            docamt, localdocamt, area, agent, terms,
            docref1, docref2, docref3, occ_synced_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
          ON CONFLICT (dockey) DO UPDATE SET
            docno=EXCLUDED.docno, docdate=EXCLUDED.docdate,
            code=EXCLUDED.code, companyname=EXCLUDED.companyname, description=EXCLUDED.description,
            cancelled=EXCLUDED.cancelled, status=EXCLUDED.status,
            docamt=EXCLUDED.docamt, localdocamt=EXCLUDED.localdocamt,
            area=EXCLUDED.area, agent=EXCLUDED.agent, terms=EXCLUDED.terms,
            docref1=EXCLUDED.docref1, docref2=EXCLUDED.docref2, docref3=EXCLUDED.docref3,
            occ_synced_at=NOW()
        `, [
          r.dockey, safe(r.docno), safe(r.docnoex), safeDate(r.docdate), safeDate(r.postdate),
          safe(r.code), safe(r.companyname), safe(r.description),
          r.cancelled ?? false, r.status ?? null,
          safe(r.docamt), safe(r.localdocamt), safe(r.area), safe(r.agent),
          safe(r.terms), safe(r.docref1), safe(r.docref2), safe(r.docref3),
        ]);
      } catch (e) {
        if (e.message.includes('docno_key')) {
          // docno conflict — another dockey has this docno. Update by dockey only, skip docno change.
          await q(`
            UPDATE sql_salesinvoices SET
              docdate=$2, code=$3, companyname=$4, cancelled=$5, status=$6,
              docamt=$7, area=$8, agent=$9, occ_synced_at=NOW()
            WHERE dockey=$1
          `, [
            r.dockey, safeDate(r.docdate), safe(r.code), safe(r.companyname),
            r.cancelled ?? false, r.status ?? null, safe(r.docamt),
            safe(r.area), safe(r.agent),
          ]);
        } else {
          throw e;
        }
      }
    },
  },
 
  // ── RECEIPT VOUCHERS ────────────────────────────────────────
  receiptvouchers: {
    endpoint: '/receiptvoucher',
    pg: 'sql_receiptvouchers',
    fpQuery: 'SELECT dockey, docamt, docdate::text AS docdate, cancelled FROM sql_receiptvouchers',
    fpKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}`,
    upsert: async (r) => q(`
      INSERT INTO sql_receiptvouchers (
        dockey, docno, docdate, code, companyname, description,
        docamt, paymentmethod, cancelled, status, gltransid, occ_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (dockey) DO UPDATE SET
        docno=EXCLUDED.docno, docdate=EXCLUDED.docdate,
        code=EXCLUDED.code, companyname=EXCLUDED.companyname,
        docamt=EXCLUDED.docamt, paymentmethod=EXCLUDED.paymentmethod,
        cancelled=EXCLUDED.cancelled, status=EXCLUDED.status, occ_synced_at=NOW()
    `, [
      r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
      safe(r.description), safe(r.docamt), safe(r.paymentmethod),
      r.cancelled ?? false, r.status ?? null, r.gltransid ?? null,
    ]),
  },
 
  // ── SALES ORDERS ────────────────────────────────────────────
  // No deliverydate column in this table
  salesorders: {
    endpoint: '/salesorder',
    pg: 'sql_salesorders',
    fpQuery: 'SELECT dockey, docamt, docdate::text AS docdate, cancelled, docref3 FROM sql_salesorders',
    fpKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}|${r.docref3}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}|${safe(r.docref3)}`,
    upsert: async (r) => q(`
      INSERT INTO sql_salesorders (
        dockey, docno, docdate, code, companyname, description,
        cancelled, status, docamt, agent, area, terms,
        docref1, docref2, docref3, occ_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (dockey) DO UPDATE SET
        docno=EXCLUDED.docno, docdate=EXCLUDED.docdate,
        code=EXCLUDED.code, companyname=EXCLUDED.companyname,
        cancelled=EXCLUDED.cancelled, status=EXCLUDED.status,
        docamt=EXCLUDED.docamt, agent=EXCLUDED.agent,
        docref1=EXCLUDED.docref1, docref2=EXCLUDED.docref2, docref3=EXCLUDED.docref3,
        occ_synced_at=NOW()
    `, [
      r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
      safe(r.description), r.cancelled ?? false, r.status ?? null,
      safe(r.docamt), safe(r.agent), safe(r.area), safe(r.terms),
      safe(r.docref1), safe(r.docref2), safe(r.docref3),
    ]),
  },
 
  // ── DELIVERY ORDERS ─────────────────────────────────────────
  deliveryorders: {
    endpoint: '/deliveryorder',
    pg: 'sql_deliveryorders',
    fpQuery: 'SELECT dockey, docamt, docdate::text AS docdate, cancelled FROM sql_deliveryorders',
    fpKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}`,
    upsert: async (r) => q(`
      INSERT INTO sql_deliveryorders (
        dockey, docno, docdate, code, companyname, description,
        cancelled, status, docamt, agent, area,
        docref1, docref2, docref3, occ_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (dockey) DO UPDATE SET
        docno=EXCLUDED.docno, docdate=EXCLUDED.docdate,
        code=EXCLUDED.code, companyname=EXCLUDED.companyname,
        cancelled=EXCLUDED.cancelled, status=EXCLUDED.status,
        docamt=EXCLUDED.docamt, agent=EXCLUDED.agent,
        docref1=EXCLUDED.docref1, docref2=EXCLUDED.docref2, docref3=EXCLUDED.docref3,
        occ_synced_at=NOW()
    `, [
      r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
      safe(r.description), r.cancelled ?? false, r.status ?? null,
      safe(r.docamt), safe(r.agent), safe(r.area),
      safe(r.docref1), safe(r.docref2), safe(r.docref3),
    ]),
  },
 
  // ── CUSTOMERS ───────────────────────────────────────────────
  // No dockey column! Primary key is code (VARCHAR)
  customers: {
    endpoint: '/customer',
    pg: 'sql_customers',
    fpQuery: 'SELECT code, outstanding, status FROM sql_customers',
    fpKey: r => `${r.code}|${r.outstanding}|${r.status}`,
    apiKey: r => `${safe(r.code)}|${safe(r.outstanding)}|${safe(r.status)}`,
    upsert: async (r) => q(`
      INSERT INTO sql_customers (
        code, companyname, creditterm, creditlimit,
        outstanding, area, agent, status, occ_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (code) DO UPDATE SET
        companyname=EXCLUDED.companyname,
        creditterm=EXCLUDED.creditterm, creditlimit=EXCLUDED.creditlimit,
        outstanding=EXCLUDED.outstanding, area=EXCLUDED.area,
        agent=EXCLUDED.agent, status=EXCLUDED.status, occ_synced_at=NOW()
    `, [
      safe(r.code), safe(r.companyname), safe(r.creditterm),
      safe(r.creditlimit), safe(r.outstanding), safe(r.area),
      safe(r.agent), safe(r.status),
    ]),
  },
 
  // ── STOCK ITEMS ─────────────────────────────────────────────
  stockitems: {
    endpoint: '/stockitem',
    pg: 'sql_stockitems',
    fpQuery: 'SELECT dockey, balsqty, isactive FROM sql_stockitems',
    fpKey: r => `${r.dockey}|${r.balsqty}|${r.isactive}`,
    apiKey: r => `${r.dockey}|${safe(r.balsqty)}|${r.isactive ?? true}`,
    upsert: async (r) => q(`
      INSERT INTO sql_stockitems (
        dockey, code, description, stockgroup, occ_uom,
        isactive, balsqty, reorderlevel, occ_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (dockey) DO UPDATE SET
        code=EXCLUDED.code, description=EXCLUDED.description,
        stockgroup=EXCLUDED.stockgroup, balsqty=EXCLUDED.balsqty,
        isactive=EXCLUDED.isactive, reorderlevel=EXCLUDED.reorderlevel,
        occ_synced_at=NOW()
    `, [
      r.dockey, safe(r.code), safe(r.description), safe(r.stockgroup),
      safe(r.uom), r.isactive ?? true, safe(r.balsqty), safe(r.reorderlevel),
    ]),
  },
};
 
// ── SYNC ONE TABLE ────────────────────────────────────────────
async function syncTable(name) {
  const cfg = TABLES[name];
  const started = Date.now();
 
  // Step 1: Load fingerprints from Postgres
  const existing = await q(cfg.fpQuery);
  const fingerprints = new Set(existing.rows.map(cfg.fpKey));
  const pgBefore = existing.rows.length;
 
  // Step 2: Fetch ALL from API
  let offset = 0, apiTotal = 0;
  const toUpsert = [];
 
  while (true) {
    const { blocked, records } = await fetchPage(cfg.endpoint, offset);
    if (blocked) { console.error(`  [${name}] BLOCKED at offset ${offset}`); break; }
    if (!records.length) break;
    apiTotal += records.length;
    for (const r of records) {
      if (!fingerprints.has(cfg.apiKey(r))) toUpsert.push(r);
    }
    offset += records.length;
  }
 
  // Step 3: Upsert changed/new (no timeout!)
  let upserted = 0, errors = 0;
  for (const r of toUpsert) {
    try { await cfg.upsert(r); upserted++; }
    catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [${name}] ERR dockey=${r.dockey||r.code}: ${e.message.slice(0, 100)}`);
    }
  }
 
  const after = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  [${name}] ${secs}s | API: ${apiTotal} | PG: ${pgBefore}→${after.rows[0].c} | Changed: ${toUpsert.length} | Upserted: ${upserted} | Errors: ${errors}`);
}
 
// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  console.log(`\n--- OCC SYNC ${new Date().toISOString().slice(0,19)} ---`);
 
  try {
    if (arg === 'status') {
      for (const [name, cfg] of Object.entries(TABLES)) {
        const r = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);
        console.log(`  ${name.padEnd(20)} ${r.rows[0].c} records`);
      }
    } else if (arg && TABLES[arg]) {
      await syncTable(arg);
    } else if (!arg) {
      for (const name of Object.keys(TABLES)) await syncTable(name);
    } else {
      console.log(`Usage: node sync-all.js [${Object.keys(TABLES).join('|')}|status]`);
    }
  } catch (e) {
    console.error('SYNC FAILED:', e.message);
  } finally {
    await pool.end();
  }
}
 
main();
