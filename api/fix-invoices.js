// ============================================================
// FIX MISSING INVOICES — uses V1's exact API auth pattern
// GET /api/fix-invoices?check=true   → shows missing
// GET /api/fix-invoices              → inserts missing
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const started = Date.now();
  const { check } = req.query || {};

  try {
    // Get existing dockets
    const existingRes = await q('SELECT dockey FROM sql_salesinvoices');
    const existingKeys = new Set(existingRes.rows.map(r => r.dockey));
    const pgCount = existingKeys.size;

    // Fetch all from API
    let offset = 0, apiTotal = 0;
    const missing = [];

    while (true) {
      if (Date.now() - started > 45000) break;
      const { blocked, records } = await fetchPage('/salesinvoice', offset);
      if (blocked) return res.status(200).json({ error: 'API blocked', pgCount });
      if (!records.length) break;
      apiTotal += records.length;
      for (const r of records) {
        if (!existingKeys.has(r.dockey)) missing.push(r);
      }
      offset += records.length;
    }

    if (check === 'true') {
      return res.status(200).json({
        postgresCount: pgCount,
        apiFetched: apiTotal,
        missingCount: missing.length,
        missingDockets: missing.map(r => ({
          dockey: r.dockey, docno: r.docno, date: r.docdate,
          customer: r.companyname, amt: r.docamt,
        })),
        ms: Date.now() - started,
      });
    }

    // Insert missing
    let inserted = 0;
    const errors = [];
    for (const r of missing) {
      try {
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
        inserted++;
      } catch (e) {
        errors.push({ dockey: r.dockey, docno: r.docno, error: e.message });
      }
    }

    const verify = await q(`
      SELECT COUNT(*) AS c, COALESCE(SUM(docamt::numeric), 0) AS total
      FROM sql_salesinvoices
      WHERE docdate >= '2026-04-01' AND (cancelled = false OR cancelled IS NULL)
    `);

    return res.status(200).json({
      pgBefore: pgCount, apiFetched: apiTotal,
      missingFound: missing.length, inserted,
      errors: errors.length > 0 ? errors : undefined,
      aprilAfter: {
        count: Number(verify.rows[0].c),
        total: Number(verify.rows[0].total).toFixed(2),
        target: '77 invoices / RM 203,683.25',
      },
      ms: Date.now() - started,
    });
  } catch (e) {
    console.error('fix-invoices error:', e);
    return res.status(500).json({ error: e.message });
  }
}
