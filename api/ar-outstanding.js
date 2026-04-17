// api/ar-outstanding.js
// Computes real AR outstanding from sql_salesinvoices + sql_receiptvouchers
// Your RV table has: dockey, docno, docdate, companyname, description,
//   docamt, paymentmethod, status, cancelled, gltransid, occ_synced_at, sql_raw
// The knockoff link is inside sql_raw (JSON) — field: knockoffkey / knockoffamt

import { Pool } from 'pg';

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
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query?.type || 'summary';

  try {

    // ── PER INVOICE OUTSTANDING ─────────────────────────────
    // Uses sql_raw->knockoff data to compute payments against each invoice
    if (type === 'invoices') {
      const { rows } = await q(`
        SELECT
          iv.dockey,
          iv.docno,
          iv.docdate::text AS docdate,
          iv.code          AS customer_code,
          iv.companyname,
          iv.docamt::numeric                                        AS total_amt,
          COALESCE(
            (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
             FROM sql_receiptvouchers rv,
                  jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
             WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
               AND rv.cancelled = false
            ), 0
          )                                                         AS total_paid,
          iv.docamt::numeric - COALESCE(
            (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
             FROM sql_receiptvouchers rv,
                  jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
             WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
               AND rv.cancelled = false
            ), 0
          )                                                         AS outstanding,
          DATE_PART('day', NOW() - iv.docdate::timestamp)::INTEGER  AS age_days
        FROM sql_salesinvoices iv
        WHERE iv.cancelled = false
        HAVING iv.docamt::numeric - COALESCE(
          (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
           FROM sql_receiptvouchers rv,
                jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
           WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
             AND rv.cancelled = false
          ), 0
        ) > 0
        ORDER BY iv.docdate DESC
        LIMIT 200
      `);
      return res.status(200).json({ invoices: rows, count: rows.length });
    }

    // ── AR AGING ────────────────────────────────────────────
    if (type === 'aging') {
      const { rows } = await q(`
        WITH outstanding AS (
          SELECT
            iv.code          AS customer_code,
            iv.companyname,
            DATE_PART('day', NOW() - iv.docdate::timestamp)::INTEGER AS age_days,
            iv.docamt::numeric - COALESCE(
              (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
               FROM sql_receiptvouchers rv,
                    jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
               WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
                 AND rv.cancelled = false
              ), 0
            ) AS outstanding
          FROM sql_salesinvoices iv
          WHERE iv.cancelled = false
        )
        SELECT
          customer_code,
          companyname,
          SUM(CASE WHEN age_days <= 0  THEN outstanding ELSE 0 END) AS current_amt,
          SUM(CASE WHEN age_days BETWEEN 1  AND 30  THEN outstanding ELSE 0 END) AS days_1_30,
          SUM(CASE WHEN age_days BETWEEN 31 AND 60  THEN outstanding ELSE 0 END) AS days_31_60,
          SUM(CASE WHEN age_days BETWEEN 61 AND 90  THEN outstanding ELSE 0 END) AS days_61_90,
          SUM(CASE WHEN age_days > 90 THEN outstanding ELSE 0 END) AS days_over_90,
          SUM(outstanding) AS total_outstanding
        FROM outstanding
        WHERE outstanding > 0
        GROUP BY customer_code, companyname
        ORDER BY total_outstanding DESC
      `);

      const totals = rows.reduce((acc, r) => ({
        current_amt:       acc.current_amt       + Number(r.current_amt),
        days_1_30:         acc.days_1_30         + Number(r.days_1_30),
        days_31_60:        acc.days_31_60        + Number(r.days_31_60),
        days_61_90:        acc.days_61_90        + Number(r.days_61_90),
        days_over_90:      acc.days_over_90      + Number(r.days_over_90),
        total_outstanding: acc.total_outstanding + Number(r.total_outstanding)
      }), { current_amt:0, days_1_30:0, days_31_60:0, days_61_90:0, days_over_90:0, total_outstanding:0 });

      return res.status(200).json({ aging: rows, totals, count: rows.length });
    }

    // ── DASHBOARD SUMMARY (default) ─────────────────────────
    const { rows } = await q(`
      SELECT
        COUNT(*)::INTEGER AS invoice_count,
        SUM(
          iv.docamt::numeric - COALESCE(
            (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
             FROM sql_receiptvouchers rv,
                  jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
             WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
               AND rv.cancelled = false
            ), 0
          )
        ) AS total_outstanding,
        SUM(CASE WHEN DATE_PART('day', NOW() - iv.docdate::timestamp) > 90
          THEN iv.docamt::numeric - COALESCE(
            (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
             FROM sql_receiptvouchers rv,
                  jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
             WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
               AND rv.cancelled = false
            ), 0
          ) ELSE 0 END
        ) AS overdue_90_plus
      FROM sql_salesinvoices iv
      WHERE iv.cancelled = false
        AND iv.docamt::numeric - COALESCE(
          (SELECT SUM((rv_detail->>'knockoffamt')::numeric)
           FROM sql_receiptvouchers rv,
                jsonb_array_elements(rv.sql_raw::jsonb->'sdsrv') AS rv_detail
           WHERE (rv_detail->>'knockoffkey')::integer = iv.dockey
             AND rv.cancelled = false
          ), 0
        ) > 0
    `);

    return res.status(200).json(rows[0]);

  } catch (err) {
    console.error('AR outstanding error:', err.message);
    // Fallback — try simpler query without json parsing
    try {
      const { rows } = await q(`
        SELECT
          COUNT(*)::INTEGER AS invoice_count,
          SUM(iv.docamt::numeric) AS total_outstanding,
          0 AS overdue_90_plus,
          'fallback_no_rv_join' AS note
        FROM sql_salesinvoices iv
        WHERE iv.cancelled = false
      `);
      return res.status(200).json({ ...rows[0], error_detail: err.message });
    } catch(e2) {
      return res.status(500).json({ error: err.message });
    }
  }
}
