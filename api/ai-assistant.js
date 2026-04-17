// api/ai-assistant.js
// OCC AI Assistant — powered by Claude.
// Read-only by design: the LLM is given access to a set of query functions that
// return data from Postgres. It cannot write to any table.
//
// The assistant works in a simple loop:
//   1. Receive user messages.
//   2. Call Claude with a system prompt and a set of tools (query functions).
//   3. Execute any requested tools against Postgres and feed results back.
//   4. Return Claude's final answer + a structured data payload for UI rendering.

import { Pool } from 'pg';

// ── POSTGRES ──────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}
async function q(sql, params = []) {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ── TOOL IMPLEMENTATIONS ──────────────────────────────────────
// Each tool is a simple function that runs a scoped Postgres query and
// returns a JSON-friendly payload. Tool descriptions below tell Claude
// when to invoke each.

const TOOLS = {
  async top_customers({ days = 30, limit = 10 } = {}) {
    const r = await q(
      `
      SELECT
        i.companyname AS name,
        i.code AS code,
        SUM(i.docamt::numeric) AS revenue,
        COUNT(*)::int AS invoices
      FROM sql_salesinvoices i
      WHERE i.docdate >= CURRENT_DATE - $1::int
        AND (i.cancelled = false OR i.cancelled IS NULL)
        AND i.code IS NOT NULL
      GROUP BY i.companyname, i.code
      ORDER BY revenue DESC
      LIMIT $2
      `,
      [days, limit]
    );
    return {
      period_days: days,
      customers: r.rows.map((row) => ({
        name: row.name,
        code: row.code,
        revenue: Number(row.revenue),
        invoices: Number(row.invoices),
      })),
    };
  },

  async overdue_invoices({ min_days = 30, limit = 20 } = {}) {
    const r = await q(
      `
      WITH latest AS (
        SELECT code, MAX(docdate) AS last_inv
        FROM sql_salesinvoices
        WHERE (cancelled = false OR cancelled IS NULL)
        GROUP BY code
      )
      SELECT
        c.companyname AS customer,
        c.code AS code,
        c.outstanding::numeric AS amount,
        COALESCE(CURRENT_DATE - l.last_inv::date, 0) AS days_since_last_invoice
      FROM sql_customers c
      LEFT JOIN latest l ON l.code = c.code
      WHERE c.outstanding::numeric > 0
        AND COALESCE(CURRENT_DATE - l.last_inv::date, 0) >= $1
      ORDER BY days_since_last_invoice DESC, amount DESC
      LIMIT $2
      `,
      [min_days, limit]
    );
    const total = r.rows.reduce((s, row) => s + Number(row.amount), 0);
    return {
      threshold_days: min_days,
      total_outstanding: total,
      count: r.rows.length,
      accounts: r.rows.map((row) => ({
        customer: row.customer,
        code: row.code,
        amount: Number(row.amount),
        days: Number(row.days_since_last_invoice),
      })),
    };
  },

  async sos_at_risk({ within_days = 7 } = {}) {
    const r = await q(
      `
      SELECT
        so.docno,
        so.companyname AS customer,
        so.docamt::numeric AS amount,
        MIN(sol.deliverydate) AS delivery_date,
        SUM(sol.qty::numeric) AS total_qty,
        SUM(sol.offsetqty::numeric) AS delivered_qty
      FROM sql_salesorders so
      LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey
      WHERE so.cancelled = false
        AND (so.docref3 IS NULL OR UPPER(TRIM(so.docref3)) != 'DONE')
      GROUP BY so.docno, so.companyname, so.docamt
      HAVING MIN(sol.deliverydate) IS NOT NULL
         AND MIN(sol.deliverydate) <= CURRENT_DATE + $1::int
         AND SUM(sol.offsetqty::numeric) < SUM(sol.qty::numeric)
      ORDER BY MIN(sol.deliverydate) ASC
      LIMIT 30
      `,
      [within_days]
    );
    return {
      window_days: within_days,
      at_risk: r.rows.map((row) => {
        const days = row.delivery_date
          ? Math.ceil((new Date(row.delivery_date).getTime() - Date.now()) / 86400000)
          : null;
        return {
          docno: row.docno,
          customer: row.customer,
          amount: Number(row.amount),
          delivery_date: row.delivery_date,
          days_until_delivery: days,
          qty_ordered: Number(row.total_qty),
          qty_delivered: Number(row.delivered_qty),
          qty_remaining: Number(row.total_qty) - Number(row.delivered_qty),
        };
      }),
    };
  },

  async stock_below_reorder({ limit = 20 } = {}) {
    const r = await q(
      `
      SELECT
        itemcode AS code,
        description AS name,
        balsqty::numeric AS balance,
        reorderlevel::numeric AS reorder_level,
        uom
      FROM sql_stockitems
      WHERE balsqty IS NOT NULL
        AND reorderlevel IS NOT NULL
        AND reorderlevel::numeric > 0
        AND balsqty::numeric < reorderlevel::numeric
      ORDER BY (reorderlevel::numeric - balsqty::numeric) DESC
      LIMIT $1
      `,
      [limit]
    );
    return {
      count: r.rows.length,
      items: r.rows.map((row) => ({
        code: row.code,
        name: row.name,
        balance: Number(row.balance),
        reorder_level: Number(row.reorder_level),
        shortfall: Number(row.reorder_level) - Number(row.balance),
        uom: row.uom,
      })),
    };
  },

  async product_trends({ days = 90, limit = 15 } = {}) {
    const half = Math.floor(days / 2);
    const r = await q(
      `
      WITH recent AS (
        SELECT sol.itemcode, SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_so_lines sol
        JOIN sql_salesorders so ON so.dockey = sol.dockey
        WHERE so.cancelled = false
          AND so.docdate >= CURRENT_DATE - $1::int
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      ),
      prior AS (
        SELECT sol.itemcode, SUM(sol.qty::numeric) AS qty, SUM(sol.amount::numeric) AS revenue
        FROM sql_so_lines sol
        JOIN sql_salesorders so ON so.dockey = sol.dockey
        WHERE so.cancelled = false
          AND so.docdate >= CURRENT_DATE - $2::int
          AND so.docdate <  CURRENT_DATE - $1::int
          AND sol.itemcode IS NOT NULL
        GROUP BY sol.itemcode
      ),
      meta AS (
        SELECT DISTINCT itemcode, description FROM sql_so_lines WHERE itemcode IS NOT NULL
      )
      SELECT
        r.itemcode AS code,
        MAX(m.description) AS name,
        r.qty AS curr_qty,
        r.revenue AS curr_revenue,
        COALESCE(p.qty, 0) AS prev_qty,
        COALESCE(p.revenue, 0) AS prev_revenue
      FROM recent r
      LEFT JOIN prior p ON p.itemcode = r.itemcode
      LEFT JOIN meta m ON m.itemcode = r.itemcode
      GROUP BY r.itemcode, r.qty, r.revenue, p.qty, p.revenue
      ORDER BY r.revenue DESC
      LIMIT $3
      `,
      [half, days, limit]
    );
    return {
      current_window_days: half,
      products: r.rows.map((row) => ({
        code: row.code,
        name: row.name,
        current_qty: Number(row.curr_qty),
        current_revenue: Number(row.curr_revenue),
        previous_qty: Number(row.prev_qty),
        previous_revenue: Number(row.prev_revenue),
        trend_pct:
          Number(row.prev_revenue) > 0
            ? Math.round(
                ((Number(row.curr_revenue) - Number(row.prev_revenue)) / Number(row.prev_revenue)) * 100
              )
            : null,
      })),
    };
  },

  async customer_purchase_history({ customer, limit = 20 }) {
    if (!customer) return { error: 'customer parameter required' };
    const r = await q(
      `
      SELECT
        i.docno,
        i.docdate AS date,
        i.docamt::numeric AS amount,
        i.companyname AS customer,
        i.code
      FROM sql_salesinvoices i
      WHERE (LOWER(i.companyname) LIKE LOWER($1) OR LOWER(i.code) = LOWER($2))
        AND (i.cancelled = false OR i.cancelled IS NULL)
      ORDER BY i.docdate DESC
      LIMIT $3
      `,
      [`%${customer}%`, customer, limit]
    );
    const total = r.rows.reduce((s, row) => s + Number(row.amount), 0);
    // Get outstanding from sql_customers (source of truth)
    const custCode = r.rows[0]?.code;
    let outstanding = 0;
    if (custCode) {
      const oRes = await q(`SELECT outstanding::numeric AS os FROM sql_customers WHERE code = $1`, [custCode]);
      outstanding = Number(oRes.rows[0]?.os || 0);
    }
    const paid = total - outstanding;
    return {
      query: customer,
      count: r.rows.length,
      total_invoiced: total,
      total_paid: paid,
      outstanding,
      invoices: r.rows.map((row) => ({
        docno: row.docno,
        date: row.date,
        amount: Number(row.amount),
        customer: row.customer,
        code: row.code,
      })),
    };
  },

  async gross_margin_by_product({ days = 90, limit = 15 } = {}) {
    const r = await q(
      `
      SELECT
        sol.itemcode AS code,
        MAX(sol.description) AS name,
        SUM(sol.qty::numeric) AS qty,
        SUM(sol.amount::numeric) AS revenue,
        AVG(sol.unitprice::numeric) AS avg_price
      FROM sql_so_lines sol
      JOIN sql_salesorders so ON so.dockey = sol.dockey
      WHERE so.cancelled = false
        AND so.docdate >= CURRENT_DATE - $1::int
        AND sol.itemcode IS NOT NULL
      GROUP BY sol.itemcode
      ORDER BY revenue DESC
      LIMIT $2
      `,
      [days, limit]
    );
    return {
      period_days: days,
      note: 'Gross margin requires supplier cost data. This returns revenue per product; margin calculation will be enabled once BOM cost data is integrated.',
      products: r.rows.map((row) => ({
        code: row.code,
        name: row.name,
        qty: Number(row.qty),
        revenue: Number(row.revenue),
        avg_price: Number(row.avg_price),
      })),
    };
  },

  async recent_activity({ days = 7 } = {}) {
    const r = await q(
      `
      (SELECT 'SO' AS type, docno, docdate AS date, companyname AS party, docamt::numeric AS amount
       FROM sql_salesorders
       WHERE docdate >= CURRENT_DATE - $1::int
         AND cancelled = false)
      UNION ALL
      (SELECT 'INV' AS type, docno, docdate, companyname, docamt::numeric
       FROM sql_salesinvoices
       WHERE docdate >= CURRENT_DATE - $1::int
         AND (cancelled = false OR cancelled IS NULL))
      UNION ALL
      (SELECT 'DO' AS type, docno, docdate, companyname, docamt::numeric
       FROM sql_deliveryorders
       WHERE docdate >= CURRENT_DATE - $1::int
         AND (cancelled = false OR cancelled IS NULL))
      UNION ALL
      (SELECT 'RV' AS type, docno, docdate, description, docamt::numeric
       FROM sql_receiptvouchers
       WHERE docdate >= CURRENT_DATE - $1::int
         AND (cancelled = false OR cancelled IS NULL))
      ORDER BY date DESC
      LIMIT 50
      `,
      [days]
    );
    const counts = r.rows.reduce((acc, row) => {
      acc[row.type] = (acc[row.type] || 0) + 1;
      return acc;
    }, {});
    return {
      period_days: days,
      counts,
      total: r.rows.length,
      activity: r.rows.map((row) => ({
        type: row.type,
        docno: row.docno,
        date: row.date,
        party: row.party,
        amount: Number(row.amount),
      })),
    };
  },
};

// ── CLAUDE TOOL DEFINITIONS ───────────────────────────────────
// Descriptions are what Claude reads to decide when to call each tool.
// Keep them clear, specific, and oriented to business intent.

const TOOL_DEFINITIONS = [
  {
    name: 'top_customers',
    description:
      'Get the top N customers by revenue (invoice amount) over a rolling window. Use when the user asks about top customers, best customers, biggest buyers, or revenue concentration.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days to look back. Default 30 for "this month", 90 for "this quarter".' },
        limit: { type: 'integer', description: 'How many customers to return. Default 10.' },
      },
    },
  },
  {
    name: 'overdue_invoices',
    description:
      'Get customers with overdue receivables, grouped by account. Use when the user asks about overdue invoices, aged AR, who owes us money, or late payments.',
    input_schema: {
      type: 'object',
      properties: {
        min_days: { type: 'integer', description: 'Minimum days since last invoice to count as overdue. Default 30.' },
        limit: { type: 'integer', description: 'How many accounts to return. Default 20.' },
      },
    },
  },
  {
    name: 'sos_at_risk',
    description:
      'Get sales orders at risk of missing their delivery date (partial or not yet shipped). Use when the user asks about late orders, delivery risk, production urgency, or what needs to ship soon.',
    input_schema: {
      type: 'object',
      properties: {
        within_days: { type: 'integer', description: 'Upcoming delivery window in days. Default 7.' },
      },
    },
  },
  {
    name: 'stock_below_reorder',
    description:
      'Get stock items where the current balance is below the reorder level. Use when the user asks about low stock, items to reorder, or inventory alerts.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many items to return. Default 20.' },
      },
    },
  },
  {
    name: 'product_trends',
    description:
      'Compare product sales performance between two equal time windows to identify trending products. Use when the user asks which products are growing, declining, or the sales trend of a product category.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Total days to analyse. The window is split in half. Default 90.' },
        limit: { type: 'integer', description: 'How many products to return. Default 15.' },
      },
    },
  },
  {
    name: 'customer_purchase_history',
    description:
      'Get the invoice history for a specific customer. Use when the user asks about a named customer\'s orders, purchases, or payment history.',
    input_schema: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'Customer name or code to search for (partial match supported).' },
        limit: { type: 'integer', description: 'How many invoices to return. Default 20.' },
      },
      required: ['customer'],
    },
  },
  {
    name: 'gross_margin_by_product',
    description:
      'Get revenue by product. Gross margin calculation is flagged as pending until BOM cost data is integrated. Use when the user asks about margins, product profitability, or most profitable items.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days to look back. Default 90.' },
        limit: { type: 'integer', description: 'How many products to return. Default 15.' },
      },
    },
  },
  {
    name: 'recent_activity',
    description:
      'Get a unified feed of recent SO, DO, Invoice, and Receipt Voucher activity. Use when the user asks "what happened this week/today", "show me recent activity", or wants an overview of recent business movements.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days to look back. Default 7.' },
      },
    },
  },
];

// ── SYSTEM PROMPT ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the OCC AI Assistant, helping the team at Seri Rasa (a Halal OEM spice operation) understand their business data.

You have read-only access to the OCC Postgres database through a set of tools. When asked about business data (customers, orders, stock, AR, trends), call the appropriate tool to get the real answer. Never make up numbers.

After getting data from a tool, provide a clear, concise answer. Structure your response as follows:

1. A one or two sentence summary of the finding (e.g., "You have 5 customers with overdue receivables totaling RM 121,796.").
2. The most important 3–10 items from the data, ordered by relevance (biggest amount, longest overdue, etc.).

Currency is Malaysian Ringgit (RM). Use RM prefix and two decimals for monetary values.

Keep responses short and action-oriented. If data seems missing or unusual, say so honestly. If you cannot answer a question with the available tools, explain what you'd need.

You are read-only: you cannot create, update, or delete any records. If the user asks you to perform a write action, politely explain that you can only help them find information.`;

// ── ANTHROPIC API CALL ────────────────────────────────────────

async function callClaude(messages, tools) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured in Vercel environment.');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API: ${resp.status} ${body}`);
  }
  return resp.json();
}

// ── MAIN HANDLER ──────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const userMessages = Array.isArray(body.messages) ? body.messages : [];
    if (userMessages.length === 0) {
      return res.status(400).json({ error: 'No messages provided' });
    }

    // Tool-use loop. Claude may request a tool; we execute and feed results back.
    let messages = userMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let final = null;
    let usedTools = [];
    let lastToolResult = null;

    // Max 4 tool-use rounds to prevent runaway loops.
    for (let i = 0; i < 4; i++) {
      const resp = await callClaude(messages, TOOL_DEFINITIONS);

      // Check if Claude wants to use a tool
      const toolUseBlocks = resp.content.filter((c) => c.type === 'tool_use');
      const textBlocks = resp.content.filter((c) => c.type === 'text');

      if (toolUseBlocks.length === 0) {
        // Claude is done — plain text response
        final = textBlocks.map((b) => b.text).join('\n\n');
        break;
      }

      // Execute all requested tools
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults = [];
      for (const tu of toolUseBlocks) {
        const toolFn = TOOLS[tu.name];
        usedTools.push(tu.name);
        try {
          const result = toolFn ? await toolFn(tu.input || {}) : { error: `Unknown tool: ${tu.name}` };
          lastToolResult = result;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          console.error(`Tool ${tu.name} failed:`, err);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Build structured UI data from the last tool result (if any).
    // The frontend renders these as clean cards inline with the chat.
    let uiData = null;
    if (lastToolResult && !lastToolResult.error) {
      uiData = buildUIDataFromToolResult(usedTools[usedTools.length - 1], lastToolResult);
    }

    return res.status(200).json({
      content: final || 'I reached the maximum number of tool-use rounds without finishing. Try rephrasing your question.',
      data: uiData,
      source: usedTools.length > 0 ? `Tools used: ${usedTools.join(', ')}` : null,
    });
  } catch (e) {
    console.error('ai-assistant error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Build a simple list-style data payload for the chat UI.
function buildUIDataFromToolResult(toolName, result) {
  const fmt = (n) =>
    `RM ${Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (toolName === 'top_customers' && Array.isArray(result.customers)) {
    return {
      items: result.customers.slice(0, 10).map((c) => ({
        name: c.name,
        value: fmt(c.revenue),
        meta: `${c.invoices} invoices · ${c.code}`,
      })),
      actions: [
        { label: 'View all customers', href: '#management/customers' },
      ],
    };
  }

  if (toolName === 'overdue_invoices' && Array.isArray(result.accounts)) {
    return {
      items: result.accounts.slice(0, 10).map((a) => ({
        name: a.customer,
        value: fmt(a.amount),
        meta: `${a.days} days since last invoice · ${a.code}`,
      })),
      actions: [
        { label: 'Open AR overview', href: '#management' },
      ],
    };
  }

  if (toolName === 'sos_at_risk' && Array.isArray(result.at_risk)) {
    return {
      items: result.at_risk.slice(0, 10).map((s) => ({
        name: `${s.docno} — ${s.customer}`,
        value: fmt(s.amount),
        meta: `Delivery ${new Date(s.delivery_date).toLocaleDateString('en-MY')} · ${s.days_until_delivery} days · ${s.qty_remaining} remaining`,
      })),
      actions: [
        { label: 'Open production queue', href: '#production' },
      ],
    };
  }

  if (toolName === 'stock_below_reorder' && Array.isArray(result.items)) {
    return {
      items: result.items.slice(0, 10).map((i) => ({
        name: i.name || i.code,
        value: `${i.balance} ${i.uom || ''}`,
        meta: `Reorder at ${i.reorder_level} · short by ${i.shortfall}`,
      })),
      actions: [
        { label: 'Open procurement', href: '#procurement' },
      ],
    };
  }

  if (toolName === 'product_trends' && Array.isArray(result.products)) {
    return {
      items: result.products.slice(0, 10).map((p) => ({
        name: p.name || p.code,
        value: fmt(p.current_revenue),
        meta:
          p.trend_pct != null
            ? `${p.trend_pct > 0 ? '+' : ''}${p.trend_pct}% vs previous window`
            : 'New product',
      })),
    };
  }

  if (toolName === 'customer_purchase_history' && Array.isArray(result.invoices)) {
    return {
      items: result.invoices.slice(0, 10).map((i) => ({
        name: `${i.docno}`,
        value: fmt(i.amount),
        meta: `${new Date(i.date).toLocaleDateString('en-MY')}`,
      })),
    };
  }

  if (toolName === 'recent_activity' && Array.isArray(result.activity)) {
    return {
      items: result.activity.slice(0, 15).map((a) => ({
        name: `${a.type} ${a.docno}`,
        value: fmt(a.amount),
        meta: `${new Date(a.date).toLocaleDateString('en-MY')} · ${a.party || ''}`,
      })),
    };
  }

  if (toolName === 'gross_margin_by_product' && Array.isArray(result.products)) {
    return {
      items: result.products.slice(0, 10).map((p) => ({
        name: p.name || p.code,
        value: fmt(p.revenue),
        meta: `${p.qty} units · avg ${fmt(p.avg_price)}/unit`,
      })),
    };
  }

  return null;
}
