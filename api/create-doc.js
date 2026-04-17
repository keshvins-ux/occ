import crypto from 'crypto';
import { createClient } from 'redis';
import { Pool } from 'pg';

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}
async function pgQuery(sql, params = []) {
  const client = await getPool().connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

function sign(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function getSignatureKey(key, d, r, s) { return sign(sign(sign(sign(Buffer.from('AWS4'+key), d), r), s), 'aws4_request'); }

function buildHeaders(endpoint, bodyStr) {
  const { SQL_ACCESS_KEY, SQL_SECRET_KEY, SQL_HOST, SQL_REGION, SQL_SERVICE } = process.env;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15)+'Z';
  const dateStamp = amzDate.slice(0,8);
  const host = SQL_HOST.replace('https://','');
  const payloadHash = crypto.createHash('sha256').update(bodyStr,'utf8').digest('hex');
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = ['POST', endpoint, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${SQL_REGION}/${SQL_SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest,'utf8').digest('hex')].join('\n');
  const signature = crypto.createHmac('sha256',
    getSignatureKey(SQL_SECRET_KEY,dateStamp,SQL_REGION,SQL_SERVICE)).update(stringToSign).digest('hex');
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${SQL_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate, 'Content-Type': 'application/json', 'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
}

function buildGetHeaders(path, qs = '') {
  const { SQL_ACCESS_KEY, SQL_SECRET_KEY, SQL_HOST, SQL_REGION, SQL_SERVICE } = process.env;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15)+'Z';
  const dateStamp = amzDate.slice(0,8);
  const host = SQL_HOST.replace('https://','');
  const payloadHash = crypto.createHash('sha256').update('','utf8').digest('hex');
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalRequest = ['GET', path, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${SQL_REGION}/${SQL_SERVICE}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonicalRequest,'utf8').digest('hex')].join('\n');
  const sig = crypto.createHmac('sha256',
    getSignatureKey(SQL_SECRET_KEY,dateStamp,SQL_REGION,SQL_SERVICE)).update(sts).digest('hex');
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${SQL_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date': amzDate, 'Content-Type': 'application/json', 'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };
}

async function postToSQL(endpoint, payload) {
  const bodyStr = JSON.stringify(payload);
  const headers = buildHeaders(endpoint, bodyStr);
  const res = await fetch(`${process.env.SQL_HOST}${endpoint}`, { method:'POST', headers, body:bodyStr });
  const text = await res.text();
  if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
    return { ok:false, status:res.status, data:{ error:'SQL Account authentication failed or service unavailable.' }, isHTML:true };
  }
  let data = {};
  try { data = JSON.parse(text); } catch { data = { error: `Invalid response: ${text.slice(0,120)}` }; }
  return { ok: res.ok, status: res.status, data };
}

// Fetch SO line balances from SQL Account
// SQL Account tracks offsetqty on each SO line — qty already fulfilled by DOs
// Also returns dtlkey per line — needed to link DO lines back to SO lines
// so SQL Account updates offsetqty correctly when DO is created via API
async function fetchSOLineBalances(dockey) {
  const { SQL_HOST } = process.env;
  try {
    const endpoint = `/salesorder/${dockey}`;
    const r = await fetch(`${SQL_HOST}${endpoint}`, { headers: buildGetHeaders(endpoint) });
    const text = await r.text();
    if (!text || text.trim().startsWith('<!')) return null;
    const data = JSON.parse(text);
    const soData = data.data?.[0];
    if (!soData) return null;
    // Build balance map per itemcode — include dtlkey for DO linkage
    const balances = {};
    for (const line of (soData.sdsdocdetail || [])) {
      const originalQty   = parseFloat(line.qty || 0);
      const offsetQty     = parseFloat(line.offsetqty || 0); // already fulfilled
      const balanceQty    = Math.max(0, originalQty - offsetQty);
      balances[line.itemcode] = {
        itemcode:    line.itemcode,
        description: line.description,
        uom:         line.uom,
        unitprice:   parseFloat(line.unitprice || 0),
        dtlkey:      line.dtlkey,      // CRITICAL: links DO line to SO line
        seq:         line.seq,
        originalQty,
        offsetQty,
        balanceQty,
        fullyFulfilled: balanceQty <= 0,
      };
    }
    return { dockey, docno: soData.docno, balances };
  } catch(e) {
    return null;
  }
}

async function getRedisClient() {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  return redis;
}

async function checkExistingInSQL(redis, type, soDocno) {
  if (!soDocno) return null;
  if (type === 'invoice') {
    // Check Postgres first (authoritative), fall back to Redis
    try {
      const r = await pgQuery(
        'SELECT dockey, docno AS id, docref1 AS soref FROM sql_salesinvoices WHERE docref1 = $1 AND cancelled = false LIMIT 1',
        [soDocno]
      );
      if (r.rows.length > 0) return { id: r.rows[0].id, dockey: r.rows[0].dockey, soRef: soDocno };
    } catch(e) { /* fall through to Redis */ }
    const raw = await redis.get('mazza_invoice');
    const list = raw ? JSON.parse(raw) : [];
    const found = list.find(iv => iv.soRef === soDocno || iv.docref1 === soDocno || iv.id === soDocno);
    if (found) return found;
  }
  if (type === 'do') {
    // Check Postgres first (authoritative), fall back to Redis
    try {
      const r = await pgQuery(
        'SELECT dockey, docno AS id, docref1 AS soref FROM sql_deliveryorders WHERE docref1 = $1 AND cancelled = false',
        [soDocno]
      );
      if (r.rows.length > 0) return r.rows.map(row => ({ id: row.id, dockey: row.dockey, soRef: soDocno }));
    } catch(e) { /* fall through to Redis */ }
    const raw = await redis.get('mazza_do');
    const list = raw ? JSON.parse(raw) : [];
    const found = list.filter(d => d.soRef === soDocno || d.docref1 === soDocno);
    if (found.length > 0) return found;
  }
  if (type === 'so') {
    // Check Postgres first
    try {
      const r = await pgQuery(
        'SELECT dockey, docno AS id, code AS customerCode, companyname AS customer FROM sql_salesorders WHERE docno = $1 LIMIT 1',
        [soDocno]
      );
      if (r.rows.length > 0) return { id: r.rows[0].id, dockey: r.rows[0].dockey, customerCode: r.rows[0].customercode, customer: r.rows[0].customer };
    } catch(e) { /* fall through to Redis */ }
    const raw = await redis.get('mazza_so');
    const list = raw ? JSON.parse(raw) : [];
    return list.find(s => s.id === soDocno) || null;
  }
  return null;
}

async function resolveCustomerCode(redis, customerCode, soDocno, customerName) {
  // 1. Already provided — use it
  if (customerCode && customerCode !== soDocno) return customerCode;

  // 2. Look up from mazza_so Redis (sync-so.js stores customerCode)
  if (soDocno) {
    const soRaw = await redis.get('mazza_so');
    const soList = soRaw ? JSON.parse(soRaw) : [];
    const so = soList.find(s => s.id === soDocno || s.docNo === soDocno);
    if (so?.customerCode && so.customerCode !== soDocno) return so.customerCode;
  }

  // 2b. Postgres fallback — look up customer code from sql_salesorders
  if (soDocno) {
    try {
      const r = await pgQuery(
        'SELECT code FROM sql_salesorders WHERE docno = $1 LIMIT 1',
        [soDocno]
      );
      if (r.rows.length > 0 && r.rows[0].code) return r.rows[0].code;
    } catch(e) { /* Postgres unavailable — continue to next fallback */ }
  }

  // 3. Look up from mazza_po_intake (OCC-created SOs store customerCode)
  if (soDocno) {
    const intakeRaw = await redis.get('mazza_po_intake');
    const intakeList = intakeRaw ? JSON.parse(intakeRaw) : [];
    const entry = intakeList.find(p => p.docno === soDocno);
    if (entry?.customerCode && entry.customerCode !== soDocno) return entry.customerCode;
  }

  // 4. Match by customer name from mazza_customers master list
  if (customerName) {
    const custRaw = await redis.get('mazza_customers');
    const custList = custRaw ? JSON.parse(custRaw) : [];
    const normalise = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const nameNorm = normalise(customerName);
    const match = custList.find(c => normalise(c.name) === nameNorm || normalise(c.companyname) === nameNorm);
    if (match?.code) return match.code;
    // Partial match fallback
    const partial = custList.find(c => normalise(c.name).includes(nameNorm) || nameNorm.includes(normalise(c.name)));
    if (partial?.code) return partial.code;
  }

  return null;
}

async function updateOCCLog(redis, soDocno, updates) {
  const list = JSON.parse(await redis.get('mazza_po_intake') || '[]');
  const idx  = list.findIndex(p => p.docno === soDocno);
  if (idx > -1) {
    Object.assign(list[idx], updates);
  } else {
    list.unshift({ docno: soDocno, source: 'sql_existing', ...updates, loggedAt: new Date().toISOString() });
  }
  await redis.set('mazza_po_intake', JSON.stringify(list.slice(0,200)));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const { type } = req.query;
  const redis = await getRedisClient();

  try {

    // ── GET SO BALANCE (for partial DO creation) ───────────────────────────
    // Returns remaining qty per line item after accounting for existing DOs
    // Usage: GET /api/create-doc?type=so_balance&dockey=8
    if (type === 'so_balance' && req.method === 'GET') {
      const { dockey, docno } = req.query;

      // Resolve dockey from docno if needed
      let resolvedDockey = dockey;
      if (!resolvedDockey && docno) {
        // Try Postgres first
        try {
          const r = await pgQuery('SELECT dockey FROM sql_salesorders WHERE docno = $1 LIMIT 1', [docno]);
          if (r.rows.length > 0) resolvedDockey = r.rows[0].dockey;
        } catch(e) { /* fall through */ }
        // Redis fallback
        if (!resolvedDockey) {
          const soRaw = await redis.get('mazza_so');
          const soList = soRaw ? JSON.parse(soRaw) : [];
          const so = soList.find(s => s.docNo === docno || s.id === docno);
          resolvedDockey = so?.dockey || so?.id;
        }
      }

      if (!resolvedDockey) {
        return res.status(400).json({ error: 'Provide dockey or docno' });
      }

      const balanceData = await fetchSOLineBalances(resolvedDockey);
      if (!balanceData) {
        return res.status(404).json({ error: 'Could not fetch SO balance from SQL Account' });
      }

      const items = Object.values(balanceData.balances);
      const fullyFulfilled = items.every(i => i.fullyFulfilled);
      const partialItems   = items.filter(i => !i.fullyFulfilled && i.originalQty > 0);

      return res.status(200).json({
        docno:          balanceData.docno,
        dockey:         resolvedDockey,
        fullyFulfilled,
        partialItems:   partialItems.length,
        items,
        summary: items.map(i => ({
          itemcode:    i.itemcode,
          description: i.description,
          ordered:     i.originalQty,
          delivered:   i.offsetQty,
          remaining:   i.balanceQty,
          status:      i.fullyFulfilled ? 'Complete' : i.offsetQty > 0 ? 'Partial' : 'Pending',
        })),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });

    // ── CREATE SO ──────────────────────────────────────────────────────────
    if (type === 'so') {
      const { soPayload, poMeta } = req.body;
      if (!soPayload || !poMeta) return res.status(400).json({ error:'Missing soPayload or poMeta' });

      const lines = soPayload.sdsdocdetail || [];

      // VALIDATION 1: All line items must have unitprice > 0
      const zeroPrice = lines.filter(l => !l.unitprice || parseFloat(l.unitprice) === 0);
      if (zeroPrice.length > 0) {
        return res.status(400).json({
          error: `${zeroPrice.length} line item(s) have zero unit price. Please review before submitting.`,
          zeroItems: zeroPrice.map(l => ({
            itemcode: l.itemcode,
            description: l.description,
            qty: l.qty,
          })),
          action: 'Check extracted prices and correct before resubmitting.',
        });
      }

      // VALIDATION 2: Computed total must match declared total (within 1%)
      const computedTotal = lines.reduce((sum, l) => {
        return sum + (parseFloat(l.qty || 0) * parseFloat(l.unitprice || 0));
      }, 0);
      const declaredTotal = parseFloat(poMeta.totalAmount || 0);
      const tolerance = Math.max(declaredTotal * 0.01, 1);

      if (declaredTotal > 0 && Math.abs(computedTotal - declaredTotal) > tolerance) {
        return res.status(400).json({
          error: `Amount mismatch: PO total RM ${declaredTotal.toFixed(2)} vs computed RM ${computedTotal.toFixed(2)} (diff: RM ${Math.abs(computedTotal - declaredTotal).toFixed(2)})`,
          action: 'One or more prices may have been extracted incorrectly. Please review.',
          lines: lines.map(l => ({
            itemcode:  l.itemcode,
            description: l.description,
            qty:       l.qty,
            unitprice: l.unitprice,
            lineTotal: (parseFloat(l.qty||0) * parseFloat(l.unitprice||0)).toFixed(2),
          })),
        });
      }

      // Duplicate check
      const occList = JSON.parse(await redis.get('mazza_po_intake') || '[]');
      const poRef   = poMeta.poNumber?.trim().toLowerCase();
      if (poRef) {
        const dup = occList.find(p =>
          p.poNumber?.trim().toLowerCase() === poRef &&
          p.customerName?.trim().toLowerCase() === poMeta.customerName?.trim().toLowerCase()
        );
        if (dup) {
          return res.status(409).json({
            duplicate: true, source: 'occ',
            error: `PO "${poMeta.poNumber}" for ${poMeta.customerName} already submitted on ${new Date(dup.submittedAt).toLocaleString('en-MY')}.`,
            existing: { docno: dup.docno, submittedBy: dup.submittedBy, submittedAt: dup.submittedAt },
          });
        }
      }

      // Post to SQL Account
      const { ok, data } = await postToSQL('/salesorder', soPayload);
      if (!ok) {
        const errMsg = data.error?.message || data.error || data.raw || '';
        const isDuplicate = errMsg.toLowerCase().includes('duplicate') ||
                            errMsg.toLowerCase().includes('already exist');
        if (isDuplicate) {
          return res.status(409).json({
            duplicate: true, source: 'sql',
            error: `SO may already exist in SQL Account. ${errMsg}`,
            existing: { docno: data.docno || null },
          });
        }
        return res.status(400).json({ error: errMsg || 'Failed to create SO in SQL Account' });
      }

      const docno  = data.docno || data.DocNo || data.docNo || data.id || 'SO-NEW';
      const dockey = data.dockey || data.DocKey || data.docKey || null;

      // Store SO with line items in Redis
      const updatedList = JSON.parse(await redis.get('mazza_po_intake') || '[]');
      updatedList.unshift({
        ...poMeta,
        docno,
        dockey,
        computedTotal,
        declaredTotal,
        // Store line items for OCC display and partial DO tracking
        items: lines.map(l => ({
          itemcode:    l.itemcode,
          description: l.description || '',
          qty:         parseFloat(l.qty || 0),
          uom:         l.uom || 'UNIT',
          unitprice:   parseFloat(l.unitprice || 0),
          amount:      parseFloat(l.qty || 0) * parseFloat(l.unitprice || 0),
          deliverydate: l.deliverydate || null,
          deliveredQty: 0,   // tracks cumulative delivered qty across all DOs
          balanceQty:   parseFloat(l.qty || 0), // starts as full qty
        })),
        // DO tracking — array to support multiple partial DOs
        doList:    [],
        invoiceNo: null,
      });
      await redis.set('mazza_po_intake', JSON.stringify(updatedList.slice(0, 200)));

      return res.status(200).json({
        docno, dockey,
        customerName: poMeta.customerName,
        poNumber:     poMeta.poNumber,
        totalAmount:  computedTotal,
        itemCount:    lines.length,
        validation:   { computedTotal, declaredTotal, allPricesValid: true },
      });
    }

    // ── CREATE INVOICE ─────────────────────────────────────────────────────
    if (type === 'invoice') {
      let { soDocno, customerCode, deliveryDate, items, description, note, poNumber } = req.body;
      if (!items?.length) return res.status(400).json({ error: 'No items provided' });

      customerCode = await resolveCustomerCode(redis, customerCode, soDocno, req.body.customerName);
      if (!customerCode) return res.status(400).json({ error: 'Cannot determine customer code. Please ensure SO is synced or provide customerCode.' });

      if (!poNumber && soDocno) {
        const occRaw = await redis.get('mazza_po_intake');
        const occAll = occRaw ? JSON.parse(occRaw) : [];
        const occEntry = occAll.find(p => p.docno === soDocno);
        if (occEntry?.poNumber) poNumber = occEntry.poNumber;
      }

      const sqlExisting = await checkExistingInSQL(redis, 'invoice', soDocno);
      if (sqlExisting && !Array.isArray(sqlExisting)) {
        if (soDocno) await updateOCCLog(redis, soDocno, {
          invoiceNo: sqlExisting.id, invoiceKey: sqlExisting.dockey,
          invoicedAt: new Date().toISOString(), source: 'sql_existing'
        });
        return res.status(200).json({
          docno: sqlExisting.id, dockey: sqlExisting.dockey, type: 'invoice',
          alreadyExisted: true,
          message: `Invoice ${sqlExisting.id} already exists — linked to OCC.`,
        });
      }

      const occList  = JSON.parse(await redis.get('mazza_po_intake') || '[]');
      const occEntry = soDocno ? occList.find(p => p.docno === soDocno) : null;
      if (occEntry?.invoiceNo) {
        return res.status(409).json({
          duplicate: true, source: 'occ',
          error: `Invoice ${occEntry.invoiceNo} already created for ${soDocno}.`,
          details: { soNo: soDocno, invoiceNo: occEntry.invoiceNo },
        });
      }

      const today = new Date().toISOString().slice(0,10);
      const payload = {
        code: customerCode, docdate: today, postdate: today, taxdate: today,
        description: description || 'Sales Invoice',
        docref1: poNumber || soDocno || '', docref2: soDocno ? `SO: ${soDocno}` : '',
        note: note || '',
        sdsdocdetail: items.map((item,idx) => ({
          itemcode: item.itemcode, description: item.description || item.itemdescription || '',
          qty: item.qty, uom: item.uom || 'UNIT', unitprice: item.unitprice,
          deliverydate: deliveryDate || today,
          location: 'SW', disc: '', tax: '', taxamt: 0, taxrate: null,
          taxinclusive: false, seq: (idx+1)*1000,
        })),
      };

      const { ok, data } = await postToSQL('/salesinvoice', payload);
      if (!ok) {
        const errMsg = data.error?.message || data.error || '';
        const isDuplicate = errMsg.toLowerCase().includes('duplicate') || errMsg.toLowerCase().includes('already');
        if (isDuplicate) return res.status(409).json({ duplicate: true, source: 'sql', error: errMsg });
        return res.status(400).json({ error: errMsg || 'Failed to create Invoice' });
      }

      const docno  = data.docno || data.DocNo || data.id || 'IV-NEW';
      const dockey = data.dockey || data.DocKey || null;
      if (soDocno) await updateOCCLog(redis, soDocno, {
        invoiceNo: docno, invoiceKey: dockey, invoicedAt: new Date().toISOString()
      });

      return res.status(200).json({ docno, dockey, type: 'invoice' });
    }

    // ── CREATE DO (supports partial DOs) ───────────────────────────────────
    if (type === 'do') {
      let { soDocno, soDockey, customerCode, deliveryDate, items, description, note, poNumber, isPartial } = req.body;
      if (!items?.length) return res.status(400).json({ error: 'No items provided' });

      customerCode = await resolveCustomerCode(redis, customerCode, soDocno, req.body.customerName);
      if (!customerCode) return res.status(400).json({ error: 'Cannot determine customer code. Please ensure SO is synced or provide customerCode.' });

      if (!poNumber && soDocno) {
        const occRaw2 = await redis.get('mazza_po_intake');
        const occAll2 = occRaw2 ? JSON.parse(occRaw2) : [];
        const occEntry2 = occAll2.find(p => p.docno === soDocno);
        if (occEntry2?.poNumber) poNumber = occEntry2.poNumber;
      }

      // For partial DOs — validate quantities against SO balance
      if (soDockey) {
        const balanceData = await fetchSOLineBalances(soDockey);
        if (balanceData) {
          const overDelivery = [];
          for (const item of items) {
            const balance = balanceData.balances[item.itemcode];
            if (balance && parseFloat(item.qty) > balance.balanceQty) {
              overDelivery.push({
                itemcode:   item.itemcode,
                description: item.description,
                requested:  item.qty,
                available:  balance.balanceQty,
                alreadyDelivered: balance.offsetQty,
              });
            }
          }
          if (overDelivery.length > 0) {
            return res.status(400).json({
              error: `Quantity exceeds SO balance for ${overDelivery.length} item(s).`,
              overDelivery,
              action: 'Reduce quantities to match remaining SO balance.',
            });
          }
        }
      }

      const today  = new Date().toISOString().slice(0,10);
      const delDate = deliveryDate || today;

      // DO number suffix for partial DOs
      const occList   = JSON.parse(await redis.get('mazza_po_intake') || '[]');
      const occEntry  = soDocno ? occList.find(p => p.docno === soDocno) : null;
      const doCount   = (occEntry?.doList?.length || 0) + 1;
      const doLabel   = doCount > 1 ? ` (Partial ${doCount})` : '';

      // ── Compute delivery progress for docref1 label ──────────────────────
      // Inject dtlkey from SO balance data into each item
      // This is what causes SQL Account to decrement offsetqty on the SO line
      if (soDockey) {
        const balanceForLink = await fetchSOLineBalances(soDockey);
        if (balanceForLink) {
          items = items.map(item => {
            const soLine = balanceForLink.balances[item.itemcode];
            return {
              ...item,
              dtlkey:      soLine?.dtlkey      || item.dtlkey      || null,
              fromdockey:  parseInt(soDockey),
              fromdoctype: 30, // 30 = Sales Order in SQL Account
              fromdtlkey:  soLine?.dtlkey      || item.dtlkey      || null,
            };
          });
        }
      }

      // Build per-SKU delivery progress string for docref1
      // e.g. "SO-00320 | CP-002:2/10, TP-001:5/50"
      let deliveryProgress = soDocno || poNumber || '';
      if (occEntry?.items?.length > 0) {
        const deliveredMap = {};
        // Add previously delivered from past DOs
        for (const pastDO of (occEntry.doList || [])) {
          for (const di of (pastDO.items || [])) {
            deliveredMap[di.itemcode] = (deliveredMap[di.itemcode] || 0) + parseFloat(di.qty || 0);
          }
        }
        // Add this DO's items
        for (const di of items) {
          deliveredMap[di.itemcode] = (deliveredMap[di.itemcode] || 0) + parseFloat(di.qty || 0);
        }
        // Build SKU progress — only items in this SO
        const skuProgress = occEntry.items
          .filter(l => l.qty > 0)
          .map(l => {
            const delivered = deliveredMap[l.itemcode] || 0;
            return `${l.itemcode}:${delivered}/${l.qty}`;
          })
          .join(', ');
        const fullProgress = `${soDocno} | ${skuProgress}`;
        // Truncate to 200 chars if many line items
        deliveryProgress = fullProgress.length <= 200
          ? fullProgress
          : fullProgress.slice(0, 197) + '...';
      }

      const payload = {
        code: customerCode, docdate: today, postdate: today, taxdate: today,
        description: description || `Delivery Order${doLabel}`,
        // docref1: kept for team use (PO number etc) — do not overwrite
        docref1: poNumber || '',
        docref2: '',
        docref3: '',
        // docref4: SO reference + per-SKU delivery progress
        docref4: deliveryProgress || `SO: ${soDocno || ''} | DEL: ${delDate.split('-').reverse().join('/')}${doLabel}`,
        note: note || '',
        sdsdocdetail: items.map((item,i) => ({
          itemcode:    item.itemcode,
          description: item.description || item.itemdescription || '',
          qty:         item.qty,
          uom:         item.uom || 'UNIT',
          unitprice:   item.unitprice,
          deliverydate: delDate,
          location:    'SW',
          disc: '', tax: '', taxamt: 0, taxrate: null,
          taxinclusive: false,
          seq:         (i+1)*1000,
          // Link back to SO line — causes SQL Account to update offsetqty
          // so remaining balance decrements correctly after each DO
          fromdoctype: item.fromdoctype || (soDockey ? 30 : null), // 30 = Sales Order
          fromdockey:  item.fromdockey  || (soDockey ? parseInt(soDockey) : null),
          fromdtlkey:  item.fromdtlkey  || item.dtlkey || null,
        })),
      };

      const { ok, data } = await postToSQL('/deliveryorder', payload);
      if (!ok) {
        const errMsg = data.error?.message || data.error || '';
        const isDuplicate = errMsg.toLowerCase().includes('duplicate') || errMsg.toLowerCase().includes('already');
        if (isDuplicate) return res.status(409).json({ duplicate: true, source: 'sql', error: errMsg });
        return res.status(400).json({ error: errMsg || 'Failed to create DO' });
      }

      const docno  = data.docno || data.DocNo || data.id || null;
      const dockey = data.dockey || data.DocKey || null;

      // Explicit validation — never silently succeed without a document number
      if (!docno) {
        console.error('DO created but no docno returned:', JSON.stringify(data));
        return res.status(500).json({
          error: 'DO may have been created in SQL Account but no document number was returned. Please check SQL Account manually before retrying.',
          rawResponse: data,
        });
      }

      // Update OCC log — append to doList array (supports multiple DOs per SO)
      if (soDocno) {
        const freshList = JSON.parse(await redis.get('mazza_po_intake') || '[]');
        const idx = freshList.findIndex(p => p.docno === soDocno);
        if (idx > -1) {
          // Initialise doList array if not present (backward compat)
          if (!freshList[idx].doList) freshList[idx].doList = [];

          // Add this DO to the list
          freshList[idx].doList.push({
            doNo:        docno,
            doKey:       dockey,
            createdAt:   new Date().toISOString(),
            deliveryDate: delDate,
            items: items.map(i => ({ itemcode: i.itemcode, qty: parseFloat(i.qty) })),
          });

          // Update per-item delivered qty and balance
          if (freshList[idx].items) {
            for (const doItem of items) {
              const lineIdx = freshList[idx].items.findIndex(l => l.itemcode === doItem.itemcode);
              if (lineIdx > -1) {
                freshList[idx].items[lineIdx].deliveredQty =
                  (freshList[idx].items[lineIdx].deliveredQty || 0) + parseFloat(doItem.qty);
                freshList[idx].items[lineIdx].balanceQty =
                  freshList[idx].items[lineIdx].qty - freshList[idx].items[lineIdx].deliveredQty;
              }
            }
          }

          // Keep backward compat — set doNo to latest DO
          freshList[idx].doNo = docno;
          freshList[idx].doKey = dockey;
          freshList[idx].doCreatedAt = new Date().toISOString();
          freshList[idx].deliveryDate = delDate;

          await redis.set('mazza_po_intake', JSON.stringify(freshList));
        } else {
          await updateOCCLog(redis, soDocno, {
            doNo: docno, doKey: dockey,
            doList: [{ doNo: docno, doKey: dockey, createdAt: new Date().toISOString(), deliveryDate: delDate, items: items.map(i => ({ itemcode: i.itemcode, qty: parseFloat(i.qty) })) }],
            doCreatedAt: new Date().toISOString(), deliveryDate: delDate,
          });
        }
      }

      // Compute remaining balance for response
      const balanceAfter = soDockey ? await fetchSOLineBalances(soDockey) : null;
      const remainingItems = balanceAfter
        ? Object.values(balanceAfter.balances).filter(i => i.balanceQty > 0)
        : [];

      return res.status(200).json({
        docno, dockey, type: 'do',
        doNumber:   doCount,
        isPartial:  remainingItems.length > 0,
        remaining:  remainingItems.map(i => ({
          itemcode:    i.itemcode,
          description: i.description,
          remaining:   i.balanceQty,
        })),
        message: remainingItems.length > 0
          ? `DO ${docno} created. ${remainingItems.length} item(s) still have remaining balance — partial delivery.`
          : `DO ${docno} created. All items fully delivered.`,
      });
    }

    return res.status(400).json({ error: 'Unknown type. Use ?type=so|invoice|do|so_balance' });

  } catch(err) {
    console.error('create-doc error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await redis.disconnect();
  }
}
