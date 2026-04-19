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
      'pipeline', 'analytics', 'comparison', 'top_products',
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
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
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
        so.docno,
        so.docdate AS date,
        so.companyname AS customer,
        so.docamt::numeric AS amount,
        so.cancelled,
        so.docref3,
        MIN(sol.deliverydate) AS delivery_date,
        SUM(sol.qty::numeric) AS total_qty,
        SUM(sol.offsetqty::numeric) AS delivered_qty
      FROM sql_salesorders so
      LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey
      WHERE so.docdate >= CURRENT_DATE - $1::int
      GROUP BY so.docno, so.docdate, so.companyname, so.docamt, so.cancelled, so.docref3
      ORDER BY so.docdate DESC
      LIMIT 500
      `,
      [days]
    );
    const sos = r.rows.map((row) => {
      let status = 'active';
      if (row.cancelled) status = 'cancelled';
      else if (String(row.docref3 || '').toUpperCase().trim() === 'DONE') status = 'complete';
      else if (Number(row.delivered_qty) > 0 && Number(row.delivered_qty) < Number(row.total_qty))
        status = 'partial';
      return {
        docno: row.docno,
        date: row.date,
        customer: row.customer,
        amount: Number(row.amount || 0),
        deliveryDate: row.delivery_date,
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

// Sales Analytics — agent performance + product mix
async function handleAnalytics(req, res) {
  const days = parseDays(req);
  const df = buildDateFilter(req, 'so.docdate');
  try {
    // Agent performance
    const agentRes = await q(
      `
      SELECT
        COALESCE(so.agent, 'Unassigned') AS name,
        COUNT(*)::int AS orders,
        SUM(so.docamt::numeric) AS revenue
      FROM sql_salesorders so
      WHERE ${df.sql}
        AND so.cancelled = false
      GROUP BY COALESCE(so.agent, 'Unassigned')
      ORDER BY revenue DESC
      `,
      df.params
    );
    const agents = agentRes.rows.map((r) => ({
      name: r.name,
      orders: Number(r.orders || 0),
      revenue: Number(r.revenue || 0),
    }));

    // Product mix — top products by revenue
    const productRes = await q(
      `
      SELECT
        sol.itemcode AS code,
        COALESCE(MAX(sol.description), sol.itemcode) AS name,
        SUM(sol.qty::numeric) AS qty,
        SUM(sol.amount::numeric) AS revenue
      FROM sql_so_lines sol
      JOIN sql_salesorders so ON so.dockey = sol.dockey
      WHERE so.docdate >= CURRENT_DATE - $1::int
        AND so.cancelled = false
        AND sol.itemcode IS NOT NULL
      GROUP BY sol.itemcode
      ORDER BY revenue DESC
      LIMIT 20
      `,
      [days]
    );
    const products = productRes.rows.map((r) => ({
      code: r.code,
      name: r.name,
      qty: Number(r.qty || 0),
      revenue: Number(r.revenue || 0),
    }));

    // Growth — compare current period invoiced vs previous equal period
    const growthRes = await q(
      `
      SELECT
        COALESCE(SUM(CASE WHEN docdate >= CURRENT_DATE - $1::int THEN docamt::numeric ELSE 0 END), 0) AS current,
        COALESCE(SUM(CASE WHEN docdate >= CURRENT_DATE - ($1::int * 2)
                           AND docdate <  CURRENT_DATE - $1::int
                          THEN docamt::numeric ELSE 0 END), 0) AS previous
      FROM sql_salesinvoices
      WHERE (cancelled = false OR cancelled IS NULL)
      `,
      [days]
    );
    const currentRev = Number(growthRes.rows[0]?.current || 0);
    const previousRev = Number(growthRes.rows[0]?.previous || 0);
    const growthPct = previousRev > 0 ? (((currentRev - previousRev) / previousRev) * 100).toFixed(1) : null;

    // Customer concentration — share of revenue from top 5 customers
    const concRes = await q(
      `
      WITH rev AS (
        SELECT i.code, SUM(i.docamt::numeric) AS r
        FROM sql_salesinvoices i
        WHERE i.docdate >= CURRENT_DATE - $1::int
          AND (i.cancelled = false OR i.cancelled IS NULL)
          AND i.code IS NOT NULL
        GROUP BY i.code
      ),
      totals AS (
        SELECT SUM(r) AS total, SUM(r) FILTER (WHERE r > 0) AS nz FROM rev
      )
      SELECT
        COALESCE(SUM(top5.r), 0) AS top5,
        COALESCE((SELECT total FROM totals), 0) AS total
      FROM (SELECT r FROM rev ORDER BY r DESC LIMIT 5) top5
      `,
      [days]
    );
    const top5 = Number(concRes.rows[0]?.top5 || 0);
    const totalRev = Number(concRes.rows[0]?.total || 0);
    const topCustomerShare = totalRev > 0 ? Math.round((top5 / totalRev) * 100) : 0;

    return res.status(200).json({
      agents,
      products,
      kpis: {
        growth: growthPct != null ? `${growthPct > 0 ? '+' : ''}${growthPct}%` : '—',
        growthTrend: null,
        topCustomerShare,
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
    case 'top_products':
      return handleTopProducts(req, res);
    default:
      return null; // not a v2 type
  }
}
