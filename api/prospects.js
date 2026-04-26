// api/prospects.js
// OCC — Prospects, CRM, and Document Data
//
// SQL Account data (SO, DO, INV, RV) → reads from Postgres, normalised to Redis field names
// OCC-native data (prospects, deals, po_intake, bom) → reads from Redis

import { createClient } from 'redis';
import { Pool } from 'pg';

const PROSPECTS_KEY = 'mazza_prospects';
const DEALS_KEY     = 'mazza_deals';

// ── REDIS ─────────────────────────────────────────────────────
async function getRedisClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

// ── POSTGRES ──────────────────────────────────────────────────
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

// ── STATUS NORMALISATION ──────────────────────────────────────
function normaliseSoStatus(row) {
  if (row.cancelled) return 'Cancelled';
  const note = (row.docref3 || '').toUpperCase().trim();
  if (note === 'DONE' || note.startsWith('DONE')) return 'Done';
  return 'Active';
}

// ── POSTGRES QUERIES ──────────────────────────────────────────

async function getSalesOrders() {
  const r = await q(`
    SELECT
      so.dockey,
      so.docno,
      so.docdate::text                  AS docdate,
      so.code                           AS customercode,
      so.companyname,
      so.docamt::numeric                AS docamt,
      so.status,
      so.cancelled,
      so.docref1,
      so.docref2,
      so.docref3,
      so.agent,
      so.occ_synced_at,
      COALESCE(
        json_agg(
          json_build_object(
            'dtlkey',      sol.dtlkey,
            'itemcode',    sol.itemcode,
            'description', sol.description,
            'qty',         sol.qty::numeric,
            'offsetqty',   sol.offsetqty::numeric,
            'balance',     GREATEST(0, sol.qty::numeric - sol.offsetqty::numeric),
            'unitprice',   sol.unitprice::numeric,
            'amount',      sol.amount::numeric,
            'uom',         sol.uom,
            'deliverydate', sol.deliverydate::text
          ) ORDER BY sol.seq
        ) FILTER (WHERE sol.dtlkey IS NOT NULL),
        '[]'
      ) AS lines
    FROM sql_salesorders so
    LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey
    WHERE so.cancelled = false
      AND (so.docref3 IS NULL OR UPPER(TRIM(so.docref3)) != 'DONE')
    GROUP BY
      so.dockey, so.docno, so.docdate, so.code, so.companyname,
      so.docamt, so.status, so.cancelled, so.docref1, so.docref2,
      so.docref3, so.agent, so.occ_synced_at
    ORDER BY so.docdate DESC, so.dockey DESC
  `);

  return r.rows.map(row => ({
    dockey:          row.dockey,
    id:              row.docno,
    docNo:           row.docno,
    date:            row.docdate ? row.docdate.slice(0,10) : null,
    customer:        row.companyname,
    companyname:     row.companyname,
    customerCode:    row.customercode,
    amount:          parseFloat(row.docamt) || 0,
    status:          normaliseSoStatus(row),
    statusRaw:       row.status,
    cancelled:       row.cancelled,
    poRef:           row.docref1 || null,
    delivery:        row.docref2 || null,
    deliveryDateRef: row.docref2 || null,
    statusNote:      row.docref3 || null,
    agent:           row.agent || null,
    lastModified:    row.occ_synced_at ? new Date(row.occ_synced_at).getTime() / 1000 : null,
    lines:           row.lines || [],
  }));
}

// ── FIX: outstanding computed from sql_customers.outstanding ──
// SQL Account maintains customer.outstanding in real time as payments
// are received. We prorate it across the customer's invoices by amount.
// This replaces the previous hardcoded outstanding: 0.
async function getSalesInvoices() {
  const r = await q(`
    SELECT
      iv.dockey,
      iv.docno,
      iv.docdate::text                       AS docdate,
      iv.code                                AS customercode,
      iv.companyname,
      iv.docamt::numeric                     AS docamt,
      iv.status,
      iv.cancelled,
      iv.docref1,
      iv.docref2,
      iv.terms,
      iv.occ_synced_at,
      COALESCE(c.outstanding::numeric, 0)    AS customer_outstanding,
      SUM(iv2.docamt::numeric) OVER (PARTITION BY iv.code) AS customer_total_invoiced
    FROM sql_salesinvoices iv
    LEFT JOIN sql_customers c ON c.code = iv.code
    LEFT JOIN sql_salesinvoices iv2
      ON iv2.code = iv.code AND iv2.cancelled = false
    WHERE iv.cancelled = false
    ORDER BY iv.docdate DESC, iv.dockey DESC
    LIMIT 500
  `);

  return r.rows.map(row => {
    const amount              = parseFloat(row.docamt) || 0;
    const customerOutstanding = parseFloat(row.customer_outstanding) || 0;
    const customerTotal       = parseFloat(row.customer_total_invoiced) || 0;

    // Prorate customer outstanding across their invoices by invoice share
    let outstanding = 0;
    if (customerOutstanding > 0 && customerTotal > 0 && amount > 0) {
      outstanding = Math.min(amount, (amount / customerTotal) * customerOutstanding);
      outstanding = Math.round(outstanding * 100) / 100;
    }

    // Due date from terms
    let dueDate = null;
    if (row.docdate) {
      const d = new Date(row.docdate);
      const t = (row.terms || '').toLowerCase();
      if      (t.includes('90'))                        d.setDate(d.getDate() + 90);
      else if (t.includes('60'))                        d.setDate(d.getDate() + 60);
      else if (t.includes('30'))                        d.setDate(d.getDate() + 30);
      else if (t.includes('14'))                        d.setDate(d.getDate() + 14);
      else if (t.includes('cod') || t.includes('c.o.d')) outstanding = 0;
      else                                              d.setDate(d.getDate() + 30);
      dueDate = d.toISOString().slice(0, 10);
    }

    // Status
    let status = 'Invoiced';
    if (row.cancelled)         status = 'Cancelled';
    else if (outstanding <= 0) status = 'Paid';
    else if (dueDate && new Date(dueDate) < new Date()) status = 'Overdue';

    return {
      dockey:     row.dockey,
      id:         row.docno,
      date:       row.docdate ? row.docdate.slice(0, 10) : null,
      customer:   row.companyname,
      code:       row.customercode,
      amount,
      outstanding,
      dueDate,
      status,
      cancelled:  row.cancelled,
      soRef:      row.docref1 || null,
      terms:      row.terms,
      lastSynced: row.occ_synced_at,
    };
  });
}

async function getDeliveryOrders() {
  const r = await q(`
    SELECT
      dockey,
      docno,
      docdate::text AS docdate,
      code          AS customercode,
      companyname,
      docamt::numeric AS docamt,
      status,
      cancelled,
      docref1,
      docref2,
      occ_synced_at
    FROM sql_deliveryorders
    WHERE cancelled = false
    ORDER BY docdate DESC, dockey DESC
    LIMIT 500
  `);

  return r.rows.map(row => ({
    dockey:     row.dockey,
    id:         row.docno,
    date:       row.docdate ? row.docdate.slice(0,10) : null,
    customer:   row.companyname,
    code:       row.customercode,
    amount:     parseFloat(row.docamt) || 0,
    cancelled:  row.cancelled,
    soRef:      row.docref1 || null,
    lastSynced: row.occ_synced_at,
  }));
}

async function getReceiptVouchers() {
  const r = await q(`
    SELECT
      dockey,
      docno,
      docdate::text AS docdate,
      companyname,
      description,
      docamt::numeric AS docamt,
      paymentmethod,
      status,
      cancelled,
      gltransid,
      occ_synced_at
    FROM sql_receiptvouchers
    WHERE cancelled = false
    ORDER BY docdate DESC, dockey DESC
    LIMIT 500
  `);

  return r.rows.map(row => ({
    dockey:        row.dockey,
    id:            row.docno,
    date:          row.docdate ? row.docdate.slice(0,10) : null,
    customer:      row.companyname || row.description,
    description:   row.description,
    amount:        parseFloat(row.docamt) || 0,
    paymentmethod: row.paymentmethod,
    cancelled:     row.cancelled,
    gltransid:     row.gltransid,
    lastSynced:    row.occ_synced_at,
  }));
}

async function getCustomers() {
  const r = await q(`
    SELECT
      code,
      companyname,
      creditterm,
      creditlimit::numeric AS creditlimit,
      outstanding::numeric AS outstanding,
      status,
      area,
      synced_at AS lastSynced
    FROM sql_customers
    ORDER BY companyname
  `);
  return r.rows.map(row => ({
    code:        row.code,
    name:        row.companyname,
    companyname: row.companyname,
    creditterm:  row.creditterm,
    creditlimit: parseFloat(row.creditlimit) || 0,
    outstanding: parseFloat(row.outstanding) || 0,
    status:      row.status,
    area:        row.area,
    lastSynced:  row.lastsynced,
  }));
}

async function getStockItems() {
  const r = await q(`
    SELECT
      code,
      description,
      stockgroup,
      defuom_st AS uom_code,
      isactive,
      balsqty::numeric AS balsqty,
      synced_at AS lastSynced
    FROM sql_stockitems
    ORDER BY code
  `);
  return r.rows.map(row => ({
    code:        row.code,
    description: row.description,
    name:        row.description,
    stockgroup:  row.stockgroup,
    uom_code:    row.uom_code,
    isactive:    row.isactive,
    balsqty:     parseFloat(row.balsqty) || 0,
    lastSynced:  row.lastsynced,
  }));
}

async function getSyncStatus() {
  const r = await q(`
    SELECT sync_type, status, completed_at, records_fetched, records_upserted
    FROM occ_sync_log
    WHERE id IN (
      SELECT MAX(id) FROM occ_sync_log GROUP BY sync_type
    )
    ORDER BY sync_type
  `);
  return r.rows;
}

// ── MAIN HANDLER ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query?.type;

  // ── V2 dispatch ─────────────────────────────────────────────
  // New OCC v2 UI section endpoints. Return immediately if matched.
  if (req.method === 'GET') {
    const v2Types = new Set([
      'overview', 'ar_overview', 'customers', 'so_lifecycle',
      'pipeline', 'analytics', 'comparison', 'comparison_detail', 'comparison_brief', 'top_products',
      'document_tracker',
      'production_overview', 'production_brief', 'production_queue', 'production_gap', 'production_purchase',
    ]);
    if (v2Types.has(type)) {
      const result = await handleV2Type(req, res, type);
      if (result !== null) return result;
    }
  }

  if (req.method === 'GET') {

    if (type === 'so') {
      try {
        const [soList, ivList, doList, rvList, syncStatus] = await Promise.all([
          getSalesOrders(),
          getSalesInvoices(),
          getDeliveryOrders(),
          getReceiptVouchers(),
          getSyncStatus(),
        ]);
        const soSync  = syncStatus.find(s => s.sync_type === 'SALESORDERS');
        const updated = soSync?.completed_at?.toISOString() ?? new Date().toISOString();
        return res.status(200).json({ so: soList, invoice: ivList, dos: doList, rv: rvList, updated, source: 'postgres' });
      } catch(e) {
        console.error('prospects so error:', e.message);
        const client = await getRedisClient();
        try {
          const [soRaw, ivRaw, doRaw, rvRaw, updatedRaw] = await Promise.all([
            client.get('mazza_so'), client.get('mazza_invoice'),
            client.get('mazza_do'), client.get('mazza_rv'), client.get('mazza_so_updated'),
          ]);
          return res.status(200).json({
            so:      soRaw  ? JSON.parse(soRaw)  : [],
            invoice: ivRaw  ? JSON.parse(ivRaw)  : [],
            dos:     doRaw  ? JSON.parse(doRaw)  : [],
            rv:      rvRaw  ? JSON.parse(rvRaw)  : [],
            updated: updatedRaw || null,
            source:  'redis_fallback',
          });
        } finally { await client.disconnect(); }
      }
    }

    if (type === 'master') {
      try {
        const [customers, stockitems] = await Promise.all([ getCustomers(), getStockItems() ]);
        return res.status(200).json({ customers, stockitems, source: 'postgres' });
      } catch(e) {
        console.error('prospects master error:', e.message);
        const client = await getRedisClient();
        try {
          const [custRaw, itemsRaw] = await Promise.all([
            client.get('mazza_customers'), client.get('mazza_stockitems'),
          ]);
          return res.status(200).json({
            customers:  custRaw  ? JSON.parse(custRaw)  : [],
            stockitems: itemsRaw ? JSON.parse(itemsRaw) : [],
            source: 'redis_fallback',
          });
        } finally { await client.disconnect(); }
      }
    }

    const client = await getRedisClient();
    try {

      if (type === 'deals') {
        const data = await client.get(DEALS_KEY);
        return res.status(200).json({ deals: data ? JSON.parse(data) : [] });
      }

      if (type === 'so_legacy') {
        const [so, invoice, rv, po, catmap, updated] = await Promise.all([
          client.get('mazza_so'), client.get('mazza_invoice'), client.get('mazza_rv'),
          client.get('mazza_po'), client.get('mazza_catmap'), client.get('mazza_so_updated'),
        ]);
        return res.status(200).json({
          so:      so      ? JSON.parse(so)      : [],
          invoice: invoice ? JSON.parse(invoice) : [],
          rv:      rv      ? JSON.parse(rv)      : [],
          po:      po      ? JSON.parse(po)      : [],
          catmap:  catmap  ? JSON.parse(catmap)  : { spices:0, oil:0, flour:0, rawmat:0 },
          updated: updated || null,
        });
      }

      if (type === 'trigger_master_sync') {
        try {
          const syncUrl = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}/api/sync-master`
            : 'http://localhost:3000/api/sync-master';
          const r = await fetch(syncUrl, { method: 'GET' });
          return res.status(200).json(await r.json());
        } catch(e) { return res.status(500).json({ error: e.message }); }
      }

      if (type === 'po_intake_list') {
        const data = await client.get('mazza_po_intake');
        return res.status(200).json({ list: data ? JSON.parse(data) : [] });
      }

      if (type === 'po_list') {
        const raw = await client.get('mazza_po');
        const pos = raw ? JSON.parse(raw) : [];
        function poStatus(p) {
          const s = p.status;
          if (s === 1   || s === 'Complete' || s === 'Closed') return { label:'Complete', pct:100 };
          if (s === -10 || s === 'Cancelled' || p.cancelled)   return { label:'Cancelled', pct:100 };
          if (s === -1  || s === 'Partial')                    return { label:'Partial',   pct:50  };
          return { label:'Open', pct:0 };
        }
        return res.status(200).json({ pos: pos.map(p => {
          const st = poStatus(p);
          return { id: p.id, supplier: p.supplier, date: p.date, amount: p.amount,
            status: st.label, cancelled: p.cancelled || p.status === -10,
            deliveryDate: p.delivery || null, itemCount: p.itemCount || null, offsetPct: st.pct };
        })});
      }

      if (type === 'pv_list') {
        const raw = await client.get('mazza_pv');
        const pvs = raw ? JSON.parse(raw) : [];
        if (!pvs.length) {
          const rvs = JSON.parse(await client.get('mazza_rv') || '[]');
          return res.status(200).json({ pvs: rvs.map(r => ({
            id: r.id, description: r.customer, date: r.date, amount: r.amount,
            paymentMethod: '—', journal: '—', cancelled: false,
          }))});
        }
        return res.status(200).json({ pvs });
      }

      if (type === 'grn_history') {
        const raw = await client.get('mazza_grn_history');
        return res.status(200).json({ list: raw ? JSON.parse(raw) : [] });
      }

      if (type === 'pending_grns') {
        const raw = await client.get('mazza_grn_pending');
        const all = raw ? JSON.parse(raw) : [];
        return res.status(200).json({ grns: all.filter(g => !g.approved) });
      }

      if (type === 'bom') {
        const data = await client.get('mazza_bom');
        return res.status(200).json({ bom: data ? JSON.parse(data) : {} });
      }

      if (type === 'demand') {
        const [dos, po, updated] = await Promise.all([
          client.get('mazza_do'), client.get('mazza_po'), client.get('mazza_so_updated'),
        ]);
        return res.status(200).json({
          dos: dos ? JSON.parse(dos) : [], pos: po ? JSON.parse(po) : [], updated: updated || null,
        });
      }

      const data = await client.get(PROSPECTS_KEY);
      return res.status(200).json({ prospects: data ? JSON.parse(data) : null });

    } finally { await client.disconnect(); }
  }

  if (req.method === 'POST') {
    const client = await getRedisClient();
    try {
      const { prospects, deals, po } = req.body;
      if (po !== undefined) {
        const existing = await client.get('mazza_po_intake');
        const list = existing ? JSON.parse(existing) : [];
        list.unshift(po);
        await client.set('mazza_po_intake', JSON.stringify(list.slice(0, 200)));
        return res.status(200).json({ success: true, id: po.id });
      }
      if (deals !== undefined) {
        await client.set(DEALS_KEY, JSON.stringify(deals));
        return res.status(200).json({ success: true });
      }
      if (!prospects || !Array.isArray(prospects)) return res.status(400).json({ error: 'Invalid data' });
      await client.set(PROSPECTS_KEY, JSON.stringify(prospects));
      return res.status(200).json({ success: true });
    } finally { await client.disconnect(); }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ═══════════════════════════════════════════════════════════════
// ── V2 ENDPOINT HANDLERS ──────────────────────────────────────
// Appended to support new OCC v2 UI sections. Called via ?type= query.
// All handlers query Postgres directly; no Redis dependency for these.
// ═══════════════════════════════════════════════════════════════

// Helper: parse ?days= query param, clamp to [1, 730]
function parseDays(req, fallback = 90) {
  const n = parseInt(req.query?.days, 10);
  if (!isFinite(n) || n < 1) return fallback;
  return Math.min(n, 730);
}

// Returns { sql, params } for date filtering
// Uses exact fromDate when provided (calendar month precision)
// Falls back to CURRENT_DATE - days when not
function buildDateFilter(req, dateCol = 'docdate', paramOffset = 0) {
  const from = req.query?.from; // YYYY-MM-DD
  const to = req.query?.to;     // YYYY-MM-DD (optional upper bound)
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      // Both from and to — bounded range (e.g. "Last Month March")
      return {
        sql: `${dateCol}::date >= $${paramOffset + 1}::date AND ${dateCol}::date <= $${paramOffset + 2}::date`,
        params: [from, to],
        fromDate: from,
        toDate: to,
      };
    }
    // Only from — open-ended (e.g. "This Month April" = April 1st onwards)
    return {
      sql: `${dateCol}::date >= $${paramOffset + 1}::date`,
      params: [from],
      fromDate: from,
    };
  }
  const days = parseDays(req);
  return {
    sql: `${dateCol}::date >= CURRENT_DATE - $${paramOffset + 1}::int`,
    params: [days],
    fromDate: null,
  };
}

// Sales Overview — KPIs, 3-bucket trend, top customers, recent SOs, comparison summary
async function handleOverview(req, res) {
  const days = parseDays(req);
  const df = buildDateFilter(req);
  // df.sql = "docdate::date >= $1::date" or "docdate::date >= CURRENT_DATE - $1::int"
  // df.params = ["2026-04-01"] or [19]

  try {
    // KPIs over the window — invoiced from sql_salesinvoices
    const kpiRes = await q(
      `SELECT COALESCE(SUM(docamt::numeric), 0) AS invoiced, COUNT(*)::int AS invoice_count
       FROM sql_salesinvoices
       WHERE ${df.sql} AND (cancelled = false OR cancelled IS NULL)`,
      df.params
    );
    // Collected from sql_receiptvouchers
    const colRes = await q(
      `SELECT COALESCE(SUM(docamt::numeric), 0) AS collected
       FROM sql_receiptvouchers
       WHERE ${df.sql} AND (cancelled = false OR cancelled IS NULL)`,
      df.params
    );
    const invoiced = Number(kpiRes.rows[0]?.invoiced || 0);
    const collected = Number(colRes.rows[0]?.collected || 0);

    // AR outstanding = SUM(sql_customers.outstanding)
    const arRes = await q(
      `SELECT COALESCE(SUM(outstanding::numeric), 0) AS total_ar,
              COUNT(*) FILTER (WHERE outstanding::numeric > 0) AS ar_count
       FROM sql_customers`
    );
    const arOutstanding = Number(arRes.rows[0]?.total_ar || 0);

    // Previous period for deltas
    const prevRes = await q(
      `SELECT COALESCE(SUM(docamt::numeric), 0) AS invoiced
       FROM sql_salesinvoices
       WHERE docdate >= CURRENT_DATE - ($1::int * 2)
         AND docdate <  CURRENT_DATE - $1::int
         AND (cancelled = false OR cancelled IS NULL)`,
      [days]
    );
    const prevColRes = await q(
      `SELECT COALESCE(SUM(docamt::numeric), 0) AS collected
       FROM sql_receiptvouchers
       WHERE docdate >= CURRENT_DATE - ($1::int * 2)
         AND docdate <  CURRENT_DATE - $1::int
         AND (cancelled = false OR cancelled IS NULL)`,
      [days]
    );
    const prevInvoiced = Number(prevRes.rows[0]?.invoiced || 0);
    const prevCollected = Number(prevColRes.rows[0]?.collected || 0);
    const invTrendPct = prevInvoiced > 0 ? (((invoiced - prevInvoiced) / prevInvoiced) * 100).toFixed(1) : null;
    const colTrendPct = prevCollected > 0 ? (((collected - prevCollected) / prevCollected) * 100).toFixed(1) : null;

    // Monthly trend buckets (last 3 complete months)
    const trendInvRes = await q(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('month', docdate::date), 'Mon') AS label,
        DATE_TRUNC('month', docdate::date) AS month_start,
        SUM(docamt::numeric) AS invoiced
      FROM sql_salesinvoices
      WHERE docdate::date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'
        AND (cancelled = false OR cancelled IS NULL)
      GROUP BY month_start, label
      ORDER BY month_start ASC
      `
    );
    const trendColRes = await q(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('month', docdate::date), 'Mon') AS label,
        DATE_TRUNC('month', docdate::date) AS month_start,
        SUM(docamt::numeric) AS collected
      FROM sql_receiptvouchers
      WHERE docdate::date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'
        AND (cancelled = false OR cancelled IS NULL)
      GROUP BY month_start, label
      ORDER BY month_start ASC
      `
    );
    const colByMonth = {};
    for (const r of trendColRes.rows) colByMonth[r.label.trim()] = Number(r.collected || 0);
    const trend = trendInvRes.rows.map((r) => ({
      label: r.label.trim(),
      invoiced: Number(r.invoiced || 0),
      collected: colByMonth[r.label.trim()] || 0,
    }));

    // Top customers by revenue in the window
    const topRes = await q(
      `SELECT i.code AS code, i.companyname AS name, SUM(i.docamt::numeric) AS revenue
       FROM sql_salesinvoices i
       WHERE ${df.sql.replace('docdate', 'i.docdate')}
         AND (i.cancelled = false OR i.cancelled IS NULL)
         AND i.code IS NOT NULL
       GROUP BY i.code, i.companyname
       ORDER BY revenue DESC
       LIMIT 5`,
      df.params
    );
    const topCustomers = topRes.rows.map((r) => ({
      code: r.code,
      name: r.name,
      revenue: Number(r.revenue || 0),
    }));

    // Recent SOs (last 10 by date)
    const recentRes = await q(
      `
      SELECT
        so.docno,
        so.docdate AS date,
        so.companyname AS customer,
        so.docamt::numeric AS amount,
        so.cancelled,
        so.docref3
      FROM sql_salesorders so
      ORDER BY so.docdate DESC, so.docno DESC
      LIMIT 10
      `
    );
    const recentSOs = recentRes.rows.map((r) => ({
      docno: r.docno,
      date: r.date,
      customer: r.customer,
      amount: Number(r.amount || 0),
      status: r.cancelled
        ? 'cancelled'
        : String(r.docref3 || '').toUpperCase().trim() === 'DONE'
        ? 'complete'
        : 'active',
    }));

    // Comparison summary — current month vs previous month (calendar-based)
    const cmpRes = await q(
      `
      SELECT
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month', docdate::date) = DATE_TRUNC('month', CURRENT_DATE) THEN docamt::numeric ELSE 0 END), 0) AS curr,
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month', docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' THEN docamt::numeric ELSE 0 END), 0) AS prev
      FROM sql_salesinvoices
      WHERE docdate::date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND (cancelled = false OR cancelled IS NULL)
      `
    );
    const cmpCurr = Number(cmpRes.rows[0]?.curr || 0);
    const cmpPrev = Number(cmpRes.rows[0]?.prev || 0);
    const cmpDelta = cmpCurr - cmpPrev;
    const cmpPct = cmpPrev > 0 ? (((cmpDelta) / cmpPrev) * 100).toFixed(1) : null;

    // "What changed" summary
    const whatChanged = [];
    if (invTrendPct != null) {
      whatChanged.push({
        text: 'Revenue',
        value: `${invTrendPct > 0 ? '+' : ''}${invTrendPct}%`,
        color: Number(invTrendPct) >= 0 ? '#10B981' : '#EF4444',
      });
    }
    if (colTrendPct != null) {
      whatChanged.push({
        text: 'Collected',
        value: `${colTrendPct > 0 ? '+' : ''}${colTrendPct}%`,
        color: Number(colTrendPct) >= 0 ? '#10B981' : '#EF4444',
      });
    }
    whatChanged.push({
      text: 'AR Outstanding',
      value: fmtRM(arOutstanding),
      color: '#EF4444',
    });

    return res.status(200).json({
      kpis: {
        invoiced,
        collected,
        arOutstanding,
        invoicedTrend: invTrendPct != null ? `${invTrendPct > 0 ? '+' : ''}${invTrendPct}%` : null,
        collectedTrend: colTrendPct != null ? `${colTrendPct > 0 ? '+' : ''}${colTrendPct}%` : null,
      },
      trend,
      topCustomers,
      recentSOs,
      comparison: {
        current: cmpCurr,
        previous: cmpPrev,
        delta: cmpDelta,
        deltaPct: cmpPct != null ? `${cmpPct > 0 ? '+' : ''}${cmpPct}% vs last month` : 'No prior data',
      },
      whatChanged,
      source: 'postgres',
    });
  } catch (e) {
    console.error('overview error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function fmtRM(n) {
  return `RM ${Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// AR Overview
async function handleAROverview(req, res) {
  const days = parseDays(req);
  const df = buildDateFilter(req);
  try {
    // Total AR — from sql_customers (source of truth)
    const arRes = await q(
      `SELECT
         COALESCE(SUM(outstanding::numeric), 0) AS total,
         COUNT(*) FILTER (WHERE outstanding::numeric > 0) AS customers_with_ar
       FROM sql_customers`
    );
    const totalAR = Number(arRes.rows[0]?.total || 0);

    // Invoice-level aging — uses customer outstanding prorated across their invoices
    const agingRes = await q(
      `
      WITH inv AS (
        SELECT
          i.code,
          i.docdate,
          i.docamt::numeric AS docamt,
          CURRENT_DATE - i.docdate::date AS age_days
        FROM sql_salesinvoices i
        WHERE (i.cancelled = false OR i.cancelled IS NULL)
      ),
      totals AS (
        SELECT code, SUM(docamt) AS total_invoiced FROM inv GROUP BY code
      ),
      prorated AS (
        SELECT
          inv.age_days,
          (inv.docamt / NULLIF(t.total_invoiced, 0)) * c.outstanding::numeric AS prorated
        FROM inv
        JOIN totals t ON t.code = inv.code
        JOIN sql_customers c ON c.code = inv.code
        WHERE c.outstanding::numeric > 0
      ),
      bucketed AS (
        SELECT
          CASE
            WHEN age_days < 0 THEN 'Current'
            WHEN age_days <= 30 THEN '1-30d'
            WHEN age_days <= 60 THEN '31-60d'
            WHEN age_days <= 90 THEN '61-90d'
            ELSE '90d+'
          END AS bucket,
          prorated
        FROM prorated
      )
      SELECT
        bucket AS label,
        COALESCE(SUM(prorated), 0) AS amount
      FROM bucketed
      GROUP BY bucket
      ORDER BY
        CASE bucket
          WHEN 'Current' THEN 1
          WHEN '1-30d' THEN 2
          WHEN '31-60d' THEN 3
          WHEN '61-90d' THEN 4
          ELSE 5
        END
      `
    );
    const aging = agingRes.rows.map((r) => ({
      label: r.label,
      amount: Number(r.amount || 0),
    }));

    // Top overdue accounts — customers with largest outstanding, highest aging
    const overdueRes = await q(
      `
      WITH latest AS (
        SELECT code, MAX(docdate) AS last_inv
        FROM sql_salesinvoices
        WHERE (cancelled = false OR cancelled IS NULL)
        GROUP BY code
      )
      SELECT
        c.companyname AS customer,
        c.outstanding::numeric AS amount,
        COALESCE(CURRENT_DATE - l.last_inv::date, 0) AS days
      FROM sql_customers c
      LEFT JOIN latest l ON l.code = c.code
      WHERE c.outstanding::numeric > 0
      ORDER BY c.outstanding::numeric DESC
      LIMIT 5
      `
    );
    const overdue = overdueRes.rows.map((r) => ({
      customer: r.customer,
      amount: Number(r.amount || 0),
      days: Number(r.days || 0),
    }));

    const overdueAmt = aging
      .filter((b) => b.label !== 'Current' && b.label !== '1-30d')
      .reduce((s, b) => s + b.amount, 0);

    const overdueCount = agingRes.rows.length > 0
      ? (await q(`SELECT COUNT(*)::int AS c FROM sql_customers WHERE outstanding::numeric > 0`)).rows[0].c
      : 0;

    // Collected this period
    const collectedRes = await q(
      `SELECT COALESCE(SUM(docamt::numeric), 0) AS collected
       FROM sql_receiptvouchers
       WHERE ${df.sql}
         AND (cancelled = false OR cancelled IS NULL)`,
      df.params
    );
    const collected = Number(collectedRes.rows[0]?.collected || 0);

    // Previous period for collected trend
    const prevColRes = await q(
      `SELECT COALESCE(SUM(docamt::numeric), 0) AS collected
       FROM sql_receiptvouchers
       WHERE docdate >= CURRENT_DATE - ($1::int * 2)
         AND docdate <  CURRENT_DATE - $1::int
         AND (cancelled = false OR cancelled IS NULL)`,
      [days]
    );
    const prevCollected = Number(prevColRes.rows[0]?.collected || 0);
    const colTrendPct = prevCollected > 0 ? (((collected - prevCollected) / prevCollected) * 100).toFixed(1) : null;

    // Active SOs count
    const soRes = await q(
      `SELECT COUNT(*)::int AS c
       FROM sql_salesorders
       WHERE cancelled = false
         AND (docref3 IS NULL OR UPPER(TRIM(docref3)) != 'DONE')`
    );
    const activeSOs = Number(soRes.rows[0]?.c || 0);

    return res.status(200).json({
      kpis: {
        totalAR,
        overdue: overdueAmt,
        overdueCount,
        collected,
        collectedTrend: colTrendPct != null ? `${colTrendPct > 0 ? '+' : ''}${colTrendPct}%` : null,
        activeSOs,
      },
      aging,
      overdue,
      whatChanged: [
        {
          text: 'AR movement',
          value: colTrendPct != null ? `${colTrendPct > 0 ? '+' : ''}${colTrendPct}%` : '—',
          color: Number(colTrendPct) >= 0 ? '#10B981' : '#EF4444',
        },
        { text: 'Customers with AR', value: String(overdueCount), color: '#EF4444' },
      ],
      source: 'postgres',
    });
  } catch (e) {
    console.error('ar_overview error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Customer AR Breakdown table
async function handleCustomersList(req, res) {
  try {
    const r = await q(
      `
      WITH inv_totals AS (
        SELECT code, SUM(docamt::numeric) AS total_invoiced
        FROM sql_salesinvoices
        WHERE (cancelled = false OR cancelled IS NULL)
        GROUP BY code
      ),
      last_payment AS (
        SELECT companyname, MAX(docdate) AS last_paid
        FROM sql_receiptvouchers
        WHERE (cancelled = false OR cancelled IS NULL)
        GROUP BY companyname
      )
      SELECT
        c.code,
        c.companyname AS name,
        COALESCE(t.total_invoiced, 0) AS total_invoiced,
        COALESCE(c.outstanding::numeric, 0) AS outstanding,
        lp.last_paid,
        COALESCE(CURRENT_DATE - lp.last_paid::date, 9999) AS days_since_payment
      FROM sql_customers c
      LEFT JOIN inv_totals t ON t.code = c.code
      LEFT JOIN last_payment lp ON lp.companyname = c.companyname
      ORDER BY COALESCE(c.outstanding::numeric, 0) DESC, c.companyname ASC
      `
    );
    const customers = r.rows.map((row) => ({
      code: row.code,
      name: row.name,
      totalInvoiced: Number(row.total_invoiced || 0),
      outstanding: Number(row.outstanding || 0),
      lastPayment: row.last_paid,
      daysSincePayment: Number(row.days_since_payment || 0),
    }));
    return res.status(200).json({ customers, source: 'postgres' });
  } catch (e) {
    console.error('customers error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// SO Lifecycle table
async function handleSOLifecycle(req, res) {
  const days = parseDays(req, 180);
  try {
    const r = await q(
      `
      SELECT
        so.dockey,
        so.docno,
        so.docdate AS date,
        so.code,
        so.companyname AS customer,
        so.docamt::numeric AS amount,
        so.cancelled,
        so.docref1,
        so.docref3,
        so.docref4,
        MIN(sol.deliverydate) AS delivery_date,
        SUM(sol.qty::numeric) AS total_qty,
        SUM(COALESCE(sol.offsetqty::numeric, 0)) AS delivered_qty
      FROM sql_salesorders so
      LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey
      WHERE so.docdate >= CURRENT_DATE - $1::int
      GROUP BY so.dockey, so.docno, so.docdate, so.code, so.companyname, so.docamt, so.cancelled, so.docref1, so.docref3, so.docref4
      ORDER BY so.docdate DESC
      LIMIT 500
      `,
      [days]
    );
    const sos = r.rows.map((row) => {
      const ref3 = String(row.docref3 || '').toUpperCase().trim();
      const ref4 = String(row.docref4 || '').toUpperCase().trim();
      let status = 'active';
      if (row.cancelled || ref3 === 'CANCELLED') status = 'cancelled';
      else if (ref3.startsWith('DONE') || ref4.includes('INVOICED')) status = 'complete';
      else if (ref3.startsWith('PARTIAL')) status = 'partial';
      else if (Number(row.delivered_qty) > 0 && Number(row.delivered_qty) < Number(row.total_qty))
        status = 'partial';

      // Sanity check: if delivery date is before SO date, it's a data entry error — ignore it
      let deliveryDate = row.delivery_date;
      if (deliveryDate && row.date && new Date(deliveryDate) < new Date(row.date)) {
        deliveryDate = null; // treat as no delivery date
      }

      return {
        dockey: row.dockey,
        docno: row.docno,
        date: row.date,
        customerCode: row.code,
        customer: row.customer,
        amount: Number(row.amount || 0),
        poRef: row.docref1 || null,
        deliveryDate,
        status,
      };
    });
    return res.status(200).json({ sos, source: 'postgres' });
  } catch (e) {
    console.error('so_lifecycle error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Sales Pipeline — reads prospects from Redis
async function handlePipeline(req, res) {
  try {
    const client = await getRedisClient();
    try {
      const raw = await client.get(PROSPECTS_KEY);
      const prospects = raw ? JSON.parse(raw) : [];
      // Normalise shape — upstream prospects may have various field names
      const normalised = prospects.map((p) => ({
        id: p.id || p.name,
        name: p.name || p.company || 'Unknown',
        industry: p.industry || p.sector || '',
        stage: (p.stage || p.status || 'cold').toLowerCase(),
        value: Number(p.value || p.deal_value || 0),
        agent: p.agent || p.owner || '',
      }));
      return res.status(200).json({ prospects: normalised, source: 'redis' });
    } finally {
      await client.disconnect();
    }
  } catch (e) {
    console.error('pipeline error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Sales Analytics — agent performance + product mix + margins
async function handleAnalytics(req, res) {
  const days = parseDays(req);
  const df = buildDateFilter(req, 'so.docdate');
  const from = req.query?.from;
  const to = req.query?.to;

  // Build consistent date SQL for queries that don't use buildDateFilter
  // These need to work with BOTH days-based and from-based filtering
  let periodSql, periodParams;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      periodSql = `docdate::date >= $1::date AND docdate::date <= $2::date`;
      periodParams = [from, to];
    } else {
      periodSql = `docdate::date >= $1::date`;
      periodParams = [from];
    }
  } else {
    periodSql = `docdate::date >= CURRENT_DATE - $1::int`;
    periodParams = [days];
  }

  try {
    // Agent performance — uses buildDateFilter for SO-based query
    const agentRes = await q(
      `SELECT COALESCE(so.agent, 'Unassigned') AS name, COUNT(*)::int AS orders, SUM(so.docamt::numeric) AS revenue
       FROM sql_salesorders so WHERE ${df.sql} AND so.cancelled = false
       GROUP BY COALESCE(so.agent, 'Unassigned') ORDER BY revenue DESC`, df.params
    );
    const agents = agentRes.rows.map((r) => ({ name: r.name, orders: Number(r.orders || 0), revenue: Number(r.revenue || 0) }));

    // Product mix with MARGIN DATA — selling from inv_lines, cost from pi_lines
    const invDf = buildDateFilter(req, 'si.docdate');
    const productRes = await q(
      `SELECT sol.itemcode AS code, COALESCE(MAX(sol.description), sol.itemcode) AS name,
              SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
       FROM sql_inv_lines sol JOIN sql_salesinvoices si ON si.dockey = sol.dockey
       WHERE ${invDf.sql} AND (si.cancelled = false OR si.cancelled IS NULL) AND sol.itemcode IS NOT NULL
       GROUP BY sol.itemcode ORDER BY revenue DESC LIMIT 20`, invDf.params
    );

    // Get purchase costs per item (average cost from purchase invoice lines)
    let costLookup = {};
    try {
      // Get purchase costs from PI lines (matched to stock items) + BOM ref costs
      const costRes = await q(
        `SELECT matched_itemcode AS itemcode, AVG(amount::numeric) AS avg_cost
         FROM sql_pi_lines
         WHERE matched_itemcode IS NOT NULL AND amount IS NOT NULL AND amount::numeric > 0
         GROUP BY matched_itemcode`
      );
      for (const r of costRes.rows) {
        costLookup[r.itemcode] = Number(r.avg_cost || 0);
      }
    } catch {}
    // Also pull BOM ref costs as fallback
    try {
      const bomCostRes = await q(
        `SELECT bh.finished_code AS itemcode, bh.ref_cost AS cost
         FROM occ_bom_headers bh WHERE bh.ref_cost > 0`
      );
      for (const r of bomCostRes.rows) {
        if (!costLookup[r.itemcode]) costLookup[r.itemcode] = Number(r.cost || 0);
      }
    } catch {}

    const products = productRes.rows.map((r) => {
      const revenue = Number(r.revenue || 0);
      const qty = Number(r.qty || 0);
      const sellingPrice = qty > 0 ? revenue / qty : 0;
      const costPrice = costLookup[r.code] || 0;
      const marginValue = costPrice > 0 ? (sellingPrice - costPrice) * qty : 0;
      const marginPct = costPrice > 0 && sellingPrice > 0 ? ((sellingPrice - costPrice) / sellingPrice * 100) : null;
      return {
        code: r.code, name: r.name, qty, revenue,
        sellingPrice: Math.round(sellingPrice * 100) / 100,
        costPrice: Math.round(costPrice * 100) / 100,
        marginValue: Math.round(marginValue * 100) / 100,
        marginPct: marginPct != null ? Math.round(marginPct * 10) / 10 : null,
      };
    });

    // Growth — current period vs same-length previous period
    let currentRev = 0, previousRev = 0;
    try {
      if (from) {
        // From-based: current = from..to, previous = same length before from
        const fromDate = new Date(from);
        const toDate = to ? new Date(to) : new Date();
        const periodDays = Math.ceil((toDate - fromDate) / 86400000);
        const prevFrom = new Date(fromDate);
        prevFrom.setDate(prevFrom.getDate() - periodDays);
        const fmtD = d => d.toISOString().slice(0, 10);

        const growthRes = await q(
          `SELECT
            COALESCE(SUM(CASE WHEN docdate::date >= $1::date AND docdate::date <= $2::date THEN docamt::numeric ELSE 0 END), 0) AS current,
            COALESCE(SUM(CASE WHEN docdate::date >= $3::date AND docdate::date < $1::date THEN docamt::numeric ELSE 0 END), 0) AS previous
           FROM sql_salesinvoices WHERE (cancelled = false OR cancelled IS NULL)`,
          [from, to || new Date().toISOString().slice(0, 10), fmtD(prevFrom)]
        );
        currentRev = Number(growthRes.rows[0]?.current || 0);
        previousRev = Number(growthRes.rows[0]?.previous || 0);
      } else {
        const growthRes = await q(
          `SELECT
            COALESCE(SUM(CASE WHEN docdate >= CURRENT_DATE - $1::int THEN docamt::numeric ELSE 0 END), 0) AS current,
            COALESCE(SUM(CASE WHEN docdate >= CURRENT_DATE - ($1::int * 2) AND docdate < CURRENT_DATE - $1::int THEN docamt::numeric ELSE 0 END), 0) AS previous
           FROM sql_salesinvoices WHERE (cancelled = false OR cancelled IS NULL)`, [days]
        );
        currentRev = Number(growthRes.rows[0]?.current || 0);
        previousRev = Number(growthRes.rows[0]?.previous || 0);
      }
    } catch (e) { console.error('growth query error:', e.message); }

    const growthPct = previousRev > 0 ? (((currentRev - previousRev) / previousRev) * 100).toFixed(1) : null;

    // Customer concentration — top 5 share
    let topCustomerShare = 0, topCustomers = [];
    try {
      const concRes = await q(
        `WITH rev AS (
          SELECT i.code, i.companyname AS name, SUM(i.docamt::numeric) AS r FROM sql_salesinvoices i
          WHERE ${periodSql.replace(/docdate/g, 'i.docdate')} AND (i.cancelled = false OR i.cancelled IS NULL) AND i.code IS NOT NULL
          GROUP BY i.code, i.companyname
        ), totals AS (SELECT SUM(r) AS total FROM rev)
        SELECT code, name, r AS revenue, COALESCE((SELECT total FROM totals), 0) AS total
        FROM rev ORDER BY r DESC LIMIT 5`,
        periodParams
      );
      topCustomers = concRes.rows.map(r => ({ code: r.code, name: r.name, revenue: Number(r.revenue || 0) }));
      const totalRev = Number(concRes.rows[0]?.total || 0);
      const top5Rev = topCustomers.reduce((s, c) => s + c.revenue, 0);
      topCustomerShare = totalRev > 0 ? Math.round((top5Rev / totalRev) * 100) : 0;
    } catch (e) { console.error('concentration query error:', e.message); }

    // Monthly revenue trend (last 6 months — always uses fixed lookback)
    let monthlyTrend = [];
    try {
      const trendRes = await q(
        `SELECT TO_CHAR(DATE_TRUNC('month', docdate::date), 'Mon') AS label,
                DATE_TRUNC('month', docdate::date) AS month,
                SUM(docamt::numeric) AS invoiced
         FROM sql_salesinvoices
         WHERE docdate >= CURRENT_DATE - INTERVAL '6 months' AND (cancelled = false OR cancelled IS NULL)
         GROUP BY DATE_TRUNC('month', docdate::date)
         ORDER BY month`
      );
      monthlyTrend = trendRes.rows.map(r => ({ label: r.label?.trim(), invoiced: Number(r.invoiced || 0) }));
    } catch (e) { console.error('trend query error:', e.message); }

    // New vs Repeat customers
    let newCustomers = 0, repeatCustomers = 0;
    try {
      const newRepeatRes = await q(
        `WITH period_customers AS (
          SELECT DISTINCT code FROM sql_salesinvoices
          WHERE ${periodSql} AND (cancelled = false OR cancelled IS NULL) AND code IS NOT NULL
        ),
        prior_customers AS (
          SELECT DISTINCT code FROM sql_salesinvoices
          WHERE docdate < ${from ? `$${periodParams.length + 1}::date` : `CURRENT_DATE - $${periodParams.length + 1}::int`} AND (cancelled = false OR cancelled IS NULL) AND code IS NOT NULL
        )
        SELECT
          COUNT(*) FILTER (WHERE pc.code IS NOT NULL AND pr.code IS NOT NULL) AS repeat_count,
          COUNT(*) FILTER (WHERE pc.code IS NOT NULL AND pr.code IS NULL) AS new_count
        FROM period_customers pc
        LEFT JOIN prior_customers pr ON pr.code = pc.code`,
        [...periodParams, from || days]
      );
      repeatCustomers = Number(newRepeatRes.rows[0]?.repeat_count || 0);
      newCustomers = Number(newRepeatRes.rows[0]?.new_count || 0);
    } catch (e) { console.error('new/repeat query error:', e.message); }

    const unassigned = agents.find(a => a.name === 'Unassigned');

    return res.status(200).json({
      agents,
      products,
      monthlyTrend,
      topCustomers,
      kpis: {
        growth: growthPct != null ? `${growthPct > 0 ? '+' : ''}${growthPct}%` : '—',
        currentRev,
        previousRev,
        topCustomerShare,
        totalCustomers: repeatCustomers + newCustomers,
        newCustomers,
        repeatCustomers,
        unassignedOrders: unassigned?.orders || 0,
        unassignedRevenue: unassigned?.revenue || 0,
        topProductRevenue: products[0]?.revenue || 0,
        topProductName: products[0]?.name || '—',
      },
      source: 'postgres',
    });
  } catch (e) {
    console.error('analytics error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Top Products — revenue from sales invoice lines, cost from purchase invoice lines, GP computed
async function handleTopProducts(req, res) {
  const days = parseDays(req);
  const df = buildDateFilter(req, 'si.docdate');
  try {
    // Revenue by product from sales invoice lines
    const revRes = await q(
      `
      SELECT
        sol.itemcode AS code,
        MAX(sol.description) AS name,
        MAX(sol.uom) AS uom,
        SUM(sol.qty::numeric) AS qty_sold,
        SUM(sol.amount::numeric) AS revenue,
        AVG(sol.unitprice::numeric) AS avg_sell_price
      FROM sql_inv_lines sol
      JOIN sql_salesinvoices si ON si.dockey = sol.dockey
      WHERE ${df.sql}
        AND (si.cancelled = false OR si.cancelled IS NULL)
        AND sol.itemcode IS NOT NULL
      GROUP BY sol.itemcode
      ORDER BY revenue DESC
      LIMIT 20
      `,
      [days]
    );

    // Purchase cost by product from purchase invoice lines (same period)
    let purchaseCosts = {};
    let hasCostData = false;
    try {
      const piDf = buildDateFilter(req, 'pi.docdate');
      const costRes = await q(
        `
        SELECT
          pil.itemcode AS code,
          SUM(pil.qty::numeric) AS qty_purchased,
          SUM(pil.amount::numeric) AS total_cost,
          AVG(pil.unitprice::numeric) AS avg_buy_price
        FROM sql_pi_lines pil
        JOIN sql_purchaseinvoices pi ON pi.dockey = pil.dockey
        WHERE ${piDf.sql}
          AND (pi.cancelled = false OR pi.cancelled IS NULL)
          AND pil.itemcode IS NOT NULL
        GROUP BY pil.itemcode
        `,
        piDf.params
      );
      for (const r of costRes.rows) {
        purchaseCosts[r.code] = {
          qtyPurchased: Number(r.qty_purchased || 0),
          totalCost: Number(r.total_cost || 0),
          avgBuyPrice: Number(r.avg_buy_price || 0),
        };
      }
      hasCostData = costRes.rows.length > 0;
    } catch (e) {
      // sql_pi_lines table may not exist yet — fall back to BOM data
      console.log('sql_pi_lines not available, trying BOM fallback:', e.message);
      try {
        const bomRes = await q(
          `SELECT bh.itemcode AS fg_code, SUM(bl.qty::numeric * bl.cost::numeric) AS unit_cost
           FROM occ_bom_headers bh JOIN occ_bom_lines bl ON bl.header_id = bh.id
           GROUP BY bh.itemcode`
        );
        for (const r of bomRes.rows) {
          purchaseCosts[r.fg_code] = {
            qtyPurchased: 0,
            totalCost: 0,
            avgBuyPrice: Number(r.unit_cost || 0),
            fromBom: true,
          };
        }
        hasCostData = bomRes.rows.length > 0;
      } catch (e2) {
        // No cost data at all
      }
    }

    const products = revRes.rows.map((r) => {
      const revenue = Number(r.revenue || 0);
      const qtySold = Number(r.qty_sold || 0);
      const cost = purchaseCosts[r.code];

      let totalCost = null;
      let avgBuyPrice = null;
      let gp = null;
      let gpPct = null;

      if (cost) {
        if (cost.fromBom) {
          // BOM fallback: unit cost × qty sold
          totalCost = cost.avgBuyPrice * qtySold;
          avgBuyPrice = cost.avgBuyPrice;
        } else {
          // Real purchase data: use actual purchase total for the period
          totalCost = cost.totalCost;
          avgBuyPrice = cost.avgBuyPrice;
        }
        gp = revenue - totalCost;
        gpPct = revenue > 0 ? ((gp / revenue) * 100).toFixed(1) : null;
      }

      return {
        code: r.code,
        name: r.name,
        uom: r.uom,
        qtySold,
        revenue,
        avgSellPrice: Number(r.avg_sell_price || 0),
        avgBuyPrice,
        totalCost,
        gp,
        gpPct,
        qtyPurchased: cost ? cost.qtyPurchased : null,
        costSource: cost ? (cost.fromBom ? 'bom' : 'purchase_invoice') : null,
      };
    });

    const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
    const totalCost = products.reduce((s, p) => s + (p.totalCost || 0), 0);
    const totalGP = totalRevenue - totalCost;
    const productsWithCost = products.filter((p) => p.totalCost != null).length;

    return res.status(200).json({
      products,
      totals: {
        revenue: totalRevenue,
        cost: hasCostData ? totalCost : null,
        gp: hasCostData ? totalGP : null,
        gpPct: hasCostData && totalRevenue > 0 ? ((totalGP / totalRevenue) * 100).toFixed(1) : null,
      },
      hasCostData,
      productsWithCost,
      note: hasCostData
        ? `Cost matched from purchase invoices for ${productsWithCost}/${products.length} products. GP = Sales Revenue - Purchase Cost for the same period.`
        : 'Purchase invoice lines not yet synced. Run /api/sync-pilines to populate cost data. GP will appear once purchase line data is available.',
      source: 'postgres',
    });
  } catch (e) {
    console.error('top_products error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// MoM Comparison — current month vs previous month for customers AND products
async function handleComparison(req, res) {
  try {
    // Customer comparison
    const custRes = await q(
      `
      WITH curr_month AS (
        SELECT code, companyname, SUM(docamt::numeric) AS amt
        FROM sql_salesinvoices
        WHERE DATE_TRUNC('month', docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
          AND (cancelled = false OR cancelled IS NULL)
          AND code IS NOT NULL
        GROUP BY code, companyname
      ),
      prev_month AS (
        SELECT code, companyname, SUM(docamt::numeric) AS amt
        FROM sql_salesinvoices
        WHERE DATE_TRUNC('month', docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND (cancelled = false OR cancelled IS NULL)
          AND code IS NOT NULL
        GROUP BY code, companyname
      )
      SELECT
        COALESCE(c.code, p.code) AS code,
        COALESCE(c.companyname, p.companyname) AS name,
        COALESCE(p.amt, 0) AS last,
        COALESCE(c.amt, 0) AS curr
      FROM curr_month c
      FULL OUTER JOIN prev_month p ON p.code = c.code
      ORDER BY COALESCE(c.amt, 0) DESC, COALESCE(p.amt, 0) DESC
      `
    );
    const customers = custRes.rows.map((r) => {
      const last = Number(r.last || 0);
      const curr = Number(r.curr || 0);
      let type = 'growing';
      if (last === 0 && curr > 0) type = 'new';
      else if (curr === 0 && last > 0) type = 'churned';
      else if (curr < last) type = 'declining';
      return { code: r.code, name: r.name, last, curr, type };
    });

    // Product comparison (by qty)
    const prodRes = await q(
      `
      WITH curr_month AS (
        SELECT sol.itemcode AS code, MAX(sol.description) AS name, MAX(sol.uom) AS uom,
               SUM(sol.qty::numeric) AS qty
        FROM sql_inv_lines sol
        JOIN sql_salesinvoices si ON si.dockey = sol.dockey
        WHERE DATE_TRUNC('month', si.docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
          AND (si.cancelled = false OR si.cancelled IS NULL)
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      ),
      prev_month AS (
        SELECT sol.itemcode AS code, MAX(sol.description) AS name, MAX(sol.uom) AS uom,
               SUM(sol.qty::numeric) AS qty
        FROM sql_inv_lines sol
        JOIN sql_salesinvoices si ON si.dockey = sol.dockey
        WHERE DATE_TRUNC('month', si.docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND (si.cancelled = false OR si.cancelled IS NULL)
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      )
      SELECT
        COALESCE(c.code, p.code) AS code,
        COALESCE(c.name, p.name) AS name,
        COALESCE(c.uom, p.uom, '') AS uom,
        COALESCE(p.qty, 0) AS last,
        COALESCE(c.qty, 0) AS curr
      FROM curr_month c
      FULL OUTER JOIN prev_month p ON p.code = c.code
      ORDER BY COALESCE(c.qty, 0) DESC, COALESCE(p.qty, 0) DESC
      `
    );
    const products = prodRes.rows.map((r) => {
      const last = Number(r.last || 0);
      const curr = Number(r.curr || 0);
      let type = 'growing';
      if (last === 0 && curr > 0) type = 'new';
      else if (curr === 0 && last > 0) type = 'churned';
      else if (curr < last) type = 'declining';
      return { code: r.code, name: r.name, uom: r.uom, last, curr, type };
    });

    const monthName = new Date().toLocaleString('en-MY', { month: 'long', year: 'numeric' });
    const prev = new Date();
    prev.setMonth(prev.getMonth() - 1);
    const prevName = prev.toLocaleString('en-MY', { month: 'long', year: 'numeric' });

    return res.status(200).json({
      title: `${monthName} vs ${prevName}`,
      customers,
      products,
      source: 'postgres',
      source_note: `${monthName} month-to-date vs full ${prevName}`,
    });
  } catch (e) {
    console.error('comparison error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Comparison Detail — SOs per customer for both months (expandable rows)
async function handleComparisonDetail(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code parameter required' });

  try {
    const currSOs = await q(
      `SELECT so.docno, so.docdate, so.docamt::numeric AS amount, so.companyname AS customer,
              so.cancelled, so.docref3,
              CASE WHEN so.cancelled = true THEN 'cancelled'
                   WHEN UPPER(COALESCE(so.docref3,'')) = 'DONE' THEN 'complete'
                   ELSE 'active' END AS status
       FROM sql_salesorders so
       WHERE so.code = $1
         AND DATE_TRUNC('month', so.docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
         AND (so.cancelled = false OR so.cancelled IS NULL)
       ORDER BY so.docdate DESC, so.docno DESC`,
      [code]
    );
    const prevSOs = await q(
      `SELECT so.docno, so.docdate, so.docamt::numeric AS amount, so.companyname AS customer,
              so.cancelled, so.docref3,
              CASE WHEN so.cancelled = true THEN 'cancelled'
                   WHEN UPPER(COALESCE(so.docref3,'')) = 'DONE' THEN 'complete'
                   ELSE 'active' END AS status
       FROM sql_salesorders so
       WHERE so.code = $1
         AND DATE_TRUNC('month', so.docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
         AND (so.cancelled = false OR so.cancelled IS NULL)
       ORDER BY so.docdate DESC, so.docno DESC`,
      [code]
    );

    return res.status(200).json({
      code,
      currentMonth: currSOs.rows.map(r => ({
        docno: r.docno, date: r.docdate, amount: Number(r.amount || 0), status: r.status,
      })),
      previousMonth: prevSOs.rows.map(r => ({
        docno: r.docno, date: r.docdate, amount: Number(r.amount || 0), status: r.status,
      })),
    });
  } catch (e) {
    console.error('comparison_detail error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Comparison Brief — AI-generated CEO insights using Opus
async function handleComparisonBrief(req, res) {
  try {
    // Gather data for the AI to analyse
    const custRes = await q(
      `WITH curr AS (
        SELECT code, companyname, SUM(docamt::numeric) AS amt
        FROM sql_salesinvoices
        WHERE DATE_TRUNC('month', docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
          AND (cancelled = false OR cancelled IS NULL) AND code IS NOT NULL
        GROUP BY code, companyname
      ), prev AS (
        SELECT code, companyname, SUM(docamt::numeric) AS amt
        FROM sql_salesinvoices
        WHERE DATE_TRUNC('month', docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND (cancelled = false OR cancelled IS NULL) AND code IS NOT NULL
        GROUP BY code, companyname
      )
      SELECT COALESCE(c.code, p.code) AS code, COALESCE(c.companyname, p.companyname) AS name,
             COALESCE(p.amt, 0) AS prev_amt, COALESCE(c.amt, 0) AS curr_amt
      FROM curr c FULL OUTER JOIN prev p ON p.code = c.code
      ORDER BY COALESCE(c.amt, 0) DESC`
    );

    const arRes = await q(
      `SELECT COALESCE(SUM(outstanding::numeric), 0) AS total_ar,
              COUNT(*) FILTER (WHERE outstanding::numeric > 0) AS ar_count
       FROM sql_customers`
    );

    const prodRes = await q(
      `WITH curr AS (
        SELECT sol.itemcode, MAX(sol.description) AS name, SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_inv_lines sol JOIN sql_salesinvoices si ON si.dockey = sol.dockey
        WHERE DATE_TRUNC('month', si.docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
          AND (si.cancelled = false OR si.cancelled IS NULL) AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      ), prev AS (
        SELECT sol.itemcode, MAX(sol.description) AS name, SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_inv_lines sol JOIN sql_salesinvoices si ON si.dockey = sol.dockey
        WHERE DATE_TRUNC('month', si.docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND (si.cancelled = false OR si.cancelled IS NULL) AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      )
      SELECT COALESCE(c.itemcode, p.itemcode) AS code, COALESCE(c.name, p.name) AS name,
             COALESCE(p.revenue, 0) AS prev_rev, COALESCE(c.revenue, 0) AS curr_rev,
             COALESCE(p.qty, 0) AS prev_qty, COALESCE(c.qty, 0) AS curr_qty
      FROM curr c FULL OUTER JOIN prev p ON p.itemcode = c.itemcode
      ORDER BY COALESCE(c.revenue, 0) DESC`
    );

    const monthName = new Date().toLocaleString('en-MY', { month: 'long', year: 'numeric' });
    const prev = new Date();
    prev.setMonth(prev.getMonth() - 1);
    const prevName = prev.toLocaleString('en-MY', { month: 'long', year: 'numeric' });

    const totalCurr = custRes.rows.reduce((s, r) => s + Number(r.curr_amt), 0);
    const totalPrev = custRes.rows.reduce((s, r) => s + Number(r.prev_amt), 0);
    const deltaPct = totalPrev > 0 ? (((totalCurr - totalPrev) / totalPrev) * 100).toFixed(1) : 0;

    // Build context for Opus
    const declining = custRes.rows.filter(r => Number(r.curr_amt) < Number(r.prev_amt) && Number(r.prev_amt) > 0)
      .map(r => `${r.name}: RM ${Number(r.prev_amt).toFixed(0)} → RM ${Number(r.curr_amt).toFixed(0)} (${((Number(r.curr_amt) - Number(r.prev_amt)) / Number(r.prev_amt) * 100).toFixed(0)}%)`);
    const churned = custRes.rows.filter(r => Number(r.curr_amt) === 0 && Number(r.prev_amt) > 0)
      .map(r => `${r.name}: RM ${Number(r.prev_amt).toFixed(0)} last month, RM 0 this month`);
    const newCust = custRes.rows.filter(r => Number(r.prev_amt) === 0 && Number(r.curr_amt) > 0)
      .map(r => `${r.name}: RM ${Number(r.curr_amt).toFixed(0)} (new this month)`);
    const growing = custRes.rows.filter(r => Number(r.curr_amt) > Number(r.prev_amt) && Number(r.prev_amt) > 0)
      .map(r => `${r.name}: RM ${Number(r.prev_amt).toFixed(0)} → RM ${Number(r.curr_amt).toFixed(0)} (+${((Number(r.curr_amt) - Number(r.prev_amt)) / Number(r.prev_amt) * 100).toFixed(0)}%)`);

    const config = require('./config');
    const prompt = `You are a business analyst for ${config.aiContext}. The CEO needs a brief executive summary comparing this month's sales performance against last month.

DATA:
- ${prevName} total invoiced: RM ${totalPrev.toFixed(2)}
- ${monthName} total invoiced (month-to-date): RM ${totalCurr.toFixed(2)}
- Change: ${deltaPct}%
- AR Outstanding: RM ${Number(arRes.rows[0]?.total_ar || 0).toFixed(2)} across ${arRes.rows[0]?.ar_count || 0} customers
- Note: ${monthName} is month-to-date (${new Date().getDate()} days in), ${prevName} is a full month

DECLINING CUSTOMERS (${declining.length}):
${declining.slice(0, 10).join('\n') || 'None'}

CHURNED (ordered last month, nothing this month) (${churned.length}):
${churned.slice(0, 10).join('\n') || 'None'}

NEW CUSTOMERS THIS MONTH (${newCust.length}):
${newCust.slice(0, 5).join('\n') || 'None'}

GROWING CUSTOMERS (${growing.length}):
${growing.slice(0, 5).join('\n') || 'None'}

TOP PRODUCTS BY REVENUE CHANGE:
${prodRes.rows.slice(0, 10).map(r => `${r.name} (${r.code}): RM ${Number(r.prev_rev).toFixed(0)} → RM ${Number(r.curr_rev).toFixed(0)}`).join('\n')}

Write a concise CEO brief (3-4 paragraphs) covering:
1. Performance summary — headline numbers, context (month-to-date vs full month)
2. Key concerns — which customers declined or churned, why this might be happening, revenue at risk
3. Opportunities — growing customers, new accounts, product trends
4. Recommended actions — specific, actionable steps the sales team should take THIS WEEK

Tone: direct, data-driven, no fluff. Use exact RM figures. Write for a CEO who has 2 minutes to read this.

IMPORTANT: Return ONLY a JSON object with this structure:
{
  "summary": "One-line headline (e.g. 'Revenue down 60% month-to-date — 5 key accounts need attention')",
  "brief": "The full 3-4 paragraph analysis",
  "actions": ["Action 1", "Action 2", "Action 3", "Action 4"],
  "risk_amount": 12345.00,
  "opportunity_amount": 6789.00
}`;

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return res.status(200).json({
        summary: 'AI brief unavailable — ANTHROPIC_API_KEY not configured',
        brief: '', actions: [], risk_amount: 0, opportunity_amount: 0,
      });
    }

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2000,
        system: 'You are a business analyst. Respond ONLY with a valid JSON object. No text before or after.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const aiText = aiData.content?.[0]?.text || '{}';

    // Extract JSON (same robust extraction as PO Intake)
    let brief;
    try {
      const trimmed = aiText.trim();
      if (trimmed.startsWith('{')) {
        brief = JSON.parse(trimmed);
      } else {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
          brief = JSON.parse(trimmed.slice(start, end + 1));
        }
      }
    } catch {
      brief = { summary: 'AI analysis completed', brief: aiText, actions: [], risk_amount: 0, opportunity_amount: 0 };
    }

    return res.status(200).json({
      ...brief,
      dataContext: { totalCurr, totalPrev, deltaPct, monthName, prevName },
    });
  } catch (e) {
    console.error('comparison_brief error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Wrapper that dispatches new v2 types. Called from the main handler export.
// We intercept at the top of the export by checking for v2 types.
export async function handleV2Type(req, res, type) {
  switch (type) {
    case 'overview':
      return handleOverview(req, res);
    case 'ar_overview':
      return handleAROverview(req, res);
    case 'customers':
      return handleCustomersList(req, res);
    case 'so_lifecycle':
      return handleSOLifecycle(req, res);
    case 'pipeline':
      return handlePipeline(req, res);
    case 'analytics':
      return handleAnalytics(req, res);
    case 'comparison':
      return handleComparison(req, res);
    case 'comparison_detail':
      return handleComparisonDetail(req, res);
    case 'comparison_brief':
      return handleComparisonBrief(req, res);
    case 'top_products':
      return handleTopProducts(req, res);
    case 'document_tracker':
      return handleDocumentTracker(req, res);
    case 'production_overview':
      return handleProductionOverview(req, res);
    case 'production_brief':
      return handleProductionBrief(req, res);
    case 'production_queue':
      return handleProductionQueue(req, res);
    case 'production_gap':
      return handleProductionGap(req, res);
    case 'production_purchase':
      return handleProductionPurchase(req, res);
    default:
      return null; // not a v2 type
  }
}

// Document Tracker — correct logic based on SO status
// Active SOs = need DO and/or Invoice (genuinely pending)
// Completed SOs (docref3=DONE) = already fulfilled
// fromdockey linking used where available, but SO status is the primary indicator
async function handleDocumentTracker(req, res) {
  try {
    // Get all SOs from last 6 months (non-cancelled)
    const soRes = await q(`
      SELECT dockey, docno, docdate::text AS docdate, code, companyname,
             docamt::numeric AS docamt, cancelled, docref1, docref2, docref3, docref4
      FROM sql_salesorders
      WHERE docdate >= CURRENT_DATE - INTERVAL '6 months'
        AND (cancelled = false OR cancelled IS NULL)
      ORDER BY docdate DESC, dockey DESC
      LIMIT 500
    `);

    // Get DOs linked via fromdockey (where available)
    const doRes = await q(`
      SELECT dl.fromdockey AS so_dockey,
        d.dockey, d.docno, d.docdate::text AS docdate, d.docamt::numeric AS docamt
      FROM sql_do_lines dl
      JOIN sql_deliveryorders d ON d.dockey = dl.dockey
      WHERE dl.fromdockey IS NOT NULL AND (d.cancelled = false OR d.cancelled IS NULL)
      GROUP BY dl.fromdockey, d.dockey, d.docno, d.docdate, d.docamt
    `);

    // Get invoices linked via fromdockey (where available)
    const invRes = await q(`
      SELECT il.fromdockey AS do_dockey,
        i.dockey, i.docno, i.docdate::text AS docdate, i.docamt::numeric AS docamt
      FROM sql_inv_lines il
      JOIN sql_salesinvoices i ON i.dockey = il.dockey
      WHERE il.fromdockey IS NOT NULL AND (i.cancelled = false OR i.cancelled IS NULL)
      GROUP BY il.fromdockey, i.dockey, i.docno, i.docdate, i.docamt
    `);

    // Build lookup maps for fromdockey-linked docs
    const dosBySO = {};
    for (const row of doRes.rows) {
      if (!dosBySO[row.so_dockey]) dosBySO[row.so_dockey] = [];
      dosBySO[row.so_dockey].push({
        docno: row.docno, date: row.docdate, amount: Number(row.docamt || 0), dockey: row.dockey,
      });
    }

    const invsByDO = {};
    for (const row of invRes.rows) {
      if (!invsByDO[row.do_dockey]) invsByDO[row.do_dockey] = [];
      invsByDO[row.do_dockey].push({
        docno: row.docno, date: row.docdate, amount: Number(row.docamt || 0),
      });
    }

    // Build entries
    const entries = soRes.rows.map(so => {
      const ref3 = String(so.docref3 || '').toUpperCase().trim();
      const ref4 = String(so.docref4 || '').toUpperCase().trim();

      // Skip cancelled SOs
      if (so.cancelled === true || ref3 === 'CANCELLED') return null;

      // Determine SO status from Ref3 and Ref4 — based on actual team usage in SQL Account:
      // Ref3 starts with "DONE" = fully fulfilled (301+ SOs)
      // Ref4 contains "INVOICED" = invoiced but Ref3 not updated to DONE (5 SOs)
      // Ref3 starts with "PARTIAL" = partially delivered (3 SOs)
      // Everything else = genuinely active (~23 SOs)
      const isDone = ref3.startsWith('DONE') || ref4.includes('INVOICED');
      const isPartial = ref3.startsWith('PARTIAL');

      let status;
      if (isDone) status = 'complete';
      else if (isPartial) status = 'partial';
      else status = 'active';

      // fromdockey linking (secondary — only for OCC-created documents)
      const linkedDOs = dosBySO[so.dockey] || [];
      const linkedInvs = [];
      for (const d of linkedDOs) {
        const invs = invsByDO[d.dockey] || [];
        linkedInvs.push(...invs);
      }

      // Chain status: primary = SO status fields, secondary = fromdockey
      let chain;
      if (isDone) {
        chain = 'complete';
      } else if (isPartial) {
        chain = linkedInvs.length > 0 ? 'pending_do' : 'pending_both';
      } else if (linkedDOs.length > 0 && linkedInvs.length > 0) {
        chain = 'complete';
      } else if (linkedDOs.length > 0) {
        chain = 'pending_invoice';
      } else {
        chain = 'pending_both';
      }

      return {
        soNo: so.docno,
        soDockey: so.dockey,
        customer: so.companyname,
        customerCode: so.code,
        poRef: so.docref1 || null,
        deliveryInfo: so.docref2 || null,
        statusNote: so.docref3 || null,
        invoiceNote: so.docref4 || null,
        amount: Number(so.docamt || 0),
        date: so.docdate,
        status,
        chain,
        dos: linkedDOs.map(d => ({ docno: d.docno, date: d.date, amount: d.amount })),
        invoices: linkedInvs.map(i => ({ docno: i.docno, date: i.date, amount: i.amount })),
      };
    }).filter(Boolean); // remove cancelled entries (returned as null)

    // Stats — only count genuinely active SOs as pending
    const activeEntries = entries.filter(e => e.status === 'active');
    const stats = {
      total: entries.length,
      active: activeEntries.length,
      complete: entries.filter(e => e.chain === 'complete').length,
      pendingInvoice: activeEntries.filter(e => e.chain === 'pending_invoice').length,
      pendingBoth: activeEntries.filter(e => e.chain === 'pending_both').length,
      outstanding: activeEntries.filter(e => e.chain !== 'complete').reduce((s, e) => s + e.amount, 0),
    };

    return res.status(200).json({ entries, stats, source: 'postgres' });
  } catch (e) {
    console.error('document_tracker error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ══════════════════════════════════════════════════════════════
// PRODUCTION MODULE — Order Queue, Gap Analysis, Purchase List
// Uses: sql_salesorders + sql_so_lines (active SOs)
//       occ_bom_headers + occ_bom_lines (BOM explosion)
//       sql_stockitems (current stock balances)
// ══════════════════════════════════════════════════════════════

// Production AI Brief — Opus analysis of production MoM trends
async function handleProductionBrief(req, res) {
  try {
    const config = require('./config');

    // Gather production data for AI
    const momRes = await q(`
      WITH curr AS (
        SELECT sol.itemcode, MAX(sol.description) AS name,
               SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_so_lines sol JOIN sql_salesorders so ON so.dockey = sol.dockey
        WHERE DATE_TRUNC('month', so.docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
          AND (so.cancelled = false OR so.cancelled IS NULL)
          AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      ),
      prev AS (
        SELECT sol.itemcode, MAX(sol.description) AS name,
               SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_so_lines sol JOIN sql_salesorders so ON so.dockey = sol.dockey
        WHERE DATE_TRUNC('month', so.docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND (so.cancelled = false OR so.cancelled IS NULL)
          AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      )
      SELECT COALESCE(c.itemcode, p.itemcode) AS code, COALESCE(c.name, p.name) AS name,
             COALESCE(p.qty, 0) AS prev_qty, COALESCE(c.qty, 0) AS curr_qty,
             COALESCE(p.revenue, 0) AS prev_rev, COALESCE(c.revenue, 0) AS curr_rev
      FROM curr c FULL OUTER JOIN prev p ON p.itemcode = c.itemcode
      ORDER BY COALESCE(c.revenue, 0) DESC
    `);

    // Stock summary
    const stockRes = await q(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE balsqty::numeric < 0) AS negative,
             COUNT(*) FILTER (WHERE balsqty::numeric = 0) AS zero_stock
      FROM sql_stockitems WHERE code IS NOT NULL
    `);

    // Price alerts
    const priceRes = await q(`
      WITH prices AS (
        SELECT pil.itemcode, MAX(pil.description) AS name,
               MIN(CASE WHEN pi.docdate >= CURRENT_DATE - INTERVAL '6 months' AND pi.docdate < CURRENT_DATE - INTERVAL '3 months' THEN pil.unitprice::numeric END) AS early_price,
               MAX(CASE WHEN pi.docdate >= CURRENT_DATE - INTERVAL '1 month' THEN pil.unitprice::numeric END) AS recent_price
        FROM sql_pi_lines pil JOIN sql_purchaseinvoices pi ON pi.dockey = pil.dockey
        WHERE pi.docdate >= CURRENT_DATE - INTERVAL '6 months' AND pil.itemcode IS NOT NULL
        GROUP BY pil.itemcode
        HAVING MIN(CASE WHEN pi.docdate >= CURRENT_DATE - INTERVAL '6 months' AND pi.docdate < CURRENT_DATE - INTERVAL '3 months' THEN pil.unitprice::numeric END) IS NOT NULL
           AND MAX(CASE WHEN pi.docdate >= CURRENT_DATE - INTERVAL '1 month' THEN pil.unitprice::numeric END) IS NOT NULL
      )
      SELECT *, ROUND(((recent_price - early_price) / NULLIF(early_price, 0)) * 100, 1) AS pct_change
      FROM prices WHERE early_price > 0
      ORDER BY pct_change DESC LIMIT 10
    `);

    const monthName = new Date().toLocaleString('en-MY', { month: 'long', year: 'numeric' });
    const prev = new Date(); prev.setMonth(prev.getMonth() - 1);
    const prevName = prev.toLocaleString('en-MY', { month: 'long', year: 'numeric' });

    const totalCurrQty = momRes.rows.reduce((s, r) => s + Number(r.curr_qty), 0);
    const totalPrevQty = momRes.rows.reduce((s, r) => s + Number(r.prev_qty), 0);
    const totalCurrRev = momRes.rows.reduce((s, r) => s + Number(r.curr_rev), 0);
    const totalPrevRev = momRes.rows.reduce((s, r) => s + Number(r.prev_rev), 0);

    const topProducts = momRes.rows.slice(0, 15).map(r =>
      `${r.name} (${r.code}): ${Number(r.prev_qty)} → ${Number(r.curr_qty)} units, RM ${Number(r.prev_rev).toFixed(0)} → RM ${Number(r.curr_rev).toFixed(0)}`
    );

    const priceChanges = priceRes.rows.map(r =>
      `${r.name} (${r.itemcode}): RM ${Number(r.early_price).toFixed(2)} → RM ${Number(r.recent_price).toFixed(2)} (${r.pct_change > 0 ? '+' : ''}${r.pct_change}%)`
    );

    const prompt = `You are the production intelligence analyst for ${config.aiContext}. The CEO needs a brief on production and stock status this month vs last month.

DATA:
- ${prevName} total ordered: ${totalPrevQty} units (RM ${totalPrevRev.toFixed(0)})
- ${monthName} total ordered (MTD): ${totalCurrQty} units (RM ${totalCurrRev.toFixed(0)})
- Stock items: ${stockRes.rows[0]?.total || 0} total, ${stockRes.rows[0]?.zero_stock || 0} at zero, ${stockRes.rows[0]?.negative || 0} negative
- Note: ${monthName} is month-to-date (${new Date().getDate()} days in)

TOP PRODUCTS BY ORDER VOLUME (${prevName} → ${monthName}):
${topProducts.join('\n')}

RAW MATERIAL PRICE CHANGES (6-month trend):
${priceChanges.length > 0 ? priceChanges.join('\n') : 'No significant price changes detected.'}

Write a concise CEO brief (3-4 paragraphs):
1. Production volume summary — order trends, which products are growing/declining
2. Stock health — items at zero or negative, risk of production delays
3. Cost pressure — raw material price movements that affect margins
4. Recommended actions — specific steps for production and procurement teams THIS WEEK

IMPORTANT: Return ONLY a JSON object:
{
  "summary": "One-line headline",
  "brief": "Full 3-4 paragraph analysis",
  "actions": ["Action 1", "Action 2", "Action 3", "Action 4"]
}`;

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(200).json({ summary: 'AI brief unavailable', brief: '', actions: [] });

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: 'You are a production analyst. Respond ONLY with a valid JSON object. No text before or after.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('AI API error:', aiRes.status, errText.slice(0, 200));
      return res.status(200).json({ summary: 'AI brief temporarily unavailable', brief: `API returned ${aiRes.status}. The production brief will retry on next request.`, actions: [] });
    }

    const aiData = await aiRes.json();
    const aiText = aiData.content?.[0]?.text || '{}';
    let brief;
    try {
      const trimmed = aiText.trim();
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      brief = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      brief = { summary: 'Analysis complete', brief: aiText, actions: [] };
    }

    return res.status(200).json(brief);
  } catch (e) {
    console.error('production_brief error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Production Overview — stock inventory, price trends, AI brief
async function handleProductionOverview(req, res) {
  try {
    // 1. Full stock inventory with values
    const stockRes = await q(`
      SELECT si.code, si.description, si.occ_uom AS uom,
             COALESCE(si.balsqty::numeric, 0) AS balance
      FROM sql_stockitems si
      WHERE si.code IS NOT NULL AND si.description IS NOT NULL
      ORDER BY si.description
    `);

    // Get BOM ref costs for stock value calculation
    const bomCostRes = await q(`
      SELECT bl.component_code AS code, AVG(bl.ref_cost) AS avg_cost
      FROM occ_bom_lines bl GROUP BY bl.component_code
    `);
    const bomCosts = {};
    for (const r of bomCostRes.rows) bomCosts[r.code] = Number(r.avg_cost || 0);

    // Also get avg purchase price from recent purchase invoices
    let piCosts = {};
    try {
      const piRes = await q(`
        SELECT matched_itemcode AS code, AVG(amount::numeric) AS avg_price
        FROM sql_pi_lines WHERE matched_itemcode IS NOT NULL AND amount IS NOT NULL AND amount::numeric > 0
        GROUP BY matched_itemcode
      `);
      for (const r of piRes.rows) piCosts[r.code] = Number(r.avg_price || 0);
    } catch {}

    const stockItems = stockRes.rows.map(r => {
      const balance = Number(r.balance);
      const unitCost = piCosts[r.code] || bomCosts[r.code] || 0;
      return {
        code: r.code, description: r.description, uom: r.uom,
        balance, unitCost,
        value: Math.round(balance * unitCost * 100) / 100,
      };
    });

    const totalStockValue = stockItems.reduce((s, i) => s + Math.max(0, i.value), 0);
    const totalItems = stockItems.length;
    const zeroStock = stockItems.filter(i => i.balance <= 0).length;
    const negativeStock = stockItems.filter(i => i.balance < 0).length;

    // 2. Purchase price trends — item-level, purchase-to-purchase comparison
    // Shows each raw material's purchase history: date, supplier, amount, and price changes
    let priceTrends = [];
    let priceAlerts = [];

    try {
      // Get individual purchase transactions per item (matched via description)
      const purchaseRes = await q(`
        SELECT pil.description AS item_name,
               COALESCE(pil.matched_itemcode, pil.description) AS item_key,
               pil.amount::numeric AS amount,
               pi.docdate::text AS purchase_date,
               pi.docno AS invoice_no,
               pi.companyname AS supplier
        FROM sql_pi_lines pil
        JOIN sql_purchaseinvoices pi ON pi.dockey = pil.dockey
        WHERE pi.docdate >= CURRENT_DATE - INTERVAL '12 months'
          AND (pi.cancelled = false OR pi.cancelled IS NULL)
          AND pil.description IS NOT NULL
          AND pil.amount IS NOT NULL AND pil.amount::numeric > 0
        ORDER BY COALESCE(pil.matched_itemcode, pil.description), pi.docdate ASC
      `);

      // Group purchases by item
      const itemMap = {};
      for (const r of purchaseRes.rows) {
        const key = r.item_key;
        if (!itemMap[key]) itemMap[key] = { code: r.item_key, name: r.item_name, purchases: [] };
        itemMap[key].purchases.push({
          date: r.purchase_date,
          supplier: r.supplier,
          amount: Number(r.amount),
          invoiceNo: r.invoice_no,
        });
      }

      // Calculate price changes between purchases for each item
      priceTrends = Object.values(itemMap)
        .filter(item => item.purchases.length >= 2)
        .map(item => {
          const first = item.purchases[0];
          const last = item.purchases[item.purchases.length - 1];
          const change = last.amount - first.amount;
          const changePct = first.amount > 0 ? Math.round((change / first.amount) * 1000) / 10 : 0;
          return {
            code: item.code, name: item.name,
            earliestPrice: first.amount,
            earliestDate: first.date,
            earliestSupplier: first.supplier,
            latestPrice: last.amount,
            latestDate: last.date,
            latestSupplier: last.supplier,
            change: Math.round(change * 100) / 100,
            changePct,
            purchaseCount: item.purchases.length,
            purchases: item.purchases, // full history for drill-down
          };
        })
        .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

      priceAlerts = priceTrends.filter(t => Math.abs(t.changePct) > 10);
    } catch (e) {
      console.error('price trends error:', e.message);
    }

    // 3. Production readiness summary
    const readinessRes = await q(`
      WITH pending AS (
        SELECT sol.itemcode, COUNT(DISTINCT so.dockey) AS order_count,
               SUM(sol.qty::numeric - COALESCE(sol.offsetqty::numeric, 0)) AS pending_qty
        FROM sql_salesorders so
        JOIN sql_so_lines sol ON sol.dockey = so.dockey
        WHERE so.docdate >= CURRENT_DATE - INTERVAL '3 months'
          AND (so.cancelled = false OR so.cancelled IS NULL)
          AND NOT UPPER(COALESCE(so.docref3, '')) LIKE 'DONE%'
          AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
          AND NOT UPPER(COALESCE(so.docref4, '')) LIKE '%INVOICED%'
          AND sol.itemcode IS NOT NULL
          AND (sol.qty::numeric - COALESCE(sol.offsetqty::numeric, 0)) > 0
        GROUP BY sol.itemcode
      )
      SELECT p.itemcode, p.pending_qty, p.order_count,
             CASE WHEN bh.id IS NOT NULL THEN true ELSE false END AS has_bom,
             COALESCE(si.balsqty::numeric, 0) AS stock
      FROM pending p
      LEFT JOIN occ_bom_headers bh ON bh.finished_code = p.itemcode
      LEFT JOIN sql_stockitems si ON si.code = p.itemcode
    `);

    let ready = 0, shortage = 0, noBom = 0;
    for (const r of readinessRes.rows) {
      if (!r.has_bom) { noBom++; }
      else if (Number(r.stock) >= Number(r.pending_qty)) { ready++; }
      else { shortage++; }
    }

    // 4. MoM production comparison data for AI brief
    const momRes = await q(`
      WITH curr AS (
        SELECT sol.itemcode, MAX(sol.description) AS name,
               SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_so_lines sol JOIN sql_salesorders so ON so.dockey = sol.dockey
        WHERE DATE_TRUNC('month', so.docdate::date) = DATE_TRUNC('month', CURRENT_DATE)
          AND (so.cancelled = false OR so.cancelled IS NULL)
          AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      ),
      prev AS (
        SELECT sol.itemcode, MAX(sol.description) AS name,
               SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_so_lines sol JOIN sql_salesorders so ON so.dockey = sol.dockey
        WHERE DATE_TRUNC('month', so.docdate::date) = DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
          AND (so.cancelled = false OR so.cancelled IS NULL)
          AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      )
      SELECT COALESCE(c.itemcode, p.itemcode) AS code,
             COALESCE(c.name, p.name) AS name,
             COALESCE(p.qty, 0) AS prev_qty, COALESCE(c.qty, 0) AS curr_qty,
             COALESCE(p.revenue, 0) AS prev_rev, COALESCE(c.revenue, 0) AS curr_rev
      FROM curr c FULL OUTER JOIN prev p ON p.itemcode = c.itemcode
      ORDER BY COALESCE(c.revenue, 0) DESC
    `);

    return res.status(200).json({
      stock: {
        items: stockItems,
        totalValue: Math.round(totalStockValue * 100) / 100,
        totalItems,
        zeroStock,
        negativeStock,
      },
      priceTrends: priceTrends.slice(0, 30),
      priceAlerts,
      readiness: { ready, shortage, noBom, total: ready + shortage + noBom },
      momProducts: momRes.rows.map(r => ({
        code: r.code, name: r.name,
        prevQty: Number(r.prev_qty), currQty: Number(r.curr_qty),
        prevRev: Number(r.prev_rev), currRev: Number(r.curr_rev),
      })),
      source: 'postgres',
    });
  } catch (e) {
    console.error('production_overview error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Production Order Queue — active SOs grouped by customer with line items
async function handleProductionQueue(req, res) {
  try {
    // Get all active SOs (not DONE, not CANCELLED) with their line items
    const r = await q(`
      SELECT so.dockey, so.docno, so.docdate::text AS date, so.code AS customer_code,
             so.companyname AS customer, so.docamt::numeric AS amount,
             so.docref1 AS po_ref, so.docref2 AS delivery_info, so.docref3,
             sol.itemcode, sol.description, sol.qty::numeric AS qty,
             COALESCE(sol.offsetqty::numeric, 0) AS delivered_qty,
             sol.uom, sol.unitprice::numeric AS unitprice
      FROM sql_salesorders so
      LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey
      WHERE so.docdate >= CURRENT_DATE - INTERVAL '3 months'
        AND (so.cancelled = false OR so.cancelled IS NULL)
        AND NOT UPPER(COALESCE(so.docref3, '')) LIKE 'DONE%'
        AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
        AND NOT UPPER(COALESCE(so.docref4, '')) LIKE '%INVOICED%'
      ORDER BY so.docdate ASC, so.dockey
    `);

    // Group by SO, then by customer
    const soMap = {};
    for (const row of r.rows) {
      if (!soMap[row.dockey]) {
        soMap[row.dockey] = {
          dockey: row.dockey, docno: row.docno, date: row.date,
          customerCode: row.customer_code, customer: row.customer,
          amount: Number(row.amount || 0), poRef: row.po_ref,
          deliveryInfo: row.delivery_info,
          items: [],
        };
      }
      if (row.itemcode) {
        const qty = Number(row.qty || 0);
        const delivered = Number(row.delivered_qty || 0);
        const pending = qty - delivered;
        if (pending > 0) {
          soMap[row.dockey].items.push({
            itemcode: row.itemcode, description: row.description,
            qty, delivered, pending, uom: row.uom,
            unitprice: Number(row.unitprice || 0),
          });
        }
      }
    }

    // Group SOs by customer
    const customerMap = {};
    for (const so of Object.values(soMap)) {
      if (so.items.length === 0) continue; // skip SOs with no pending items
      const key = so.customerCode || so.customer;
      if (!customerMap[key]) {
        customerMap[key] = { code: so.customerCode, name: so.customer, orders: [], totalAmount: 0 };
      }
      customerMap[key].orders.push(so);
      customerMap[key].totalAmount += so.amount;
    }

    const customers = Object.values(customerMap).sort((a, b) => {
      // Sort by earliest delivery date
      const aDate = Math.min(...a.orders.map(o => new Date(o.date).getTime()));
      const bDate = Math.min(...b.orders.map(o => new Date(o.date).getTime()));
      return aDate - bDate;
    });

    // Aggregate all pending items across all SOs
    const itemTotals = {};
    for (const c of customers) {
      for (const so of c.orders) {
        for (const item of so.items) {
          if (!itemTotals[item.itemcode]) {
            itemTotals[item.itemcode] = { itemcode: item.itemcode, description: item.description, uom: item.uom, totalPending: 0, orderCount: 0 };
          }
          itemTotals[item.itemcode].totalPending += item.pending;
          itemTotals[item.itemcode].orderCount++;
        }
      }
    }

    const stats = {
      totalCustomers: customers.length,
      totalOrders: customers.reduce((s, c) => s + c.orders.length, 0),
      totalItems: Object.keys(itemTotals).length,
      totalValue: customers.reduce((s, c) => s + c.totalAmount, 0),
    };

    return res.status(200).json({
      customers,
      itemSummary: Object.values(itemTotals).sort((a, b) => b.totalPending - a.totalPending),
      stats,
      source: 'postgres',
    });
  } catch (e) {
    console.error('production_queue error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Production Gap Analysis — BOM explosion + stock check
async function handleProductionGap(req, res) {
  try {
    // 1. Get all pending items from active SOs (same as queue but just item totals)
    const pendingRes = await q(`
      SELECT sol.itemcode, sol.description, sol.uom,
             SUM(sol.qty::numeric - COALESCE(sol.offsetqty::numeric, 0)) AS pending_qty
      FROM sql_salesorders so
      JOIN sql_so_lines sol ON sol.dockey = so.dockey
      WHERE so.docdate >= CURRENT_DATE - INTERVAL '3 months'
        AND (so.cancelled = false OR so.cancelled IS NULL)
        AND NOT UPPER(COALESCE(so.docref3, '')) LIKE 'DONE%'
        AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
        AND NOT UPPER(COALESCE(so.docref4, '')) LIKE '%INVOICED%'
        AND sol.itemcode IS NOT NULL
        AND (sol.qty::numeric - COALESCE(sol.offsetqty::numeric, 0)) > 0
      GROUP BY sol.itemcode, sol.description, sol.uom
      ORDER BY pending_qty DESC
    `);

    // 2. Get BOM data from Postgres
    const bomRes = await q(`
      SELECT bh.finished_code, bh.product_name,
             bl.component_code, bl.component_name, bl.qty_per_unit, bl.uom AS comp_uom, bl.ref_cost
      FROM occ_bom_headers bh
      JOIN occ_bom_lines bl ON bl.bom_id = bh.id
      WHERE bh.is_active = true
      ORDER BY bh.finished_code
    `);

    // Build BOM lookup: finished_code → [components]
    const bomLookup = {};
    for (const row of bomRes.rows) {
      if (!bomLookup[row.finished_code]) bomLookup[row.finished_code] = [];
      bomLookup[row.finished_code].push({
        code: row.component_code, name: row.component_name,
        qtyPerUnit: Number(row.qty_per_unit), uom: row.comp_uom,
        cost: Number(row.ref_cost || 0),
      });
    }

    // 3. Get current stock balances
    const stockRes = await q(`
      SELECT code, description, COALESCE(balsqty::numeric, 0) AS balance, occ_uom AS uom
      FROM sql_stockitems
      WHERE code IS NOT NULL
    `);
    const stockLookup = {};
    for (const row of stockRes.rows) {
      stockLookup[row.code] = { balance: Number(row.balance), description: row.description, uom: row.uom };
    }

    // 4. Explode BOMs — for each pending finished good, calculate raw material needs
    const rawMaterialNeeds = {};  // component_code → total qty needed
    const finishedGoods = [];     // per-item gap analysis

    for (const item of pendingRes.rows) {
      const pending = Number(item.pending_qty);
      const bom = bomLookup[item.itemcode];
      const stock = stockLookup[item.itemcode];
      const currentStock = stock?.balance || 0;

      const fgEntry = {
        itemcode: item.itemcode, description: item.description,
        pendingQty: pending, currentStock,
        hasBom: !!bom, status: 'unknown',
        components: [],
      };

      if (bom) {
        // Explode BOM — calculate raw materials needed
        for (const comp of bom) {
          const needed = pending * comp.qtyPerUnit;
          const compStock = stockLookup[comp.code]?.balance || 0;

          // Accumulate total raw material needs
          if (!rawMaterialNeeds[comp.code]) {
            rawMaterialNeeds[comp.code] = {
              code: comp.code, name: comp.name, uom: comp.uom,
              totalNeeded: 0, currentStock: compStock, cost: comp.cost,
            };
          }
          rawMaterialNeeds[comp.code].totalNeeded += needed;

          fgEntry.components.push({
            code: comp.code, name: comp.name,
            needed: Math.round(needed * 1000) / 1000,
            stock: compStock, uom: comp.uom,
            shortage: Math.max(0, needed - compStock),
            status: compStock >= needed ? 'sufficient' : 'shortage',
          });
        }

        // Determine overall status
        const hasShortage = fgEntry.components.some(c => c.status === 'shortage');
        fgEntry.status = hasShortage ? 'shortage' : 'ready';
      } else {
        // No BOM — check finished good stock directly
        fgEntry.status = currentStock >= pending ? 'in_stock' : 'no_bom';
      }

      finishedGoods.push(fgEntry);
    }

    // Calculate shortages for raw materials
    const rawMaterials = Object.values(rawMaterialNeeds).map(rm => ({
      ...rm,
      totalNeeded: Math.round(rm.totalNeeded * 1000) / 1000,
      shortage: Math.max(0, Math.round((rm.totalNeeded - rm.currentStock) * 1000) / 1000),
      status: rm.currentStock >= rm.totalNeeded ? 'sufficient' : 'shortage',
      estimatedCost: Math.round(Math.max(0, rm.totalNeeded - rm.currentStock) * rm.cost * 100) / 100,
    })).sort((a, b) => b.shortage - a.shortage);

    const stats = {
      totalFinishedGoods: finishedGoods.length,
      ready: finishedGoods.filter(f => f.status === 'ready' || f.status === 'in_stock').length,
      shortage: finishedGoods.filter(f => f.status === 'shortage').length,
      noBom: finishedGoods.filter(f => f.status === 'no_bom').length,
      totalRawMaterials: rawMaterials.length,
      materialsShort: rawMaterials.filter(r => r.status === 'shortage').length,
      totalShortageValue: rawMaterials.reduce((s, r) => s + r.estimatedCost, 0),
    };

    return res.status(200).json({ finishedGoods, rawMaterials, stats, source: 'postgres' });
  } catch (e) {
    console.error('production_gap error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Production Purchase List — what to buy to fill shortages
async function handleProductionPurchase(req, res) {
  try {
    // Reuse gap analysis to get shortages, then enrich with supplier info
    const gapRes = await q(`
      WITH pending AS (
        SELECT sol.itemcode,
               SUM(sol.qty::numeric - COALESCE(sol.offsetqty::numeric, 0)) AS pending_qty
        FROM sql_salesorders so
        JOIN sql_so_lines sol ON sol.dockey = so.dockey
        WHERE so.docdate >= CURRENT_DATE - INTERVAL '3 months'
          AND (so.cancelled = false OR so.cancelled IS NULL)
          AND NOT UPPER(COALESCE(so.docref3, '')) LIKE 'DONE%'
          AND NOT UPPER(COALESCE(so.docref3, '')) = 'CANCELLED'
          AND NOT UPPER(COALESCE(so.docref4, '')) LIKE '%INVOICED%'
          AND sol.itemcode IS NOT NULL
          AND (sol.qty::numeric - COALESCE(sol.offsetqty::numeric, 0)) > 0
        GROUP BY sol.itemcode
      ),
      bom_needs AS (
        SELECT bl.component_code, bl.component_name, bl.uom, bl.ref_cost,
               SUM(p.pending_qty * bl.qty_per_unit) AS total_needed
        FROM pending p
        JOIN occ_bom_headers bh ON bh.finished_code = p.itemcode
        JOIN occ_bom_lines bl ON bl.bom_id = bh.id
        GROUP BY bl.component_code, bl.component_name, bl.uom, bl.ref_cost
      )
      SELECT bn.component_code AS code, bn.component_name AS name, bn.uom,
             bn.total_needed, bn.ref_cost,
             COALESCE(si.balsqty::numeric, 0) AS current_stock,
             GREATEST(0, bn.total_needed - COALESCE(si.balsqty::numeric, 0)) AS shortage
      FROM bom_needs bn
      LEFT JOIN sql_stockitems si ON si.code = bn.component_code
      WHERE bn.total_needed > COALESCE(si.balsqty::numeric, 0)
      ORDER BY (bn.total_needed - COALESCE(si.balsqty::numeric, 0)) * bn.ref_cost DESC
    `);

    const purchaseItems = gapRes.rows.map(r => ({
      code: r.code, name: r.name, uom: r.uom,
      needed: Math.round(Number(r.total_needed) * 1000) / 1000,
      stock: Number(r.current_stock),
      shortage: Math.round(Number(r.shortage) * 1000) / 1000,
      unitCost: Number(r.ref_cost || 0),
      totalCost: Math.round(Number(r.shortage) * Number(r.ref_cost || 0) * 100) / 100,
    }));

    const stats = {
      totalItems: purchaseItems.length,
      totalCost: purchaseItems.reduce((s, p) => s + p.totalCost, 0),
    };

    return res.status(200).json({ items: purchaseItems, stats, source: 'postgres' });
  } catch (e) {
    console.error('production_purchase error:', e);
    return res.status(500).json({ error: e.message });
  }
}
