import { createClient } from 'redis';

// -- Machine definitions -------------------------------------------------------
const MACHINES = {
  'WFJ-20': {
    name: 'WFJ-20', type: 'Fine Grinder', rateKgHr: 56.0,
    hoursPerDay: 24, daysPerWeek: 6,
    // Per-product rates from actual production data (output kg/hr)
    productRates: {
      'CORIANDER': 38.0, 'TURMERIC': 97.5, 'CUMIN': 46.2, 'FENNEL': 61.7,
      'MEAT CURRY': 49.3, 'FISH CURRY': 58.3, 'CHILLI FLAKES': 20.0,
      'KURMA': 53.0, 'RASAM': 90.0, 'GARAM MASALA': 48.3,
      'SAMBAR': 55.0, 'FIVE SPICES': 72.0, 'TG888': 39.2,
      'DEFAULT': 56.0,
    },
  },
  'WFC-500': {
    name: 'WFC-500', type: 'Coarse Grinder', rateKgHr: 19.1,
    hoursPerDay: 24, daysPerWeek: 6,
    productRates: { 'CHILLI': 20.0, 'TOPOKKI': 18.1, 'DEFAULT': 19.1 },
  },
  'LG-60B': {
    name: 'LG-60B', type: 'Pepper Grinder', rateKgHr: 59.9,
    hoursPerDay: 24, daysPerWeek: 6,
    productRates: { 'DEFAULT': 59.9 },
  },
  'GS420': {
    name: 'GS420', type: 'Auto Packer', rateKgHr: 600,
    hoursPerDay: 24, daysPerWeek: 6,
    packSizes: ['1KG','2KG','5KG','10KG','17KG','25KG'],
    productRates: { 'DEFAULT': 600 },
  },
  'AFM30-T': {
    name: 'AFM30-T', type: 'Semi-auto Packer', rateKgHr: 125,
    hoursPerDay: 24, daysPerWeek: 6,
    packSizes: ['100GM','125GM','250GM','500GM'],
    productRates: { 'DEFAULT': 125 },
  },
};

const BATCH_SIZE_KG   = 200;   // Standard batch size
const CLEANING_HRS    = 0.625; // 37.5 min avg cleaning between product changes
const WEEKLY_HRS      = 24 * 6; // 144 hrs/week

// -- Determine machine for a raw material --------------------------------------
function getMachineForComponent(code, description) {
  const d = (description || code || '').toUpperCase();
  const c = (code || '').toUpperCase();
  // Pepper → LG-60B
  if (c.includes('BP-SEED') || c.includes('WP-SEED') || d.includes('PEPPER')) return 'LG-60B';
  // Chilli → WFC-500
  if (c.includes('CL-YD') || c.includes('CL-668') || c.includes('CL-BST') || d.includes('CHILLI') || d.includes('CHILI')) return 'WFC-500';
  // Packaging materials → no machine needed
  if (c.includes('PKG') || c.includes('PP-') || c.includes('BAG') || c.includes('PKT') || d.includes('PACKAG') || d.includes('PLASTIC')) return null;
  // Everything else → WFJ-20
  return 'WFJ-20';
}

// -- Get production rate for a component on a machine -------------------------
function getRate(machineId, componentCode) {
  const machine = MACHINES[machineId];
  if (!machine) return 50; // fallback
  const code = (componentCode || '').toUpperCase();
  // Match product type from code
  if (code.includes('CRD')) return machine.productRates['CORIANDER'] || machine.productRates['DEFAULT'];
  if (code.includes('TR') && !code.includes('TOPOKKI')) return machine.productRates['TURMERIC'] || machine.productRates['DEFAULT'];
  if (code.includes('CM-')) return machine.productRates['CUMIN'] || machine.productRates['DEFAULT'];
  if (code.includes('FN-')) return machine.productRates['FENNEL'] || machine.productRates['DEFAULT'];
  if (code.includes('CL-YD') || code.includes('CL-668')) return machine.productRates['CHILLI'] || machine.productRates['DEFAULT'];
  if (code.includes('BP-') || code.includes('WP-')) return machine.productRates['DEFAULT'];
  return machine.productRates['DEFAULT'];
}

// -- Is product a blend (double pass)? ----------------------------------------
function isBlend(bomEntry) {
  if (!bomEntry?.components) return false;
  // Count non-packaging components
  const activeComps = bomEntry.components.filter(c => getMachineForComponent(c.code, '') !== null);
  return activeComps.length > 1;
}

// -- Determine packing machine from UOM/pack size ------------------------------
function getPackingMachine(itemCode, uom) {
  const code = (itemCode || '').toUpperCase();
  const u    = (uom || '').toUpperCase();
  // Small packs → AFM30-T
  if (code.includes('-003') || code.includes('-004') || u.includes('125') || u.includes('250') || u.includes('500GM')) return 'AFM30-T';
  if (code.endsWith('3') || code.endsWith('4')) {
    const last = code.slice(-5);
    if (last.includes('003') || last.includes('004')) return 'AFM30-T';
  }
  // Default large packs → GS420
  return 'GS420';
}

// -- Calculate hours needed to produce X kg of a component --------------------
function calcGrindHours(neededKg, machineId, componentCode, passes) {
  const batches = Math.ceil(neededKg / BATCH_SIZE_KG);
  const batchKg = batches * BATCH_SIZE_KG; // rounded up to batch size
  const rate    = getRate(machineId, componentCode);
  const grindHrs = (batchKg / rate) * passes; // double pass for blends
  const cleanHrs = CLEANING_HRS; // one cleaning after this component
  return { batches, batchKg, grindHrs, cleanHrs, totalHrs: grindHrs + cleanHrs, surplus: batchKg - neededKg };
}

// -- Main handler --------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  try {
    const [snapRaw, intakeRaw, soLiveRaw, bomRaw] = await Promise.all([
      client.get('so:by_product'),
      client.get('mazza_po_intake'),
      client.get('mazza_so'),
      client.get('mazza_bom'),
    ]);

    const snap    = snapRaw   ? JSON.parse(snapRaw)   : {};
    const intake  = intakeRaw ? JSON.parse(intakeRaw) : [];
    const soLive  = soLiveRaw ? JSON.parse(soLiveRaw) : [];
    const bom     = bomRaw    ? JSON.parse(bomRaw)    : {};

    const liveStatus = {};
    soLive.forEach(s => { liveStatus[s.id] = s.status || 'Active'; });

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

    // -- Collect all active FG requirements ----------------------------------
    const fgRequired = {};

    // From snapshot
    Object.entries(snap).forEach(([code, p]) => {
      const activeOrders = (p.orders||[]).filter(o => !isDone(liveStatus[o.soNo]));
      if (!activeOrders.length) return;
      const qty = activeOrders.reduce((s,o) => s+(o.qty||0), 0);
      const uomCounts = {};
      activeOrders.forEach(o => { uomCounts[o.uom]=(uomCounts[o.uom]||0)+o.qty; });
      const dominantUom = Object.entries(uomCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]||'UNIT';
      if (!fgRequired[code]) fgRequired[code] = { itemCode:code, description:p.description, totalQty:0, uom:dominantUom, orders:[], deliveryDates:[] };
      fgRequired[code].totalQty += qty;
      activeOrders.forEach(o => {
        fgRequired[code].orders.push(o);
        if (o.deliveryDate) fgRequired[code].deliveryDates.push(o.deliveryDate);
      });
    });

    // From PO intake
    intake.forEach(po => {
      (po.items||[]).forEach(item => {
        const code = CODE_MAP[item.itemcode]||item.itemcode;
        const qty  = parseFloat(item.qty||0);
        if (!fgRequired[code]) fgRequired[code] = { itemCode:code, description:item.itemdescription||code, totalQty:0, uom:item.uom||'UNIT', orders:[], deliveryDates:[] };
        fgRequired[code].totalQty += qty;
        fgRequired[code].orders.push({ soNo:po.docno, customer:po.customerName, qty, uom:item.uom||'UNIT' });
        if (po.deliveryDate) fgRequired[code].deliveryDates.push(po.deliveryDate);
      });
    });

    // -- For each FG, build production jobs ----------------------------------
    const machineJobs = { 'WFJ-20':[], 'WFC-500':[], 'LG-60B':[], 'GS420':[], 'AFM30-T':[] };
    const productionPlan = [];

    Object.values(fgRequired).forEach(fg => {
      const bomEntry = bom[fg.itemCode];
      const uomKey   = (fg.uom||'UNIT').toUpperCase();
      const mult     = UOM_MULT[fg.itemCode]?.[uomKey] ?? 1;
      const bomUnits = fg.totalQty * mult; // actual units to produce
      const blend    = bomEntry ? isBlend(bomEntry) : false;
      const passes   = blend ? 2 : 1;
      const sortedDates = (fg.deliveryDates||[]).sort();
      const nextDelivery = sortedDates[0]||null;
      const daysLeft = nextDelivery ? Math.floor((new Date(nextDelivery)-new Date())/(1000*60*60*24)) : null;
      const customers = [...new Set(fg.orders.map(o=>o.customer||o.customerName).filter(Boolean))];

      if (!bomEntry) {
        productionPlan.push({ ...fg, bomMissing:true, jobs:[], totalGrindHrs:0, totalPackHrs:0, totalHrs:0, blend, passes, daysLeft, nextDelivery, customers, status:'no-bom' });
        return;
      }

      // Grinding jobs — one per component (excl. packaging)
      const grindJobs = [];
      let totalGrindHrs = 0;

      bomEntry.components.forEach(comp => {
        const machineId = getMachineForComponent(comp.code, '');
        if (!machineId) return; // skip packaging materials
        const neededKg = comp.qty * bomUnits;
        if (neededKg < 0.1) return; // skip negligible quantities
        const calc = calcGrindHours(neededKg, machineId, comp.code, passes);
        const job = {
          type:        'grind',
          component:   comp.code,
          machineId,
          machineName: MACHINES[machineId]?.type || machineId,
          neededKg,
          batches:     calc.batches,
          batchKg:     calc.batchKg,
          grindHrs:    calc.grindHrs,
          cleanHrs:    calc.cleanHrs,
          totalHrs:    calc.totalHrs,
          surplus:     calc.surplus,
          passes,
          forProduct:  fg.itemCode,
        };
        grindJobs.push(job);
        totalGrindHrs += calc.totalHrs;
        if (machineJobs[machineId]) machineJobs[machineId].push(job);
      });

      // Packing job
      const packMachineId = getPackingMachine(fg.itemCode, fg.uom);
      const packMachine   = MACHINES[packMachineId];
      const totalOutputKg = bomUnits * (comp => comp); // approx finished kg = bomUnits (1 unit per BOM)
      const finishedKg    = bomUnits; // 1 unit = roughly 1kg equivalent for packing time
      const packHrs       = finishedKg / (packMachine?.rateKgHr || 600);
      const packJob = {
        type:        'pack',
        machineId:   packMachineId,
        machineName: packMachine?.type || packMachineId,
        finishedKg,
        packHrs,
        totalHrs:    packHrs,
        forProduct:  fg.itemCode,
      };
      if (machineJobs[packMachineId]) machineJobs[packMachineId].push(packJob);

      const totalHrs = totalGrindHrs + packHrs;

      // Can we make it in time?
      let status = 'ok';
      if (daysLeft !== null) {
        const availableHrs = daysLeft * 24;
        if (totalHrs > availableHrs) status = 'at-risk';
        if (daysLeft < 0) status = 'overdue';
      }

      productionPlan.push({
        ...fg, bomMissing:false, blend, passes,
        jobs: grindJobs, packJob,
        totalGrindHrs, totalPackHrs:packHrs, totalHrs,
        daysLeft, nextDelivery, customers, status,
      });
    });

    // -- Machine utilisation for the week ------------------------------------
    const machineUtil = {};
    Object.entries(machineJobs).forEach(([machineId, jobs]) => {
      const totalHrs     = jobs.reduce((s,j) => s+(j.totalHrs||0), 0);
      const utilPct      = Math.min(Math.round((totalHrs / WEEKLY_HRS) * 100), 999);
      const machine      = MACHINES[machineId];
      machineUtil[machineId] = {
        machineId,
        name:      machine?.name || machineId,
        type:      machine?.type || '',
        totalHrs:  Math.round(totalHrs * 10) / 10,
        weeklyHrs: WEEKLY_HRS,
        utilPct,
        jobCount:  jobs.length,
        status:    utilPct >= 90 ? 'critical' : utilPct >= 70 ? 'warning' : 'ok',
      };
    });

    // Sort production plan by priority
    productionPlan.sort((a,b) => {
      const order = { overdue:0, 'at-risk':1, ok:2, 'no-bom':3 };
      if (order[a.status] !== order[b.status]) return order[a.status]-order[b.status];
      if (a.daysLeft !== null && b.daysLeft !== null) return a.daysLeft-b.daysLeft;
      if (a.daysLeft !== null) return -1;
      if (b.daysLeft !== null) return 1;
      return 0;
    });

    // Summary
    const summary = {
      totalProducts:  productionPlan.length,
      overdue:        productionPlan.filter(p=>p.status==='overdue').length,
      atRisk:         productionPlan.filter(p=>p.status==='at-risk').length,
      onTrack:        productionPlan.filter(p=>p.status==='ok').length,
      totalGrindHrs:  Math.round(Object.values(machineJobs['WFJ-20']).reduce((s,j)=>s+(j.totalHrs||0),0)*10)/10,
      wfjUtilPct:     machineUtil['WFJ-20']?.utilPct || 0,
      updatedAt:      new Date().toISOString(),
    };

    return res.status(200).json({ productionPlan, machineUtil, machineJobs: null, summary });

  } catch(err) {
    console.error('Capacity plan error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
