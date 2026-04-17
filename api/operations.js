import { createClient } from 'redis';
import { Pool } from 'pg';

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}
async function pgQuery(sql, params = []) {
  const c = await getPool().connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

// -- Shared helpers ------------------------------------------------------------

function isDone(status) {
  if (!status) return false;
  const s = status.toUpperCase().trim();
  return s.startsWith('DONE') || s.startsWith('CANCEL');
}

const CODE_MAP = { 'AP-MCP-001':'MCP-002', 'TP-96':'TP-001', 'CP-055':'CP-002' };
const UOM_MULT = {
  'MCP-002':{CTN:10,UNIT:1},'CP-002':{CTN:10,UNIT:1},'TP-001':{CTN:10,UNIT:1},
  'CRP-001':{CTN:10,UNIT:1},'CMP-001':{CTN:10,UNIT:1},'FCP-002':{CTN:10,UNIT:1},
  'CF-002':{CTN:10,CARTON:10,UNIT:1},'MCP-003':{CARTON:40,UNIT:1},'FCP-003':{CARTON:40,UNIT:1},
  'TP-003':{CARTON:80,UNIT:1},'CP-004':{CARTON:80,UNIT:1},'MCP-005':{CTN:2,CARTON:2,UNIT:1},
};

function getMultiplier(itemCode, uom) {
  const map = UOM_MULT[itemCode];
  if (!map) return 1;
  return map[(uom||'UNIT').toUpperCase()] ?? 1;
}

function explodeBOM(fgNeeded, bom) {
  const rmNeeded = {};
  Object.entries(fgNeeded).forEach(([fgCode, fg]) => {
    const bomEntry = bom[fgCode];
    if (!bomEntry) return;
    const mult = getMultiplier(fgCode, fg.uom);
    const bomUnits = fg.qty * mult;
    bomEntry.components.forEach(comp => {
      const needed = comp.qty * bomUnits;
      if (!rmNeeded[comp.code]) rmNeeded[comp.code] = { code:comp.code, uom:comp.uom, needed:0, refCost:comp.refCost||0, usedIn:[] };
      rmNeeded[comp.code].needed += needed;
      if (!rmNeeded[comp.code].usedIn.includes(fgCode)) rmNeeded[comp.code].usedIn.push(fgCode);
    });
  });
  return rmNeeded;
}

function getActiveFG(snap, intake, liveStatus, fulfilledSoNos) {
  const fgNeeded = {};
  Object.entries(snap).forEach(([code, p]) => {
    const activeOrders = (p.orders||[]).filter(o =>
      !isDone(liveStatus[o.soNo]) && !fulfilledSoNos.has(o.soNo)
    );
    if (!activeOrders.length) return;
    const qty = activeOrders.reduce((s,o)=>s+(o.qty||0),0);
    if (!fgNeeded[code]) fgNeeded[code] = { qty:0, uom:'UNIT', revenue:0, orders:[], customers:new Set(), deliveryDates:[] };
    fgNeeded[code].qty += qty;
    fgNeeded[code].revenue += p.totalValue||0;
    activeOrders.forEach(o => {
      fgNeeded[code].orders.push(o);
      fgNeeded[code].customers.add(o.customer);
      if (o.deliveryDate) fgNeeded[code].deliveryDates.push(o.deliveryDate);
    });
    fgNeeded[code].description = p.description;
  });

  intake.forEach(po => {
    (po.items||[]).forEach(item => {
      const code = CODE_MAP[item.itemcode]||item.itemcode;
      const qty = parseFloat(item.qty||0);
      if (!fgNeeded[code]) fgNeeded[code] = { qty:0, uom:item.uom||'UNIT', revenue:0, orders:[], customers:new Set(), deliveryDates:[], description:item.itemdescription||code };
      fgNeeded[code].qty += qty;
      fgNeeded[code].revenue += parseFloat(item.amount||0);
      fgNeeded[code].orders.push({ soNo:po.docno, customer:po.customerName, qty, date:po.submittedAt?.slice(0,10) });
      fgNeeded[code].customers.add(po.customerName);
      if (po.deliveryDate) fgNeeded[code].deliveryDates.push(po.deliveryDate);
    });
  });

  return fgNeeded;
}

// -- Main router ---------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  const type = req.query.type || 'production';
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  try {
    const [snapRaw,intakeRaw,_soLiveRaw,bomRaw,stockRaw,ivRaw,doRaw] = await Promise.all([
      client.get('so:by_product'),
      client.get('mazza_po_intake'),
      // mazza_so fetched after — Postgres preferred, Redis fallback
      client.get('mazza_bom'),
      client.get('mazza_stock_balance'),
      client.get('mazza_invoice'),
      client.get('mazza_do'),
    ]);

    const snap    = snapRaw    ? JSON.parse(snapRaw)    : {};
    const intake  = intakeRaw  ? JSON.parse(intakeRaw)  : [];
    const bom     = bomRaw     ? JSON.parse(bomRaw)     : {};
    const stock   = stockRaw   ? JSON.parse(stockRaw)   : {};
    const invoices= ivRaw      ? JSON.parse(ivRaw)      : [];
    const doList  = doRaw      ? JSON.parse(doRaw)      : [];

    // SO live status — Postgres preferred (fresh), Redis fallback (for backward compat)
    let soLive = [];
    try {
      const pgSO = await pgQuery(
        \`SELECT docno AS id, dockey, docref3 AS statusnote, status, cancelled, agent
         FROM sql_salesorders
         WHERE cancelled = false
         ORDER BY docdate DESC\`
      );
      soLive = pgSO.rows.map(s => ({
        id:      s.id,
        docNo:   s.id,
        dockey:  s.dockey,
        status:  s.cancelled ? 'Cancelled'
                 : (s.statusnote||'').toUpperCase().trim().startsWith('DONE') ? 'Done'
                 : 'Active',
      }));
    } catch(e) {
      const soLiveRaw2 = await client.get('mazza_so').catch(()=>null);
      soLive = soLiveRaw2 ? JSON.parse(soLiveRaw2) : [];
    }

    const liveStatus = {};
    soLive.forEach(s => {
      // Index by both the SO number string (s.id = "SO-00320") and dockey integer
      // so:by_product stores orders with soNo = docNo string
      liveStatus[s.id]     = s.status||'Active';  // "SO-00320" -> status
      liveStatus[s.dockey] = s.status||'Active';  // 8 -> status (backward compat)
      if (s.docNo) liveStatus[s.docNo] = s.status||'Active'; // extra safety
    });

    // Build set of SO numbers that are fulfilled — i.e. a DO exists for that SO.
    // Since soRef on DOs contains customer PO numbers (not SO docnos), we match
    // by cross-referencing: find SOs whose docno appears in the snapshot and
    // check if a DO exists for the same customer within a reasonable date window.
    // Simpler approach: use the snapshot orders and check if ANY DO exists for
    // that customer after the SO date (within 60 days) — this handles the TG case.
    //
    // Most reliable: mark SO as fulfilled if it has status DONE/CANCEL or
    // if the snapshot order date is older than 90 days (goods long overdue = likely sent).
    // For TG specifically: status in liveStatus should be updated when DO is created.
    //
    // Best fix: check mazza_do for matching customer+date combination.
    const doCustomerSet = new Set(doList.map(d => (d.customer||'').toUpperCase().trim()));

    // Build fulfilled SO set: SOs where a DO exists for the same customer
    // AND the SO delivery date has passed (goods were sent)
    const today = new Date();
    const fulfilledSoNos = new Set();
    Object.entries(snap).forEach(([code, p]) => {
      (p.orders||[]).forEach(o => {
        if (isDone(liveStatus[o.soNo])) {
          fulfilledSoNos.add(o.soNo);
          return;
        }
        // If delivery date has passed AND a DO exists for this customer → fulfilled
        if (o.deliveryDate) {
          const delDate = new Date(o.deliveryDate);
          const isPastDue = delDate < today;
          const customerHasDO = doCustomerSet.has((o.customer||'').toUpperCase().trim());
          if (isPastDue && customerHasDO) {
            fulfilledSoNos.add(o.soNo);
          }
        }
      });
    });

    const fgNeeded = getActiveFG(snap, intake, liveStatus, fulfilledSoNos);

    // -- PRODUCTION PLAN -------------------------------------------------------
    if (type === 'production') {
      const activeSnap = {};
      for (const [code, p] of Object.entries(snap)) {
        const activeOrders = (p.orders||[]).filter(o=>
          !isDone(liveStatus[o.soNo]) && !fulfilledSoNos.has(o.soNo)
        );
        if (!activeOrders.length) continue;
        const totalQty   = activeOrders.reduce((s,o)=>s+(o.qty||0),0);
        const totalValue = activeOrders.reduce((s,o)=>s+(o.qty||0)*(o.unitPrice||p.unitPrice||0),0);
        const doneOrders = (p.orders||[]).filter(o=>isDone(liveStatus[o.soNo])||fulfilledSoNos.has(o.soNo));
        activeSnap[code] = { ...p, orders:activeOrders, doneOrders, totalQty, totalValue:totalValue||p.totalValue, soCount:activeOrders.length, source:'snapshot' };
      }

      const intakeProds = {};
      intake.forEach(po => {
        (po.items||[]).forEach(item => {
          const code = CODE_MAP[item.itemcode]||item.itemcode;
          const qty  = parseFloat(item.qty||0);
          const rev  = parseFloat(item.amount||0);
          if (!intakeProds[code]) intakeProds[code] = { itemCode:code, description:item.itemdescription||code, uom:item.uom||'UNIT', totalQty:0, totalValue:0, soCount:0, customers:[], orders:[], source:'po_intake' };
          intakeProds[code].totalQty   += qty;
          intakeProds[code].totalValue += rev;
          intakeProds[code].soCount    += 1;
          if (!intakeProds[code].customers.includes(po.customerName)) intakeProds[code].customers.push(po.customerName);
          intakeProds[code].orders.push({ soNo:po.docno||'', customer:po.customerName, qty, uom:item.uom||'UNIT', date:(po.submittedAt||'').slice(0,10) });
        });
      });

      const merged = { ...activeSnap };
      for (const [code, ip] of Object.entries(intakeProds)) {
        if (merged[code]) {
          const existingSoNos = new Set((merged[code].orders||[]).map(o=>o.soNo));
          const newOrders = ip.orders.filter(o=>!existingSoNos.has(o.soNo));
          merged[code] = { ...merged[code], orders:[...merged[code].orders,...newOrders], totalQty:merged[code].totalQty+newOrders.reduce((s,o)=>s+o.qty,0), totalValue:merged[code].totalValue+newOrders.reduce((s,o)=>s+(o.qty*(ip.totalValue/Math.max(ip.totalQty,1))),0), soCount:merged[code].soCount+newOrders.length, source:'both' };
        } else { merged[code] = ip; }
      }

      const products = Object.values(merged).map(p => {
        const bomEntry = bom[p.itemCode];
        const revenue  = p.totalValue||0;
        if (!bomEntry) return { ...p, revenue, bomMissing:true, totalRawCost:null };
        const uomCounts = {};
        (p.orders||[]).forEach(o=>{ uomCounts[o.uom]=(uomCounts[o.uom]||0)+o.qty; });
        const orderedUom = Object.entries(uomCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]||'UNIT';
        const mult    = getMultiplier(p.itemCode, orderedUom);
        const bomUnits= p.totalQty * mult;
        const rawMaterials = bomEntry.components.map(comp => ({ code:comp.code, uom:comp.uom, qtyPerUnit:comp.qty, totalQty:comp.qty*bomUnits, refCostPerUnit:comp.refCost||0, totalCost:comp.qty*bomUnits*(comp.refCost||0) }));
        const totalRawCost = rawMaterials.reduce((s,r)=>s+r.totalCost,0);
        const grossProfit  = revenue - totalRawCost;
        const margin = revenue>0?(grossProfit/revenue)*100:0;
        return { ...p, revenue, rawMaterials, totalRawCost, grossProfit, margin, bomMissing:false, multiplier:mult, orderedUom, bomUnits };
      }).sort((a,b)=>b.revenue-a.revenue);

      const totals = products.reduce((acc,r)=>({ revenue:acc.revenue+(r.revenue||0), rawCost:acc.rawCost+(r.totalRawCost||0), grossProfit:acc.grossProfit+(r.grossProfit||0) }),{revenue:0,rawCost:0,grossProfit:0});
      totals.margin = totals.revenue>0?(totals.grossProfit/totals.revenue*100):0;

      const phasedOut = Object.entries(snap).filter(([code])=>!activeSnap[code]).map(([code,p])=>({itemCode:code,description:p.description,totalQty:p.totalQty,totalValue:p.totalValue}));

      return res.status(200).json({ products, totals, phasedOut, meta:{ snapshotActive:Object.keys(activeSnap).length, snapshotPhasedOut:phasedOut.length, fromPoIntake:Object.keys(intakeProds).length, merged:products.length, updatedAt:new Date().toISOString() }});
    }

    // -- GAP ANALYSIS ----------------------------------------------------------
    if (type === 'gap') {
      const custFreq = {};
      invoices.forEach(iv=>{ const c=iv.customer||''; custFreq[c]=(custFreq[c]||0)+1; });

      const fgGap = Object.entries(fgNeeded).map(([code,p]) => {
        const s = stock[code];
        const onHand  = s ? Math.max(0,s.balance) : 0;
        const required= p.qty;
        const gap     = required - onHand;
        const pct     = required>0?Math.min(Math.round((onHand/required)*100),100):100;
        const sortedDates  = (p.deliveryDates||[]).sort();
        const nextDelivery = sortedDates[0]||null;
        const daysLeft     = nextDelivery?Math.floor((new Date(nextDelivery)-new Date())/(1000*60*60*24)):null;
        const custScore    = [...(p.customers||[])].reduce((s,c)=>s+(custFreq[c]||0),0);
        return { itemCode:code, description:p.description||code, required, onHand, gap:Math.max(0,gap), canFulfil:gap<=0, pct, customers:[...(p.customers||[])], nextDelivery, daysLeft, custScore, revenue:p.revenue, orders:p.orders.length };
      }).sort((a,b)=>{ if(!a.canFulfil&&b.canFulfil)return -1; if(a.canFulfil&&!b.canFulfil)return 1; if(a.daysLeft!==null&&b.daysLeft!==null)return a.daysLeft-b.daysLeft; if(a.daysLeft!==null)return -1; if(b.daysLeft!==null)return 1; return b.custScore-a.custScore; });

      const cannotFulfilFG = {};
      fgGap.filter(f=>!f.canFulfil).forEach(f=>{ cannotFulfilFG[f.itemCode]={ qty:f.gap, uom:'UNIT' }; });
      const rmNeeded = explodeBOM(cannotFulfilFG, bom);

      const rmGap = Object.values(rmNeeded).map(rm => {
        const s = stock[rm.code];
        const onHand = s?Math.max(0,s.balance):0;
        const gap    = Math.max(0,rm.needed-onHand);
        const status = gap>0?(onHand<0?'short':'short'):onHand<rm.needed*1.2?'low':'ok';
        return { ...rm, onHand, gap, status, pct:rm.needed>0?Math.min(Math.round((onHand/rm.needed)*100),999):100, totalCost:gap*(rm.refCost||0) };
      }).sort((a,b)=>{ const o={short:0,low:1,ok:2}; if(o[a.status]!==o[b.status])return o[a.status]-o[b.status]; return b.totalCost-a.totalCost; });

      const stockUpdatedAt = await client.get('mazza_stock_balance_updated');
      return res.status(200).json({ fgGap, rmGap, summary:{ totalFG:fgGap.length, canFulfil:fgGap.filter(f=>f.canFulfil).length, cannotFulfil:fgGap.filter(f=>!f.canFulfil).length, rmShort:rmGap.filter(r=>r.status==='short').length, stockUpdatedAt }});
    }

    // -- PURCHASE LIST ---------------------------------------------------------
    if (type === 'purchase') {
      const rmNeeded = explodeBOM(
        Object.fromEntries(Object.entries(fgNeeded).map(([k,v])=>[k,{qty:v.qty,uom:v.uom||'UNIT'}])),
        bom
      );

      const items = Object.values(rmNeeded).map(rm => {
        const s = stock[rm.code];
        const onHand = s?s.balance:0;
        const netBuy = rm.needed - Math.max(0,onHand);
        const status = netBuy>0?(onHand<0?'critical':'buy'):'sufficient';
        return { code:rm.code, uom:rm.uom, needed:rm.needed, onHand, netBuy:Math.max(0,netBuy), status, estCost:Math.max(0,netBuy)*(rm.refCost||0), coverage:rm.needed>0?Math.min(Math.round((Math.max(0,onHand)/rm.needed)*100),100):100, refCost:rm.refCost, usedIn:rm.usedIn };
      }).sort((a,b)=>{ const o={critical:0,buy:1,sufficient:2}; if(o[a.status]!==o[b.status])return o[a.status]-o[b.status]; return b.estCost-a.estCost; });

      const totals = { totalItems:items.length, toBuy:items.filter(i=>i.status!=='sufficient').length, critical:items.filter(i=>i.status==='critical').length, sufficient:items.filter(i=>i.status==='sufficient').length, estTotalCost:items.reduce((s,i)=>s+i.estCost,0) };
      const stockUpdatedAt = await client.get('mazza_stock_balance_updated');
      return res.status(200).json({ items, totals, stockUpdatedAt });
    }

    return res.status(400).json({ error: 'Unknown type. Use ?type=production|gap|purchase' });

  } catch(err) {
    console.error('Operations error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
