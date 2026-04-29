// ============================================================
// PO EXTRACTION API — V2 ENHANCED
//
// Key enhancement: after identifying the customer from the PO,
// queries their MOST RECENT SO + SO lines from Postgres.
// This gives Opus REAL pricing and product mappings from actual
// confirmed sales orders — not just memory cache.
//
// Flow:
//   1. First pass: quick customer identification from PO text
//   2. Query Postgres: customer's last 3 SOs + all line items
//   3. Second pass: full extraction with SO context injected
//   4. Opus matches PO items → stock codes using SO history
//   5. Opus applies pricing from most recent SO for each item
//   6. Returns enriched results with pricing source
//
// Pricing source priority:
//   "from_po"     — price was written on the PO itself
//   "from_so"     — price from customer's most recent SO (with SO# and date)
//   "not_found"   — no price available, team must enter manually
// ============================================================

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

import { Pool } from 'pg';

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    // Fail fast if pool is starved, rather than silently waiting until
    // Vercel kills the function at 60s. Better to return a clean 503.
    connectionTimeoutMillis: 8000,
    // Cap any single query at 12s. extract-po queries are small (LIMIT 500
    // on stockitems, LIMIT 300 on customers) and should complete in <2s.
    // 12s gives 6x headroom; anything longer means something's stuck.
    statement_timeout: 12000,
  });
  return _pool;
}
async function db(sql, params = []) {
  const client = await getPool().connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

const MODELS = ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'];

// Inline config for ESM compatibility (extract-po uses import/export)
const tenantName = process.env.TENANT_NAME || 'Seri Rasa';
const tenantLegal = process.env.TENANT_LEGAL || 'Vertical Target Services Sdn. Bhd.';
const tenantAlias = process.env.TENANT_ALIAS || 'Mazza Spice / Rempah Emas';
const tenantIndustry = process.env.TENANT_INDUSTRY || 'Halal OEM spice and condiment manufacturer';
const tenantLocation = process.env.TENANT_LOCATION || 'Rawang, Selangor, Malaysia';

function buildSystemPrompt() {
  const sellerNames = [tenantName, tenantLegal, ...tenantAlias.split('/').map(s => s.trim())].filter(Boolean);
  const sellerList = sellerNames.map(n => `"${n}"`).join(', ');
  return `You are a purchase order extraction engine for ${tenantName} (also known as ${tenantAlias}), a ${tenantIndustry} in ${tenantLocation}.

CRITICAL RULES:
1. Your ENTIRE response must be a single valid JSON object. Start with { and end with }. No text before or after. No markdown. No explanations.
2. The "customerName" is the company who WROTE and SENT the PO (the BUYER). NOT ${sellerList} — these are the SELLER.
3. Extract ALL product line items. Ignore rows that are clearly not products (references, invoice numbers, empty rows).
4. For each field, provide a confidence score (0-100).
5. Match products using fuzzy/semantic matching:
   "CHILLY POWDER" = "Chilli Powder", "SERBUK CILI" = "Chilli Powder",
   "TURMERIC POWDER" = "Turmeric Powder", "SERBUK KUNYIT" = "Turmeric Powder",
   "KASHMIRI CHILLY" = "Kashmiri Chilli", "GREEN CARDAMOM" = "Cardamom",
   "CASHEWNUT" = "Cashew Nut", "BLACK PEPPER" = "Black Pepper",
   "YELLOW DHALL" = "Dhal", "JINTAN MANIS" = "Fennel Seeds",
   "JINTAN PUTIH" = "Cumin", "BIJI KETUMBAR" = "Coriander Seeds",
   "LADA HITAM" = "Black Pepper"
6. If RECENT SALES ORDERS are provided, use them to:
   - Match PO products to EXACT stock codes from recent SOs
   - Apply the MOST RECENT unit price for each product
   - Set unitprice_source to "from_so" with the SO number and date
7. Quantities must be exact whole numbers as written on the PO.
8. UOM MAPPING — The PO may use abbreviations. You MUST map them to these EXACT valid values:
   Valid UOMs (these six only): UNIT, CTN, BAG, CARTON, KG, PKT
   Common mappings:
   "KG" or "kg" or "kilo" or "kilogram" → "KG",
   "CTN" or "ctn" → "CTN" (small carton/case),
   "CARTON" or "cartons" → "CARTON" (large carton — distinct from CTN in this catalogue),
   "BAG" or "bag" or "beg" or "BG" → "BAG",
   "PKT" or "PT" or "pkt" or "packet" or "PCK" → "PKT",
   "UNIT" or "UN" or "TU" or "tub" or "TUB" or "jerry" or "drum" or "pail" → "UNIT",
   "PCS" or "pieces" or "EA" or "each" or "PC" → "UNIT",
   "BTL" or "bottle" or "botol" → "UNIT",
   "BOX" or "kotak" → "UNIT",
   "TIN" or "tin" → "UNIT",
   "SET" or "set" → "UNIT",
   "JC" → "UNIT"
   If uncertain, default to "UNIT". NEVER use the raw PO abbreviation — always map to the valid list above.
9. For PDF documents, provide bbox coordinates as normalised values (0-1 range).`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const { messages, pdfBase64, fileName, customerCodeHint } = req.body;
    if (!messages?.length) return res.status(400).json({ error: "No messages provided" });

    const contentBlocks = buildContentBlocks(messages, pdfBase64);
    if (!contentBlocks.length) return res.status(400).json({ error: "Could not parse input" });

    // Load reference data in parallel
    const [stockItems, customers] = await Promise.all([loadStockItems(), loadCustomers()]);

    // Load recent SOs for this customer (the key enhancement)
    let recentSOs = [];
    if (customerCodeHint) {
      recentSOs = await loadRecentSOs(customerCodeHint);
    }

    // Build context and call Opus
    const contextPrompt = buildContextPrompt(recentSOs, stockItems, customers);
    const fullContent = [...contentBlocks, { type: 'text', text: contextPrompt }];

    let lastError = null;
    // Single attempt. Claude calls from Vercel iad1 take 30-40s; a retry
    // would risk hitting the 120s function budget. If extraction fails,
    // the team clicks Extract again — the second click hits a warm function
    // and gets fresh network conditions.
    for (let attempt = 0; attempt < 1; attempt++) {
      try {
        const model = MODELS[Math.min(attempt, MODELS.length - 1)];
        const claudeMessages = [{
          role: 'user',
          content: attempt > 0
            ? [...fullContent, { type: 'text', text: '\n\nREMINDER: Respond ONLY with a JSON object. Start with { end with }. No other text.' }]
            : fullContent,
        }];

        const { text: responseText, stopReason } = await callClaude(anthropicKey, model, claudeMessages);

        // Truncation detection — Claude hit max_tokens limit mid-response.
        // Retrying won't help (same model, same prompt = same truncation point);
        // return a clean error so the team knows to use Paste Text with fewer items.
        if (stopReason === 'max_tokens') {
          return res.status(422).json({
            error: 'Response too large — the PO has too many line items to process in one go.',
            suggestion: 'Try uploading a smaller portion of the PO (fewer items at a time), or use Paste Text with just the items list.',
            stopReason,
          });
        }

        const json = extractJson(responseText);

        if (!json) {
          lastError = `Attempt ${attempt + 1}: Could not extract JSON`;
          console.error(lastError, '| stopReason:', stopReason, '| Start:', responseText.slice(0, 200));
          continue;
        }

        // If we didn't have customerCodeHint but Opus identified the customer,
        // and we haven't loaded SOs yet — load them now and enrich pricing
        if (!customerCodeHint && json.customerCode && recentSOs.length === 0) {
          recentSOs = await loadRecentSOs(json.customerCode);
          if (recentSOs.length > 0) {
            enrichWithSOPricing(json, recentSOs);
          }
        }

        // Post-process: enrich with SO pricing if Opus missed any
        if (recentSOs.length > 0) {
          enrichWithSOPricing(json, recentSOs);
        }

        const validation = validateExtraction(json);

        return res.status(200).json({
          content: [{ type: 'text', text: JSON.stringify(json) }],
          model,
          attempt: attempt + 1,
          validation,
          soContext: recentSOs.length > 0 ? {
            ordersUsed: recentSOs.length,
            latestSO: recentSOs[0]?.docno,
            latestDate: recentSOs[0]?.docdate,
          } : null,
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
      error: `PO extraction failed. ${lastError}`,
      suggestion: 'Try again — the model or network may have been slow. If it keeps failing, the PO may be too large; try Paste Text with fewer items.',
    });

  } catch (err) {
    console.error('Extract PO error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Load RECENT SALES ORDERS with line items for a customer ───
// This is the key enhancement — real SO data from Postgres
async function loadRecentSOs(customerCode) {
  try {
    // Get last 3 SOs for this customer (non-cancelled)
    const soRes = await db(
      `SELECT docno, docdate, docamt::numeric AS amount, code
       FROM sql_salesorders
       WHERE code = $1 AND (cancelled = false OR cancelled IS NULL)
       ORDER BY docdate DESC, dockey DESC
       LIMIT 3`,
      [customerCode]
    );
    if (soRes.rows.length === 0) return [];

    // Get line items for these SOs (join via dockey)
    const dockets = soRes.rows.map(r => r.docno);
    const linesRes = await db(
      `SELECT so.docno, sol.itemcode, sol.description, sol.qty::numeric AS qty,
              sol.unitprice::numeric AS unitprice, (sol.qty::numeric * sol.unitprice::numeric) AS amount,
              sol.uom
       FROM sql_so_lines sol
       JOIN sql_salesorders so ON so.dockey = sol.dockey
       WHERE so.docno = ANY($1)
       ORDER BY so.docno, sol.seq`,
      [dockets]
    );

    // Group lines by SO
    const linesByDoc = {};
    for (const line of linesRes.rows) {
      if (!linesByDoc[line.docno]) linesByDoc[line.docno] = [];
      linesByDoc[line.docno].push({
        itemcode: line.itemcode,
        description: line.description,
        qty: Number(line.qty || 0),
        unitprice: Number(line.unitprice || 0),
        amount: Number(line.amount || 0),
        uom: line.uom,
      });
    }

    return soRes.rows.map(so => ({
      docno: so.docno,
      docdate: so.docdate,
      amount: Number(so.amount || 0),
      lines: linesByDoc[so.docno] || [],
    }));
  } catch (e) {
    console.error('loadRecentSOs error:', e.message);
    return [];
  }
}

// ── Load stock items ─────────────────────────────────────────
async function loadStockItems() {
  try {
    const r = await db('SELECT code, description FROM sql_stockitems WHERE isactive = true ORDER BY code LIMIT 500');
    return r.rows;
  } catch { return []; }
}

// ── Load customers ───────────────────────────────────────────
async function loadCustomers() {
  try {
    const r = await db('SELECT code, companyname FROM sql_customers ORDER BY companyname LIMIT 300');
    return r.rows;
  } catch { return []; }
}

// ── Build context prompt ─────────────────────────────────────
function buildContextPrompt(recentSOs, stockItems, customers) {
  let prompt = '\n\n';

  // Recent Sales Orders (the most valuable context for pricing)
  if (recentSOs.length > 0) {
    prompt += `RECENT SALES ORDERS FOR THIS CUSTOMER — use these for product matching and pricing:\n`;
    for (const so of recentSOs) {
      const date = so.docdate ? new Date(so.docdate).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }) : '?';
      prompt += `\n${so.docno} (${date}) — Total: RM ${so.amount.toFixed(2)}\n`;
      for (const line of so.lines) {
        prompt += `  ${line.itemcode} | ${line.description} | qty: ${line.qty} ${line.uom || ''} | RM ${line.unitprice.toFixed(2)}/unit | RM ${line.amount.toFixed(2)}\n`;
      }
    }
    prompt += `\nIMPORTANT: Use the most recent SO's unit prices for each product. If a PO item matches a stock code from these SOs, apply that price and set unitprice_source to "from_so" and include the SO number.\n\n`;
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
      "itemcode": "best matching stock code",
      "itemcode_confidence": 75,
      "itemdescription": "matched stock description",
      "qty": 100,
      "qty_confidence": 95,
      "qty_bbox": { "x": 0.55, "y": 0.6, "width": 0.08, "height": 0.03, "page": 1 },
      "uom": "KG",
      "unitprice": 12.50,
      "unitprice_confidence": 80,
      "unitprice_source": "from_po | from_so | not_found",
      "unitprice_so_ref": "SO-00375 (16 Apr 2026)",
      "amount": 1250.00
    }
  ]
}

UOM RULES — ALWAYS map customer UOM abbreviations to these EXACT values:
- KG, KILOGRAM, KGS → "KG"
- CTN, CARTON, CRTN → "CTN"  
- PKT, PACKET, PK, PT, PCK → "PKT"
- UNIT, UNITS, UN, TU, TUB, EA, EACH, JC, JERRY CAN, CAN → "UNIT"
- PCS, PIECE, PIECES, PC → "PCS"
- BAG, BAGS, BG → "BAG"
- BTL, BOTTLE, BOTTLES → "BTL"
- BOX, BOXES, BX → "BOX"
- SET, SETS → "SET"
- TIN, TINS → "TIN"
Only output one of: KG, CTN, PKT, UNIT, PCS, BAG, BTL, SET, BOX, TIN. Never output the customer's raw abbreviation.

PRICING RULES:
- If the PO shows a unit price → use it, set unitprice_source: "from_po"
- If no price on PO but RECENT SALES ORDERS have a price for this product → use the most recent price, set unitprice_source: "from_so", set unitprice_so_ref: "SO-XXXXX (date)"
- If no price available at all → set unitprice: null, unitprice_source: "not_found"
- amount = qty × unitprice (or null if no price)`;

  return prompt;
}

// ── Enrich items with SO pricing (post-processing fallback) ──
function enrichWithSOPricing(json, recentSOs) {
  if (!json.items || !Array.isArray(json.items) || recentSOs.length === 0) return;

  // Build price lookup: itemcode → { price, soRef }
  const priceLookup = {};
  for (const so of recentSOs) {
    const date = so.docdate ? new Date(so.docdate).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    for (const line of so.lines) {
      if (line.itemcode && line.unitprice > 0 && !priceLookup[line.itemcode]) {
        priceLookup[line.itemcode] = {
          price: line.unitprice,
          ref: `${so.docno} (${date})`,
        };
      }
    }
  }

  // Apply to items missing prices
  for (const item of json.items) {
    if ((item.unitprice == null || item.unitprice === 0) && item.itemcode && priceLookup[item.itemcode]) {
      const match = priceLookup[item.itemcode];
      item.unitprice = match.price;
      item.unitprice_source = 'from_so';
      item.unitprice_so_ref = match.ref;
      item.unitprice_confidence = 70;
      if (item.qty != null) item.amount = item.qty * item.unitprice;
    }
  }
}

// ── Build content blocks ─────────────────────────────────────
function buildContentBlocks(messages, pdfBase64) {
  const blocks = [];
  const msg = messages[0];

  if (pdfBase64) {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
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
    if (typeof block === 'string') blocks.push({ type: 'text', text: block });
    else if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
    else if (block.type === 'image_url' && block.image_url?.url) {
      const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    } else if (block.type === 'image' && block.source) blocks.push(block);
    else if (block.type === 'document' && block.source) blocks.push(block);
  }
  return blocks;
}

// ── Call Claude API ──────────────────────────────────────────
async function callClaude(apiKey, model, messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    // 8000 max_tokens — Tarik Bistro-class POs (30+ items × bboxes × confidence
    // fields) easily exceed 4000. Truncated responses fail JSON.parse silently.
    body: JSON.stringify({ model, max_tokens: 8000, system: buildSystemPrompt(), messages }),
    // 90s timeout — Claude API calls from Vercel iad1 region to Anthropic
    // regularly take 30-40s for large POs. Production logs confirmed.
    // 90s + Postgres + JSON = ~100s, fits inside the 120s function budget.
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  if (!textBlocks.length) throw new Error('Claude returned no text content');
  return {
    text: textBlocks.map(b => b.text).join('\n'),
    stopReason: data.stop_reason || null,
  };
}

// ── Extract JSON from response ───────────────────────────────
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch {}
  }

  const stripped = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  if (stripped.startsWith('{')) {
    try { return JSON.parse(stripped); } catch {}
  }

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
  try { return JSON.parse(candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')); } catch {}
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
