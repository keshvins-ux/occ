// ============================================================
// GENERATE REPORT — PDF download for MoM comparison
// POST /api/generate-report
// Body: { title, customers, products, brief, totals }
// Returns: PDF file as binary download
// ============================================================

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } }
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { title, customers, products, brief, totalCurr, totalLast, delta, deltaPct, summary } = req.body;

    // Build HTML report and convert to PDF-like output
    // Since we can't use reportlab on Vercel (Python), we'll generate a downloadable HTML
    // that looks like a PDF and can be printed to PDF from the browser
    const now = new Date().toLocaleDateString('en-MY', { day: '2-digit', month: 'long', year: 'numeric' });
    const fmt = (n) => `RM ${Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>OCC MoM Comparison Report — ${title}</title>
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: #1a1f2e; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 40px; }
  .header { border-bottom: 3px solid #4F7CF7; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 22px; color: #1E3A5F; margin: 0 0 4px; }
  .header .subtitle { font-size: 13px; color: #64748B; }
  .header .logo { font-size: 14px; color: #4F7CF7; font-weight: 700; letter-spacing: 0.1em; }
  .kpi-row { display: flex; gap: 16px; margin: 20px 0; }
  .kpi { flex: 1; padding: 16px; border-radius: 10px; border: 1px solid #E2E8F0; }
  .kpi .label { font-size: 10px; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .kpi .value { font-size: 20px; font-weight: 700; color: #0F172A; margin-top: 4px; }
  .kpi .change { font-size: 11px; font-weight: 600; margin-top: 4px; }
  .kpi .change.up { color: #10B981; }
  .kpi .change.down { color: #EF4444; }
  .section { margin: 28px 0; }
  .section h2 { font-size: 15px; color: #1E3A5F; border-bottom: 1px solid #E2E8F0; padding-bottom: 8px; margin-bottom: 12px; }
  .brief { background: #F8FAFC; border-radius: 10px; padding: 20px; border-left: 4px solid #4F7CF7; margin: 20px 0; }
  .brief p { margin: 8px 0; }
  .actions { background: #ECFDF5; border-radius: 10px; padding: 16px 20px; margin: 16px 0; }
  .actions h3 { font-size: 12px; color: #059669; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 10px; }
  .actions li { margin: 6px 0; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 12px 0; }
  th { text-align: left; padding: 8px 12px; font-size: 10px; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; border-bottom: 2px solid #E2E8F0; }
  td { padding: 8px 12px; border-bottom: 1px solid #F1F5F9; }
  .right { text-align: right; }
  .bold { font-weight: 700; }
  .green { color: #10B981; }
  .red { color: #EF4444; }
  .blue { color: #4F7CF7; }
  .gray { color: #94A3B8; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 600; }
  .badge.growing { background: #ECFDF5; color: #059669; }
  .badge.declining { background: #FEF2F2; color: #DC2626; }
  .badge.new { background: rgba(79,124,247,0.1); color: #4F7CF7; }
  .badge.churned { background: #F3F4F6; color: #6B7280; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #E2E8F0; font-size: 10px; color: #94A3B8; text-align: center; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<div class="header">
  <div class="logo">OCC — OPERATIONS COMMAND CENTRE</div>
  <h1>${title || 'Month vs Month Comparison'}</h1>
  <div class="subtitle">Generated ${now} · ${process.env.TENANT_NAME || 'Seri Rasa'} / ${process.env.TENANT_LEGAL || 'Vertical Target Services Sdn. Bhd.'}</div>
</div>

<div class="kpi-row">
  <div class="kpi">
    <div class="label">Previous Month</div>
    <div class="value">${fmt(totalLast)}</div>
  </div>
  <div class="kpi">
    <div class="label">Current Month</div>
    <div class="value">${fmt(totalCurr)}</div>
  </div>
  <div class="kpi">
    <div class="label">Change</div>
    <div class="value ${delta >= 0 ? 'green' : 'red'}">${delta >= 0 ? '+' : ''}${fmt(delta)}</div>
    <div class="change ${delta >= 0 ? 'up' : 'down'}">${deltaPct}%</div>
  </div>
  <div class="kpi">
    <div class="label">Summary</div>
    <div style="font-size:11px; margin-top:6px;">
      ${summary?.growing || 0} growing · ${summary?.declining || 0} declining<br>
      ${summary?.new || 0} new · ${summary?.churned || 0} churned
    </div>
  </div>
</div>

${brief?.brief ? `
<div class="section">
  <h2>Executive Brief</h2>
  <div class="brief">
    ${brief.summary ? `<p><strong>${brief.summary}</strong></p>` : ''}
    ${(brief.brief || '').split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('')}
  </div>
  ${brief.actions?.length ? `
  <div class="actions">
    <h3>Recommended Actions</h3>
    <ol>${brief.actions.map(a => `<li>${a}</li>`).join('')}</ol>
  </div>` : ''}
</div>` : ''}

<div class="section">
  <h2>Customer Comparison</h2>
  <table>
    <thead>
      <tr><th>Customer</th><th class="right">Previous</th><th class="right">Current</th><th class="right">Change</th><th>Trend</th></tr>
    </thead>
    <tbody>
      ${(customers || []).map(c => {
        const d = c.curr - c.last;
        const pct = c.last > 0 ? ((d / c.last) * 100).toFixed(1) : '—';
        return `<tr>
          <td class="bold">${c.name || c.code}</td>
          <td class="right">${c.last ? fmt(c.last) : '—'}</td>
          <td class="right bold">${c.curr ? fmt(c.curr) : '—'}</td>
          <td class="right ${d >= 0 ? 'green' : 'red'} bold">${c.last === 0 && c.curr > 0 ? 'NEW' : c.curr === 0 && c.last > 0 ? 'Lost' : (d >= 0 ? '+' : '') + fmt(d)}</td>
          <td><span class="badge ${c.type}">${c.type}</span></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>

<div class="section">
  <h2>Product Comparison</h2>
  <table>
    <thead>
      <tr><th>Product</th><th class="right">Previous Qty</th><th class="right">Current Qty</th><th class="right">Change</th><th>Trend</th></tr>
    </thead>
    <tbody>
      ${(products || []).map(p => {
        const d = p.curr - p.last;
        return `<tr>
          <td><span class="bold">${p.name || ''}</span><br><span class="gray">${p.code}</span></td>
          <td class="right">${p.last || '—'} ${p.uom || ''}</td>
          <td class="right bold">${p.curr || '—'} ${p.uom || ''}</td>
          <td class="right ${d >= 0 ? 'green' : 'red'} bold">${p.last === 0 && p.curr > 0 ? 'NEW' : p.curr === 0 && p.last > 0 ? 'Lost' : (d >= 0 ? '+' : '') + d}</td>
          <td><span class="badge ${p.type}">${p.type}</span></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>

<div class="footer">
  ${process.env.BRAND_NAME || 'OCC'} v2 · ${process.env.TENANT_NAME || 'Seri Rasa'} / ${process.env.TENANT_LEGAL || 'Vertical Target Services Sdn. Bhd.'} · Confidential · Generated ${now}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="OCC_MoM_Report_${new Date().toISOString().slice(0, 10)}.html"`);
    return res.status(200).send(html);

  } catch (e) {
    console.error('generate-report error:', e);
    return res.status(500).json({ error: e.message });
  }
}
