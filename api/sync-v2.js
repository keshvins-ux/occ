// ============================================================
// V2 SYNC — SMART, PERMANENT, SELF-HEALING
//
// Strategy:
//   1. Fetch ALL dockey+docamt+docdate from Postgres (fast — single query)
//   2. Fetch ALL records from SQL Account API
//   3. Compare: find records that are MISSING or CHANGED
//   4. UPSERT only the missing/changed ones (typically <50 per run)
//   5. Full 1057 records fetched, but only ~5-20 upserts needed = fast
//
// This avoids the timeout problem of upserting all 1057 every time.
// On first run after deployment, it may need multiple passes.
// After that, each run only processes genuinely new/changed records.
//
// GET /api/sync-v2?table=salesinvoices  → sync one table
// GET /api/sync-v2?status=true          → show all counts
// ============================================================

import { Pool } from 'pg';
import { fetchPage, safe, safeDate } from './sql-api.js';

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

const TABLES = {
  salesinvoices: {
    endpoint: '/salesinvoice',
    pg: 'sql_salesinvoices',
    // Fields to compare for detecting changes
    compareQuery: `SELECT dockey, docamt, docdate::text AS docdate, cancelled FROM sql_salesinvoices`,
    compareKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}`,
    upsert: upsertInvoice,
  },
  receiptvouchers: {
    endpoint: '/receiptvoucher',
    pg: 'sql_receiptvouchers',
    compareQuery: `SELECT dockey, docamt, docdate::text AS docdate, cancelled FROM sql_receiptvouchers`,
    compareKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}`,
    upsert: upsertRV,
  },
  salesorders: {
    endpoint: '/salesorder',
    pg: 'sql_salesorders',
    compareQuery: `SELECT dockey, docamt, docdate::text AS docdate, cancelled, docref3 FROM sql_salesorders`,
    compareKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}|${r.docref3}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}|${safe(r.docref3)}`,
    upsert: upsertSO,
  },
  deliveryorders: {
    endpoint: '/deliveryorder',
    pg: 'sql_deliveryorders',
    compareQuery: `SELECT dockey, docamt, docdate::text AS docdate, cancelled FROM sql_deliveryorders`,
    compareKey: r => `${r.dockey}|${r.docamt}|${r.docdate}|${r.cancelled}`,
    apiKey: r => `${r.dockey}|${safe(r.docamt)}|${safeDate(r.docdate)}|${r.cancelled ?? false}`,
    upsert: upsertDO,
  },
  customers: {
    endpoint: '/customer',
    pg: 'sql_customers',
    compareQuery: `SELECT dockey, outstanding, status FROM sql_customers`,
    compareKey: r => `${r.dockey}|${r.outstanding}|${r.status}`,
    apiKey: r => `${r.dockey}|${safe(r.outstanding)}|${safe(r.status)}`,
    upsert: upsertCustomer,
  },
  stockitems: {
    endpoint: '/stockitem',
    pg: 'sql_stockitems',
    compareQuery: `SELECT dockey, balsqty, isactive FROM sql_stockitems`,
    compareKey: r => `${r.dockey}|${r.balsqty}|${r.isactive}`,
    apiKey: r => `${r.dockey}|${safe(r.balsqty)}|${r.isactive ?? true}`,
    upsert: upsertStockItem,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const started = Date.now();
  const { table, status } = req.query || {};

  try {
    if (status === 'true') {
      const counts = {};
      for (const [name, cfg] of Object.entries(TABLES)) {
        const r = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);
        counts[name] = r.rows[0].c;
      }
      return res.status(200).json({ tables: counts, ms: Date.now() - started });
    }

    if (!table) {
      return res.status(400).json({
        error: 'Specify ?table=salesinvoices',
        validTables: Object.keys(TABLES),
      });
    }

    const cfg = TABLES[table];
    if (!cfg) return res.status(400).json({ error: `Unknown: ${table}` });

    // Step 1: Get existing records fingerprint from Postgres (fast — one query)
    const existingRes = await q(cfg.compareQuery);
    const existingFingerprints = new Set(existingRes.rows.map(cfg.compareKey));
    const existingDockets = new Set(existingRes.rows.map(r => r.dockey));
    const pgBefore = existingDockets.size;

    // Step 2: Fetch ALL from SQL Account API
    let offset = 0, apiTotal = 0;
    const toUpsert = []; // only records that are NEW or CHANGED

    while (true) {
      if (Date.now() - started > 35000) break; // leave 25s for upserts
      const { blocked, records } = await fetchPage(cfg.endpoint, offset);
      if (blocked) return res.status(200).json({ table, error: 'API blocked' });
      if (!records.length) break;
      apiTotal += records.length;

      for (const r of records) {
        const fingerprint = cfg.apiKey(r);
        if (!existingFingerprints.has(fingerprint)) {
          // This record is either NEW (dockey not in Postgres) or CHANGED (different docamt/date/status)
          toUpsert.push(r);
        }
      }
      offset += records.length;
    }

    if (apiTotal === 0) {
      return res.status(200).json({
        table, error: 'API returned 0 records',
        debug: {
          host: process.env.SQL_HOST ? 'set' : 'MISSING',
          accessKey: process.env.SQL_ACCESS_KEY ? 'set' : 'MISSING',
          secretKey: process.env.SQL_SECRET_KEY ? 'set' : 'MISSING',
        },
        ms: Date.now() - started,
      });
    }

    // Step 3: Upsert only the changed/new records
    let upserted = 0, errors = 0, errorSamples = [];
    for (const r of toUpsert) {
      if (Date.now() - started > 55000) break;
      try {
        await cfg.upsert(r);
        upserted++;
      } catch (e) {
        errors++;
        if (errorSamples.length < 3) errorSamples.push({ dockey: r.dockey, error: e.message.slice(0, 100) });
      }
    }

    // Step 4: Count after
    const afterRes = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);

    return res.status(200).json({
      table,
      apiFetched: apiTotal,
      pgBefore,
      pgAfter: afterRes.rows[0].c,
      newOrChanged: toUpsert.length,
      upserted,
      errors,
      errorSamples: errorSamples.length > 0 ? errorSamples : undefined,
      ms: Date.now() - started,
    });

  } catch (e) {
    console.error('sync-v2 error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ── UPSERT FUNCTIONS ──────────────────────────────────────────

async function upsertInvoice(r) {
  await q(`
    INSERT INTO sql_salesinvoices (
      dockey, docno, docnoex, docdate, postdate,
      code, companyname, description, cancelled, status,
      docamt, localdocamt, area, agent, terms,
      docref1, docref2, docref3, occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      docno=EXCLUDED.docno, docdate=EXCLUDED.docdate,
      code=EXCLUDED.code, companyname=EXCLUDED.companyname,
      description=EXCLUDED.description,
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
}

async function upsertRV(r) {
  await q(`
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
  ]);
}

async function upsertSO(r) {
  await q(`
    INSERT INTO sql_salesorders (
      dockey, docno, docdate, code, companyname, description,
      cancelled, status, docamt, agent, area, terms,
      docref1, docref2, docref3, deliverydate, occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      docno=EXCLUDED.docno, docdate=EXCLUDED.docdate,
      code=EXCLUDED.code, companyname=EXCLUDED.companyname,
      cancelled=EXCLUDED.cancelled, status=EXCLUDED.status,
      docamt=EXCLUDED.docamt, agent=EXCLUDED.agent,
      docref1=EXCLUDED.docref1, docref2=EXCLUDED.docref2, docref3=EXCLUDED.docref3,
      deliverydate=EXCLUDED.deliverydate, occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.docno), safeDate(r.docdate), safe(r.code), safe(r.companyname),
    safe(r.description), r.cancelled ?? false, r.status ?? null,
    safe(r.docamt), safe(r.agent), safe(r.area), safe(r.terms),
    safe(r.docref1), safe(r.docref2), safe(r.docref3), safeDate(r.deliverydate),
  ]);
}

async function upsertDO(r) {
  await q(`
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
  ]);
}

async function upsertCustomer(r) {
  await q(`
    INSERT INTO sql_customers (
      dockey, code, companyname, creditterm, creditlimit,
      outstanding, area, agent, status, occ_synced_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (dockey) DO UPDATE SET
      code=EXCLUDED.code, companyname=EXCLUDED.companyname,
      creditterm=EXCLUDED.creditterm, creditlimit=EXCLUDED.creditlimit,
      outstanding=EXCLUDED.outstanding, area=EXCLUDED.area,
      agent=EXCLUDED.agent, status=EXCLUDED.status, occ_synced_at=NOW()
  `, [
    r.dockey, safe(r.code), safe(r.companyname), safe(r.creditterm),
    safe(r.creditlimit), safe(r.outstanding), safe(r.area),
    safe(r.agent), safe(r.status),
  ]);
}

async function upsertStockItem(r) {
  await q(`
    INSERT INTO sql_stockitems (
      dockey, code, description, stockgroup, uom_code,
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
  ]);
}
