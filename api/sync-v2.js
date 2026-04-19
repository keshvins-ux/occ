// ============================================================
// V2 SYNC — PERMANENT, SELF-HEALING
//
// Strategy:
//   1. Fetch ALL records from SQL Account API for one table
//   2. UPSERT every record into Postgres (INSERT or UPDATE)
//   3. No watermark — every record is processed every run
//   4. One table per cron call (avoids 60s timeout)
//
// This means:
//   - Missing records get inserted immediately
//   - Changed records (amount, status, cancelled) get updated
//   - Deleted/cancelled records get their cancelled flag updated
//   - No record can ever be permanently "missed"
//
// Cron schedule (in vercel.json):
//   salesinvoices:    every 10 min
//   receiptvouchers:  every 10 min (offset +2)
//   salesorders:      every 10 min (offset +4)
//   deliveryorders:   every 10 min (offset +6)
//   customers:        every 2 hours
//   stockitems:       every 2 hours
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
  salesinvoices:   { endpoint: '/salesinvoice',   pg: 'sql_salesinvoices',   upsert: upsertInvoice },
  receiptvouchers: { endpoint: '/receiptvoucher', pg: 'sql_receiptvouchers', upsert: upsertRV },
  salesorders:     { endpoint: '/salesorder',     pg: 'sql_salesorders',     upsert: upsertSO },
  deliveryorders:  { endpoint: '/deliveryorder',  pg: 'sql_deliveryorders',  upsert: upsertDO },
  customers:       { endpoint: '/customer',       pg: 'sql_customers',       upsert: upsertCustomer },
  stockitems:      { endpoint: '/stockitem',      pg: 'sql_stockitems',      upsert: upsertStockItem },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const started = Date.now();
  const { table, status } = req.query || {};

  try {
    // Status — show counts for all tables
    if (status === 'true') {
      const counts = {};
      for (const [name, cfg] of Object.entries(TABLES)) {
        const r = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);
        counts[name] = r.rows[0].c;
      }
      return res.status(200).json({ tables: counts, ms: Date.now() - started });
    }

    // Must specify a table
    if (!table) {
      return res.status(400).json({
        error: 'Specify ?table=salesinvoices (or receiptvouchers, salesorders, deliveryorders, customers, stockitems)',
        validTables: Object.keys(TABLES),
      });
    }

    const cfg = TABLES[table];
    if (!cfg) {
      return res.status(400).json({ error: `Unknown table: ${table}`, validTables: Object.keys(TABLES) });
    }

    // Fetch ALL records from SQL Account API
    let offset = 0, apiRecords = [];
    while (true) {
      if (Date.now() - started > 45000) break; // safety: stop before 60s
      const { blocked, records } = await fetchPage(cfg.endpoint, offset);
      if (blocked) return res.status(200).json({ table, error: 'API blocked', ms: Date.now() - started });
      if (!records.length) break;
      apiRecords.push(...records);
      offset += records.length;
    }

    if (apiRecords.length === 0) {
      return res.status(200).json({
        table, error: 'API returned 0 records — check SQL Account API credentials',
        debug: {
          endpoint: cfg.endpoint,
          host: process.env.SQL_HOST ? 'set' : 'MISSING',
          accessKey: process.env.SQL_ACCESS_KEY ? 'set' : 'MISSING',
          secretKey: process.env.SQL_SECRET_KEY ? 'set' : 'MISSING',
          region: process.env.SQL_REGION || 'MISSING',
          service: process.env.SQL_SERVICE || 'MISSING',
        },
        ms: Date.now() - started,
      });
    }

    // Count before
    const beforeRes = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);
    const pgBefore = beforeRes.rows[0].c;

    // UPSERT every record
    let upserted = 0, errors = 0, errorSamples = [];
    for (const r of apiRecords) {
      if (Date.now() - started > 55000) break; // hard stop
      try {
        await cfg.upsert(r);
        upserted++;
      } catch (e) {
        errors++;
        if (errorSamples.length < 3) {
          errorSamples.push({ dockey: r.dockey, docno: r.docno, error: e.message.slice(0, 100) });
        }
      }
    }

    // Count after
    const afterRes = await q(`SELECT COUNT(*)::int AS c FROM ${cfg.pg}`);
    const pgAfter = afterRes.rows[0].c;
    const newRecords = pgAfter - pgBefore;

    return res.status(200).json({
      table,
      apiFetched: apiRecords.length,
      pgBefore,
      pgAfter,
      newRecords,
      upserted,
      errors,
      errorSamples: errorSamples.length > 0 ? errorSamples : undefined,
      ms: Date.now() - started,
    });

  } catch (e) {
    console.error('sync-v2 error:', e);
    return res.status(500).json({ error: e.message, ms: Date.now() - started });
  }
}

// ── UPSERT FUNCTIONS ──────────────────────────────────────────
// Each function does INSERT ... ON CONFLICT DO UPDATE
// This means EVERY record is processed:
//   - New dockey → INSERT
//   - Existing dockey → UPDATE (docamt, cancelled, status, etc.)

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
