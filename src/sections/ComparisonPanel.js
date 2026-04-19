import { useState, useEffect } from "react";
import Ic from "../components/Ic";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";

export default function ComparisonPanel({ onClose }) {
  const [tab, setTab] = useState("customers");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // AI Brief
  const [brief, setBrief] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState("");

  // Expanded customer rows (SO detail)
  const [expanded, setExpanded] = useState({});
  const [detailData, setDetailData] = useState({});
  const [detailLoading, setDetailLoading] = useState({});

  // PDF
  const [pdfLoading, setPdfLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchJson("/api/prospects?type=comparison")
      .then((resp) => !cancelled && setData(resp))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // Load AI brief on first render
  useEffect(() => {
    let cancelled = false;
    setBriefLoading(true);
    fetchJson("/api/prospects?type=comparison_brief")
      .then((resp) => !cancelled && setBrief(resp))
      .catch((err) => !cancelled && setBriefError(err.message))
      .finally(() => !cancelled && setBriefLoading(false));
    return () => { cancelled = true; };
  }, []);

  const items = tab === "customers" ? data?.customers || [] : data?.products || [];
  const totalLast = items.reduce((s, d) => s + (d.last || 0), 0);
  const totalCurr = items.reduce((s, d) => s + (d.curr || 0), 0);
  const delta = totalCurr - totalLast;
  const deltaPct = totalLast > 0 ? ((delta / totalLast) * 100).toFixed(1) : "—";
  const summary = {
    growing: items.filter((d) => d.type === "growing").length,
    declining: items.filter((d) => d.type === "declining").length,
    new: items.filter((d) => d.type === "new").length,
    churned: items.filter((d) => d.type === "churned").length,
  };

  // Toggle expand for a customer row — loads SO detail
  function toggleExpand(code) {
    if (expanded[code]) {
      setExpanded((e) => ({ ...e, [code]: false }));
      return;
    }
    setExpanded((e) => ({ ...e, [code]: true }));
    if (!detailData[code]) {
      setDetailLoading((l) => ({ ...l, [code]: true }));
      fetchJson(`/api/prospects?type=comparison_detail&code=${code}`)
        .then((resp) => setDetailData((d) => ({ ...d, [code]: resp })))
        .catch(() => {})
        .finally(() => setDetailLoading((l) => ({ ...l, [code]: false })));
    }
  }

  // PDF download
  async function downloadPDF() {
    setPdfLoading(true);
    try {
      const reportData = {
        title: data?.title || "MoM Comparison",
        customers: data?.customers || [],
        products: data?.products || [],
        brief: brief || null,
        totalCurr, totalLast, delta, deltaPct, summary,
      };
      const resp = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reportData),
      });
      if (!resp.ok) throw new Error("PDF generation failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `OCC_MoM_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Failed to generate PDF: " + e.message);
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div style={{ marginBottom: 20, background: COLORS.surface, borderRadius: RADIUS.xxl, boxShadow: SHADOWS.card, border: `1.5px solid rgba(79, 124, 247, 0.25)`, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${COLORS.borderFaint}`, background: `linear-gradient(90deg, rgba(79, 124, 247, 0.1) 0%, rgba(99, 102, 241, 0.05) 100%)` }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Ic name="sparkle" size={14} color={BRAND.accent} />
            <span style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>Month vs Month Comparison</span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, letterSpacing: "-0.015em" }}>{data?.title || "Loading…"}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={downloadPDF} disabled={pdfLoading || loading} style={{ padding: "8px 16px", borderRadius: RADIUS.md, background: COLORS.surface, border: `1px solid ${COLORS.borderStrong}`, color: BRAND.accent, fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, opacity: pdfLoading ? 0.6 : 1 }}>
            <Ic name="download" size={12} color={BRAND.accent} />
            {pdfLoading ? "Generating…" : "Download PDF"}
          </button>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: RADIUS.md, background: COLORS.surface, border: `1px solid ${COLORS.borderStrong}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <Ic name="x" size={14} color={COLORS.textMuted} />
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>Loading comparison…</div>
      ) : error ? (
        <div style={{ padding: 40, textAlign: "center", color: COLORS.dangerDark, fontSize: 13 }}>{error}</div>
      ) : (
        <>
          {/* AI CEO Brief */}
          <AIBriefSection brief={brief} loading={briefLoading} error={briefError} />

          {/* Summary bar */}
          <div style={{ padding: "18px 24px", display: "flex", gap: 20, flexWrap: "wrap", borderBottom: `1px solid ${COLORS.borderFaint}`, alignItems: "center" }}>
            <SummaryBlock label={data?.source_note?.split(' vs ')[1] || "Last month"} value={fmt(totalLast)} />
            <span style={{ color: COLORS.borderStrong, fontSize: 20 }}>→</span>
            <SummaryBlock label={data?.source_note?.split(' vs ')[0] || "This month"} value={fmt(totalCurr)} bold />
            <DeltaBlock delta={delta} deltaPct={deltaPct} />
            <div style={{ display: "flex", gap: 12, marginLeft: "auto", flexWrap: "wrap" }}>
              <StatDot label="growing" count={summary.growing} color={COLORS.success} />
              <StatDot label="declining" count={summary.declining} color={COLORS.danger} />
              <StatDot label="new" count={summary.new} color={BRAND.accent} />
              {summary.churned > 0 && <StatDot label="churned" count={summary.churned} color={COLORS.neutral} />}
            </div>
          </div>

          {/* Tab switcher */}
          <div style={{ padding: "14px 24px 0", display: "flex", gap: 4, borderBottom: `1px solid ${COLORS.borderFaint}` }}>
            {[["customers", "Customer Comparison"], ["products", "Product Comparison"]].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{ padding: "10px 20px", fontSize: 12, fontWeight: 600, color: tab === k ? BRAND.accent : COLORS.textFaint, background: "transparent", border: "none", cursor: "pointer", borderBottom: tab === k ? `2px solid ${BRAND.accent}` : "2px solid transparent", marginBottom: -1, transition: "all 0.15s" }}>{l}</button>
            ))}
          </div>

          {/* Table */}
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0, background: COLORS.surface, zIndex: 1 }}>
                <tr>
                  {tab === "customers" && <th style={thStyle}>▾</th>}
                  <th style={thStyle}>{tab === "customers" ? "Customer" : "Product"}</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Previous</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Current</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Change</th>
                  <th style={thStyle}>Trend</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d, i) => (
                  <CustomerRow
                    key={d.code + i}
                    d={d}
                    tab={tab}
                    expanded={expanded[d.code]}
                    detail={detailData[d.code]}
                    detailLoading={detailLoading[d.code]}
                    onToggle={() => tab === "customers" && toggleExpand(d.code)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{ padding: "14px 24px", borderTop: `1px solid ${COLORS.borderFaint}`, background: COLORS.surfaceAlt, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: COLORS.textFaint }}>Source: sql_salesinvoices · comparing calendar months</div>
          </div>
        </>
      )}
    </div>
  );
}

// ── AI BRIEF SECTION ──────────────────────────────────────────
function AIBriefSection({ brief, loading, error }) {
  const [open, setOpen] = useState(true);

  return (
    <div style={{ borderBottom: `1px solid ${COLORS.borderFaint}` }}>
      <div onClick={() => setOpen(!open)} style={{ padding: "16px 24px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: `linear-gradient(90deg, rgba(79, 124, 247, 0.04) 0%, transparent 100%)` }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: `linear-gradient(135deg, ${BRAND.accent}, #6366F1)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Ic name="sparkle" size={14} color="#fff" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.04em" }}>AI Executive Brief</div>
          {brief?.summary && !loading && (
            <div style={{ fontSize: 13, color: COLORS.text, fontWeight: 600, marginTop: 2 }}>{brief.summary}</div>
          )}
        </div>
        <Ic name={open ? "chevronDown" : "chevron"} size={14} color={COLORS.textMuted} />
      </div>

      {open && (
        <div style={{ padding: "0 24px 20px" }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: "center", color: COLORS.textFaint, fontSize: 12 }}>
              <Ic name="sparkle" size={14} color={BRAND.accent} /> Opus is analysing your data…
            </div>
          ) : error ? (
            <div style={{ padding: 12, color: COLORS.dangerDark, fontSize: 12 }}>{error}</div>
          ) : brief ? (
            <div>
              {/* Brief text */}
              <div style={{ fontSize: 13, lineHeight: 1.7, color: COLORS.textSecondary, whiteSpace: "pre-line", marginBottom: 16 }}>
                {brief.brief}
              </div>

              {/* Action items */}
              {brief.actions && brief.actions.length > 0 && (
                <div style={{ background: COLORS.surfaceAlt, borderRadius: RADIUS.lg, padding: "14px 18px", border: `1px solid ${COLORS.borderFaint}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Recommended Actions</div>
                  {brief.actions.map((a, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0" }}>
                      <div style={{ width: 20, height: 20, borderRadius: 6, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: BRAND.accent }}>{i + 1}</span>
                      </div>
                      <span style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.5 }}>{a}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Risk / Opportunity amounts */}
              {(brief.risk_amount > 0 || brief.opportunity_amount > 0) && (
                <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                  {brief.risk_amount > 0 && (
                    <div style={{ flex: 1, padding: "10px 14px", borderRadius: RADIUS.md, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22` }}>
                      <div style={{ fontSize: 10, color: COLORS.dangerDark, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Revenue at Risk</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.dangerDark, marginTop: 4 }}>{fmt(brief.risk_amount)}</div>
                    </div>
                  )}
                  {brief.opportunity_amount > 0 && (
                    <div style={{ flex: 1, padding: "10px 14px", borderRadius: RADIUS.md, background: COLORS.successBg, border: `1px solid ${COLORS.success}22` }}>
                      <div style={{ fontSize: 10, color: COLORS.successDark, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Opportunity</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.successDark, marginTop: 4 }}>{fmt(brief.opportunity_amount)}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── CUSTOMER ROW (expandable) ─────────────────────────────────
function CustomerRow({ d, tab, expanded, detail, detailLoading, onToggle }) {
  const isMoney = tab === "customers";
  const fmtVal = (v) => (isMoney ? fmt(v) : `${fmt0(v)} ${d.uom || ""}`);
  const isClickable = tab === "customers";

  return (
    <>
      <tr onClick={isClickable ? onToggle : undefined} style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, cursor: isClickable ? "pointer" : "default", background: expanded ? `rgba(79, 124, 247, 0.04)` : "transparent" }}>
        {tab === "customers" && (
          <td style={{ padding: "14px 12px 14px 24px", width: 24 }}>
            <Ic name={expanded ? "chevronDown" : "chevron"} size={12} color={expanded ? BRAND.accent : COLORS.textFaint} />
          </td>
        )}
        <td style={{ padding: "14px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar name={d.name || d.code} size={30} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{d.name || d.code}</div>
              {d.code && <div style={{ fontSize: 11, color: COLORS.textFaint, fontFamily: FONT.mono, marginTop: 1 }}>{d.code}</div>}
            </div>
          </div>
        </td>
        <td style={{ padding: "14px 18px", textAlign: "right", fontSize: 13, fontWeight: 500, color: COLORS.textSecondary, fontVariantNumeric: "tabular-nums" }}>
          {d.last === 0 ? "—" : fmtVal(d.last)}
        </td>
        <td style={{ padding: "14px 18px", textAlign: "right", fontSize: 13, fontWeight: 700, color: COLORS.text, fontVariantNumeric: "tabular-nums" }}>
          {d.curr === 0 ? "—" : fmtVal(d.curr)}
        </td>
        <td style={{ padding: "14px 18px", textAlign: "right" }}>
          <ChangeCell last={d.last} curr={d.curr} isMoney={isMoney} />
        </td>
        <td style={{ padding: "14px 24px" }}>
          <TypeBadge type={d.type} />
        </td>
      </tr>

      {/* Expanded SO detail */}
      {expanded && tab === "customers" && (
        <tr>
          <td colSpan={6} style={{ padding: 0 }}>
            <SODetailPanel detail={detail} loading={detailLoading} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── SO DETAIL PANEL (expandable sub-rows) ─────────────────────
function SODetailPanel({ detail, loading }) {
  if (loading) return <div style={{ padding: "16px 60px", fontSize: 12, color: COLORS.textFaint }}>Loading sales orders…</div>;
  if (!detail) return null;

  const curr = detail.currentMonth || [];
  const prev = detail.previousMonth || [];

  return (
    <div style={{ padding: "12px 24px 16px 60px", background: COLORS.surfaceAlt, borderTop: `1px solid ${COLORS.borderFaint}` }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Current month */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>This Month</div>
          {curr.length === 0 ? (
            <div style={{ fontSize: 12, color: COLORS.textFaint, fontStyle: "italic" }}>No orders this month</div>
          ) : (
            curr.map((so) => <SORow key={so.docno} so={so} />)
          )}
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: COLORS.text }}>Total: {fmt(curr.reduce((s, o) => s + o.amount, 0))}</div>
        </div>

        {/* Previous month */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Last Month</div>
          {prev.length === 0 ? (
            <div style={{ fontSize: 12, color: COLORS.textFaint, fontStyle: "italic" }}>No orders last month</div>
          ) : (
            prev.map((so) => <SORow key={so.docno} so={so} />)
          )}
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: COLORS.textSecondary }}>Total: {fmt(prev.reduce((s, o) => s + o.amount, 0))}</div>
        </div>
      </div>
    </div>
  );
}

function SORow({ so }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 12, fontFamily: FONT.mono, fontWeight: 600, color: "#1E3A5F" }}>{so.docno}</span>
        <span style={{ fontSize: 11, color: COLORS.textFaint }}>{fmtD(so.date)}</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>{fmt(so.amount)}</span>
        <Pill
          color={so.status === "complete" ? COLORS.successDark : so.status === "active" ? COLORS.info : COLORS.neutral}
          bg={so.status === "complete" ? COLORS.successBg : so.status === "active" ? COLORS.infoBg : COLORS.neutralBg}
        >
          {so.status}
        </Pill>
      </div>
    </div>
  );
}

// ── SHARED COMPONENTS ─────────────────────────────────────────
const thStyle = { padding: "12px 18px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };

function SummaryBlock({ label, value, bold }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: bold ? 700 : 600, color: bold ? COLORS.text : COLORS.textSecondary }}>{value}</div>
    </div>
  );
}

function DeltaBlock({ delta, deltaPct }) {
  const up = delta >= 0;
  return (
    <div style={{ marginLeft: 16, padding: "8px 14px", borderRadius: RADIUS.md, background: up ? COLORS.successBg : COLORS.dangerBg, border: `1px solid ${up ? COLORS.success : COLORS.danger}22` }}>
      <div style={{ fontSize: 10, color: up ? COLORS.successDark : COLORS.dangerDark, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, marginBottom: 2 }}>Change</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: up ? COLORS.successDark : COLORS.dangerDark }}>{up ? "+" : ""}{fmt(delta)} · {deltaPct}%</div>
    </div>
  );
}

function StatDot({ label, count, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color, fontWeight: 600 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />{count} {label}
    </div>
  );
}

function ChangeCell({ last, curr, isMoney }) {
  if (last === 0 && curr > 0) return <span style={{ color: BRAND.accent, fontWeight: 700, fontSize: 12 }}>NEW</span>;
  if (curr === 0 && last > 0) return <span style={{ color: COLORS.neutral, fontWeight: 600, fontSize: 12 }}>Lost</span>;
  const d = curr - last;
  const pct = last > 0 ? ((d / last) * 100).toFixed(1) : "—";
  const up = d > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: up ? COLORS.successDark : COLORS.dangerDark }}>{up ? "+" : ""}{isMoney ? fmt(d) : fmt0(d)}</span>
      <span style={{ fontSize: 10, fontWeight: 600, color: up ? COLORS.success : COLORS.danger, marginTop: 1 }}>{up ? "+" : ""}{pct}%</span>
    </div>
  );
}

function TypeBadge({ type }) {
  const styles = {
    growing: { bg: COLORS.successBg, color: COLORS.successDark, label: "↑ Growing" },
    declining: { bg: COLORS.dangerBg, color: COLORS.dangerDark, label: "↓ Declining" },
    new: { bg: BRAND.accentGlow, color: BRAND.accent, label: "● New" },
    churned: { bg: COLORS.neutralBg, color: COLORS.neutral, label: "✕ Churned" },
  };
  const s = styles[type] || styles.growing;
  return <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 10.5, fontWeight: 600, background: s.bg, color: s.color }}>{s.label}</span>;
}
