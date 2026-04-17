import crypto from 'crypto';
import { createClient } from 'redis';

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
  const credScope = `${dateStamp}/${SQL_REGION}/${SQL_SERVICE}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, credScope, crypto.createHash('sha256').update(canonicalRequest,'utf8').digest('hex')].join('\n');
  const sig = crypto.createHmac('sha256', getSignatureKey(SQL_SECRET_KEY,dateStamp,SQL_REGION,SQL_SERVICE)).update(sts).digest('hex');
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
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({ error:'Method not allowed' });

  const { action } = req.query;
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();

  try {
    // -- GRN SUBMISSION ------------------------------------------------------
    if (action === 'grn') {
      const { poId, items, grnDate, note, submittedBy } = req.body;
      if (!poId || !items?.length) return res.status(400).json({ error:'Missing poId or items' });

      const grnRef = `GRN-${Date.now()}`;
      const today  = grnDate || new Date().toISOString().slice(0,10);

      // Store pending GRN in Redis for Varinder to approve
      const grnList = JSON.parse(await redis.get('mazza_grn_pending') || '[]');
      grnList.unshift({ grnRef, poId, items, grnDate:today, note, submittedBy, submittedAt:new Date().toISOString(), approved:false });
      await redis.set('mazza_grn_pending', JSON.stringify(grnList.slice(0,100)));

      // Also store in history
      const hist = JSON.parse(await redis.get('mazza_grn_history') || '[]');
      hist.unshift({ grnRef, poId, items:items.length, submittedBy, submittedAt:new Date().toISOString(), approved:false });
      await redis.set('mazza_grn_history', JSON.stringify(hist.slice(0,200)));

      return res.status(200).json({ success:true, grnRef, message:'GRN submitted — pending Varinder approval' });
    }

    // -- GRN APPROVAL (Varinder) ---------------------------------------------
    if (action === 'approve_grn') {
      const { grnRef, approvedBy } = req.body;
      const grnList = JSON.parse(await redis.get('mazza_grn_pending') || '[]');
      const grn = grnList.find(g=>g.grnRef===grnRef);
      if (!grn) return res.status(404).json({ error:'GRN not found' });

      // Build stock adjustment payload for SQL Account
      const today = new Date().toISOString().slice(0,10);
      const payload = {
        docdate:     today,
        postdate:    today,
        description: `GRN from PO ${grn.poId} — ${grnRef}`,
        note:        grn.note || '',
        authby:      approvedBy || 'Varinder',
        reason:      'Goods Received',
        sdsdocdetail: grn.items.filter(i=>parseFloat(i.received||0)>0).map((item,idx) => ({
          itemcode:     item.itemcode,
          description:  item.description || '',
          qty:          parseFloat(item.received),
          uom:          item.uom || 'UNIT',
          unitcost:     0,
          seq:          (idx+1)*1000,
          batch:        item.batch || '',
          location:     '----',
          remark1:      `PO: ${grn.poId}`,
          remark2:      grnRef,
        })),
      };

      // Try GRN endpoint first, fall back to stock adjustment
      let sqlResult = await postToSQL('/goodsreceivenote', payload);
      let usedEndpoint = '/goodsreceivenote';
      if (!sqlResult.ok || sqlResult.data?.error || sqlResult.data?.raw?.includes('<!DOCTYPE')) {
        sqlResult = await postToSQL('/stockadjustment', payload);
        usedEndpoint = '/stockadjustment';
      }

      if (!sqlResult.ok || sqlResult.data?.error) {
        return res.status(400).json({ error: sqlResult.data?.error?.message || sqlResult.data?.error || 'SQL error' });
      }

      const docno = sqlResult.data.docno || sqlResult.data.DocNo || grnRef;

      // Mark GRN as approved
      const idx = grnList.findIndex(g=>g.grnRef===grnRef);
      if (idx>-1) { grnList[idx].approved=true; grnList[idx].approvedBy=approvedBy; grnList[idx].approvedAt=new Date().toISOString(); grnList[idx].sqlDocno=docno; }
      await redis.set('mazza_grn_pending', JSON.stringify(grnList));

      // Update history
      const hist = JSON.parse(await redis.get('mazza_grn_history') || '[]');
      const hIdx = hist.findIndex(g=>g.grnRef===grnRef);
      if (hIdx>-1) { hist[hIdx].approved=true; hist[hIdx].sqlDocno=docno; }
      await redis.set('mazza_grn_history', JSON.stringify(hist));

      // Trigger immediate stock sync by updating timestamp
      await redis.set('mazza_stock_balance_updated', new Date().toISOString());

      return res.status(200).json({ success:true, docno, endpoint:usedEndpoint });
    }

    // -- STOCK ADJUSTMENT ----------------------------------------------------
    if (action === 'stock_adjustment') {
      const { items, adjDate, note, submittedBy } = req.body;
      if (!items?.length) return res.status(400).json({ error:'No items provided' });

      const today = adjDate || new Date().toISOString().slice(0,10);
      const payload = {
        docdate:     today,
        postdate:    today,
        description: `Stock Count Adjustment — ${submittedBy || 'OCC Dashboard'}`,
        note:        note || '',
        authby:      submittedBy || '',
        reason:      'Physical Count',
        sdsdocdetail: items.map((item,idx) => {
          const bookQty  = parseFloat(item.bookQty || 0);
          const physQty  = parseFloat(item.physicalQty || 0);
          const variance = physQty - bookQty;
          return {
            itemcode:    item.itemcode,
            description: item.description || '',
            bookqty:     bookQty,
            physicalqty: physQty,
            qty:         variance,
            uom:         item.uom || 'UNIT',
            unitcost:    0,
            seq:         (idx+1)*1000,
            location:    '----',
            remark1:     item.reason || 'Physical Count',
          };
        }).filter(i=>i.qty!==0), // only include items with variance
      };

      if (!payload.sdsdocdetail.length) {
        return res.status(400).json({ error:'No variance found — physical count matches book quantity for all items' });
      }

      const result = await postToSQL('/stockadjustment', payload);
      if (!result.ok || result.data?.error) {
        return res.status(400).json({ error: result.data?.error?.message || result.data?.error || 'SQL error' });
      }

      const docno = result.data.docno || result.data.DocNo || 'AJ-NEW';

      // Log adjustment
      const log = JSON.parse(await redis.get('mazza_stock_adj_log') || '[]');
      log.unshift({ docno, submittedBy, adjDate:today, items:items.length, submittedAt:new Date().toISOString() });
      await redis.set('mazza_stock_adj_log', JSON.stringify(log.slice(0,100)));
      await redis.set('mazza_stock_balance_updated', new Date().toISOString());

      return res.status(200).json({ success:true, docno });
    }

    // -- GET PENDING GRNs (for Varinder approval) ---------------------------
    if (action === 'pending_grns' && req.method === 'GET') {
      const list = JSON.parse(await redis.get('mazza_grn_pending') || '[]');
      return res.status(200).json({ grns: list.filter(g=>!g.approved) });
    }

    return res.status(400).json({ error:'Unknown action' });

  } catch(err) {
    console.error('Procurement error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await redis.disconnect();
  }
}
