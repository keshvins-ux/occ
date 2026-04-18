// ============================================================
// PO EXTRACTION API — BULLETPROOF VERSION
// File: /api/extract-po.js
//
// Uses Claude Opus for superior reasoning on complex POs.
// Injects customer-specific history (past orders, pricing, product mappings)
// so Claude learns and adapts per customer.
//
// Flow:
//   1. Build content blocks from PDF/image/text
//   2. Load customer memory (past confirmed extractions with pricing)
//   3. Load stock items + customer list for matching
//   4. Call Claude Opus with system prompt + memory context
//   5. Extract JSON from response (handles wrappers/fences)
//   6. Validate and return
//
// After user confirms/edits, frontend POSTs to /api/po-memory to save
// the confirmed extraction — next time this customer sends a PO,
// Claude sees their pricing, product mappings, and format patterns.
// ============================================================

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

import { Pool } from 'pg';

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}
async function dbQuery(sql, params = []) {
  const client = await getPool().connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

// Models in priority order — Opus first for best reasoning
const MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022',
];

// System prompt — forces JSON-only, explains the learning context
const SYSTEM_PROMPT = `You are a purchase order data extraction engine for Seri Rasa (also known as Mazza Spice / Rempah Emas), a Malaysian halal spice manufacturer.

CRITICAL RULES:
1. Your ENTIRE response must be a single valid JSON object. Start with { and end with }. No text before or after. No markdown fences. No explanations.
2. The "customerName" is the company who WROTE and SENT the PO (the BUYER), NOT "Mazza Spice", "Seri Rasa", or "Rempah Emas" — these are the SELLER.
3. Extract ALL line items — do not skip any row. Ignore rows that are clearly not products (e.g. references like "SINV2604/").
4. For each field, provide a confidence score (0-100).
5. Match product descriptions to stock codes using semantic/fuzzy matching (e.g. "CHILLY POWDER" = "Chilli Powder", "JINTAN MANIS" = "Fennel Seeds", "JINTAN PUTIH" = "Cumin", "BIJI KETUMBAR" = "Coriander Seeds", "SERBUK KUNYIT" = "Turmeric Powder", "SERBUK CILI" = "Chilli Powder", "LADA HITAM" = "Black Pepper", "YELLOW DHALL" = "Dhal").
6. If CUSTOMER HISTORY is provided below, use it to:
   - Match products to the same stock codes used in previous orders
   - Apply the same pricing from the most recent confirmed order
   - Recognize the customer's PO format and extract accordingly
   - If no price is on the PO, use the last confirmed price for that customer+product
7. Quantities must be exact whole numbers as written on the PO.
8. For PDF documents, provide bbox coordinates as normalised values (0-1 range).`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  }

  try {
    const { messages, pdfBase64, fileName, customerCodeHint } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: "No messages provided" });
    }

    // Build content blocks
    const contentBlocks = buildContentBlocks(messages, pdfBase64);
    if (!contentBlocks.length) {
      return res.status(400).json({ error: "Could not build content from provided messages" });
    }

    // Load reference data in parallel
    const [customerMemory, stockItems, customers] = await Promise.all([
      loadCustomerMemory(customerCodeHint),
      loadStockItems(),
      loadCustomers(),
    ]);

    // Build the user prompt with context
    const contextPrompt = buildContextPrompt(customerMemory, stockItems, customers);

    // Ensure the context prompt is appended as a text block
    const fullContent = [
      ...contentBlocks,
      { type: 'text', text: contextPrompt },
    ];

    // Try extraction with retry
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const model = MODELS[Math.min(attempt, MODELS.length - 1)];
        const isRetry = attempt > 0;

        const claudeMessages = [{
          role: 'user',
          content: isRetry
            ? [...fullContent, { type: 'text', text: '\n\nREMINDER: Your response must be ONLY a JSON object. Start with { and end with }. No other text.' }]
            : fullContent,
        }];

        const responseText = await callClaude(anthropicKey, model, claudeMessages);
        const json = extractJson(responseText);

        if (!json) {
          lastError = `Attempt ${attempt + 1}: Could not extract valid JSON`;
          console.error(lastError, '| Response start:', responseText.slice(0, 200));
          continue;
        }

        // Enrich with customer pricing from memory if prices are missing
        if (json.items && customerMemory.length > 0) {
          enrichWithHistoricalPricing(json, customerMemory);
        }

        const validation = validateExtraction(json);

        return res.status(200).json({
          content: [{ type: 'text', text: JSON.stringify(json) }],
          model,
          attempt: attempt + 1,
          validation,
          memoryUsed: customerMemory.length > 0,
        });

      } catch (e) {
        lastError = e.message;
        console.error(`Extract PO attempt ${attempt + 1}:`, e.message);
        if (e.message.includes('rate') || e.message.includes('429')) {
          await sleep(2000 * (attempt + 1));
        }
      }
    }

    return res.status(500).json({
      error: `PO extraction failed after 3 attempts. Last error: ${lastError}`,
      suggestion: 'Try a clearer image/PDF, or check API key and credit balance.',
    });

  } catch (err) {
    console.error('Extract PO error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Load customer memory (past confirmed orders with pricing) ─
async function loadCustomerMemory(customerCodeHint) {
  if (!customerCodeHint) return [];
  try {
    const r = await dbQuery(
      `SELECT extracted, confirmed_at FROM occ_po_memory
       WHERE customer_code = $1
       ORDER BY confirmed_at DESC LIMIT 5`,
      [customerCodeHint]
    );
    return r.rows.map(row => row.extracted);
  } catch {
    return [];
  }
}

// ── Load stock items for matching ─────────────────────────────
async function loadStockItems() {
  try {
    const r = await dbQuery(
      `SELECT code, description FROM sql_stockitems
       WHERE isactive = true
       ORDER BY code LIMIT 500`
    );
    return r.rows;
  } catch {
    return [];
  }
}

// ── Load customers for matching ───────────────────────────────
async function loadCustomers() {
  try {
    const r = await dbQuery(
      `SELECT code, companyname FROM sql_customers
       ORDER BY companyname LIMIT 300`
    );
    return r.rows;
  } catch {
    return [];
  }
}

// ── Build context prompt with memory + reference data ─────────
function buildContextPrompt(memory, stockItems, customers) {
  let prompt = '\n\n';

  // Customer history (most important for learning)
  if (memory.length > 0) {
    prompt += `CUSTOMER HISTORY — Previous confirmed orders from this customer (use for product matching and pricing):\n`;
    for (let i = 0; i < memory.length; i++) {
      const m = memory[i];
      prompt += `\nOrder ${i + 1}:\n`;
      if (m.customerName) prompt += `  Customer: ${m.customerName}\n`;
      if (m.poNumber) prompt += `  PO: ${m.poNumber}\n`;
      if (m.items && m.items.length > 0) {
        prompt += `  Items:\n`;
        for (const item of m.items) {
          const parts = [`    - "${item.description}"`];
          if (item.itemcode) parts.push(`→ ${item.itemcode}`);
          if (item.itemdescription) parts.push(`(${item.itemdescription})`);
          if (item.qty != null) parts.push(`qty: ${item.qty}`);
          if (item.unitprice != null) parts.push(`price: RM ${item.unitprice}`);
          if (item.amount != null) parts.push(`amt: RM ${item.amount}`);
          prompt += parts.join(' ') + '\n';
        }
      }
    }
    prompt += '\nUse the above history to match products and apply pricing for this customer.\n\n';
  }

  // Stock items
  if (stockItems.length > 0) {
    prompt += `STOCK ITEMS (code|description) — match PO items to these:\n`;
    prompt += stockItems.map(s => `${s.code}|${s.description}`).join('\n');
    prompt += '\n\n';
  }

  // Customer list
  if (customers.length > 0) {
    prompt += `CUSTOMER LIST (code|name) — match the PO sender to one of these:\n`;
    prompt += customers.map(c => `${c.code}|${c.companyname}`).join('\n');
    prompt += '\n\n';
  }

  // Output format
  prompt += `Return ONLY this JSON structure:
{
  "customerCode": "matching customer code or null",
  "customerCode_confidence": 85,
  "customerName": "company name of who ISSUED this PO (the BUYER)",
  "customerName_confidence": 90,
  "customerName_bbox": { "x": 0.05, "y": 0.85, "width": 0.4, "height": 0.05, "page": 1 },
  "poNumber": "PO reference",
  "poNumber_confidence": 95,
  "poNumber_bbox": { "x": 0.6, "y": 0.88, "width": 0.3, "height": 0.04, "page": 1 },
  "deliveryDate": "YYYY-MM-DD or null",
  "deliveryDate_confidence": 70,
  "notes": "special instructions or null",
  "items": [
    {
      "description": "item name as written on PO",
      "description_confidence": 90,
      "description_bbox": { "x": 0.05, "y": 0.6, "width": 0.35, "height": 0.03, "page": 1 },
      "itemcode": "best matching stock code or null",
      "itemcode_confidence": 75,
      "itemdescription": "matched stock description",
      "qty": 100,
      "qty_confidence": 95,
      "qty_bbox": { "x": 0.55, "y": 0.6, "width": 0.08, "height": 0.03, "page": 1 },
      "uom": "KG",
      "unitprice": 12.50,
      "unitprice_confidence": 80,
      "unitprice_source": "from_po | from_history | not_found",
      "amount": 1250.00
    }
  ]
}

IMPORTANT PRICING RULES:
- If the PO shows a unit price, use it and set unitprice_source to "from_po"
- If no price on PO but customer history has a price for this product, use the most recent historical price and set unitprice_source to "from_history"
- If no price available at all, set unitprice to null and unitprice_source to "not_found"
- amount = qty × unitprice (or null if no price)`;

  return prompt;
}

// ── Enrich items with historical pricing if missing ───────────
function enrichWithHistoricalPricing(json, memory) {
  if (!json.items || !Array.isArray(json.items)) return;

  // Build a pricing lookup from memory: itemcode → latest price
  const priceLookup = {};
  for (const m of memory) {
    if (!m.items) continue;
    for (const item of m.items) {
      if (item.itemcode && item.unitprice != null) {
        // Only set if not already set (memory is ordered newest-first)
        if (!priceLookup[item.itemcode]) {
          priceLookup[item.itemcode] = Number(item.unitprice);
        }
      }
    }
  }

  // Apply to items missing prices
  for (const item of json.items) {
    if (item.unitprice == null && item.itemcode && priceLookup[item.itemcode]) {
      item.unitprice = priceLookup[item.itemcode];
      item.unitprice_source = 'from_history';
      item.unitprice_confidence = 60; // lower confidence for historical prices
      if (item.qty != null) {
        item.amount = item.qty * item.unitprice;
      }
    }
  }
}

// ── Build content blocks from various input formats ───────────
function buildContentBlocks(messages, pdfBase64) {
  const blocks = [];
  const msg = messages[0];

  if (pdfBase64) {
    blocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
    });
    const textPrompt = typeof msg.content === 'string'
      ? msg.content
      : (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (textPrompt) blocks.push({ type: 'text', text: textPrompt });
    return blocks;
  }

  if (typeof msg.content === 'string') {
    blocks.push({ type: 'text', text: msg.content });
    return blocks;
  }

  for (const block of (msg.content || [])) {
    if (typeof block === 'string') {
      blocks.push({ type: 'text', text: block });
    } else if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image_url' && block.image_url?.url) {
      const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      }
    } else if (block.type === 'image' && block.source) {
      blocks.push(block);
    } else if (block.type === 'document' && block.source) {
      blocks.push(block);
    }
  }
  return blocks;
}

// ── Call Claude API ───────────────────────────────────────────
async function callClaude(apiKey, model, messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages,
    }),
    signal: AbortSignal.timeout(55000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  if (!textBlocks.length) throw new Error('Claude returned no text content');

  return textBlocks.map(b => b.text).join('\n');
}

// ── Extract JSON from Claude's response ──────────────────────
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Step 1: Direct parse
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch {}
  }

  // Step 2: Strip markdown fences
  const stripped = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  if (stripped.startsWith('{')) {
    try { return JSON.parse(stripped); } catch {}
  }

  // Step 3: Bracket matching — find outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0, inString = false, escape = false, jsonEnd = -1;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
  }
  if (jsonEnd === -1) return null;

  const candidate = trimmed.slice(firstBrace, jsonEnd + 1);
  try { return JSON.parse(candidate); } catch {}

  // Step 4: Fix trailing commas
  try {
    return JSON.parse(candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } catch {}

  return null;
}

// ── Validate extraction ──────────────────────────────────────
function validateExtraction(json) {
  const missing = [], warnings = [];

  if (!json.customerName) missing.push('customerName');
  if (!json.items) missing.push('items');
  else if (!Array.isArray(json.items)) missing.push('items (not an array)');
  else if (json.items.length === 0) warnings.push('items array is empty');

  if (!json.customerCode) warnings.push('customerCode not matched');
  if (!json.poNumber) warnings.push('poNumber not found');
  if (!json.deliveryDate) warnings.push('deliveryDate not found');

  if (Array.isArray(json.items)) {
    for (let i = 0; i < json.items.length; i++) {
      const item = json.items[i];
      if (!item.description && !item.itemcode) warnings.push(`Item ${i + 1}: no description or itemcode`);
      if (item.qty == null) warnings.push(`Item ${i + 1}: no quantity`);
    }
  }

  return { valid: missing.length === 0, missing, warnings };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
