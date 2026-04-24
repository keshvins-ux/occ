// ============================================================
// PRODUCTION — Gap Analysis (BOM Explosion + Stock Check)
// Explodes BOMs for all pending orders, compares against stock
// Answers: "Can we make it? What's short?"
// ============================================================

import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fetchJson } from "../utils";

export default function ProductionGap() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState("finished"); // finished | raw
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchJson("/api/prospects?type=production_gap")
      .then(resp => setData(resp))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const finishedGoods = data?.finishedGoods || [];
  const rawMaterials = data?.rawMaterials || [];
  const stats = data?.stats || {};

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: COLORS.textMuted }}>Exploding BOMs…</div>;
  if (error) return <div style={{ padding: 16, background: COLORS.dangerBg, color: COLORS.dangerDark, borderRadius: RADIUS.lg }}>{error}</div>;

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <KpiCard icon="shield" iconBg={COLORS.successBg} iconColor={COLORS.success}
          label="Ready to Produce" value={fmt0(stats.ready || 0)}
          trend={`of ${stats.totalFinishedGoods || 0} products`} />
        <KpiCard icon="alert" iconBg={COLORS.dangerBg} iconColor={COLORS.danger}
          label="Material Shortage" value={fmt0(stats.shortage || 0)}
          trend={`${stats.materialsShort || 0} raw materials short`} />
        <KpiCard icon="package" iconBg={COLORS.warningBg} iconColor={COLORS.warningDark}
          label="No BOM" value={fmt0(stats.noBom || 0)}
          trend="Items without recipe" />
        <KpiCard icon="trending" iconBg={COLORS.infoBg} iconColor={COLORS.info}
          label="Shortage Value" value={fmt(stats.totalShortageValue || 0)}
          trend="Est. purchase cost" />
      </div>

      {/* View toggle */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {[["finished", "Finished Goods"], ["raw", "Raw Materials"]].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} style={{
            padding: "8px 18px", borderRadius: RADIUS.pill, border: "none", cursor: "pointer",
            fontSize: 12, fontWeight: 600,
            background: view === k ? BRAND.accent : COLORS.surfaceAlt,
            color: view === k ? "#fff" : COLORS.textMuted,
          }}>{l}</button>
        ))}
      </div>

      {/* Finished Goods View */}
      {view === "finished" && (
        <Card title="Finished Goods — Stock vs Demand" subtitle="BOM-exploded view per product">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>▾</th>
                <th style={th}>Item Code</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>Pending Qty</th>
                <th style={{ ...th, textAlign: "right" }}>In Stock</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {finishedGoods.map(fg => (
                <FGRow key={fg.itemcode} fg={fg} expanded={expanded === fg.itemcode}
                  onToggle={() => setExpanded(expanded === fg.itemcode ? null : fg.itemcode)} />
              ))}
              {finishedGoods.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 40, textAlign: "center", color: COLORS.textFaint }}>No pending production items</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {/* Raw Materials View */}
      {view === "raw" && (
        <Card title="Raw Materials Required" subtitle="Aggregated across all pending orders via BOM explosion">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Material</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>Needed</th>
                <th style={{ ...th, textAlign: "right" }}>In Stock</th>
                <th style={{ ...th, textAlign: "right" }}>Shortage</th>
                <th style={th}>UOM</th>
                <th style={{ ...th, textAlign: "right" }}>Est. Cost</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rawMaterials.map(rm => (
                <tr key={rm.code} style={{ borderBottom: `1px solid ${COLORS.borderFaint}` }}>
                  <td style={{ padding: "10px 16px", fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{rm.code}</td>
                  <td style={{ padding: "10px 16px", fontSize: 12, color: COLORS.text }}>{rm.name}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.text }}>{rm.totalNeeded}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt0(rm.currentStock)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: rm.shortage > 0 ? COLORS.dangerDark : COLORS.successDark }}>{rm.shortage > 0 ? rm.shortage : "—"}</td>
                  <td style={{ padding: "10px 16px", fontSize: 10, color: COLORS.textFaint }}>{rm.uom}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: rm.estimatedCost > 0 ? COLORS.dangerDark : COLORS.textFaint }}>{rm.estimatedCost > 0 ? fmt(rm.estimatedCost) : "—"}</td>
                  <td style={{ padding: "10px 16px" }}>
                    <Pill color={rm.status === "sufficient" ? COLORS.successDark : COLORS.dangerDark}
                      bg={rm.status === "sufficient" ? COLORS.successBg : COLORS.dangerBg} size="sm">
                      {rm.status === "sufficient" ? "OK" : "Short"}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function FGRow({ fg, expanded, onToggle }) {
  const statusConfig = {
    ready: { label: "Ready", color: COLORS.successDark, bg: COLORS.successBg },
    in_stock: { label: "In Stock", color: COLORS.successDark, bg: COLORS.successBg },
    shortage: { label: "Shortage", color: COLORS.dangerDark, bg: COLORS.dangerBg },
    no_bom: { label: "No BOM", color: COLORS.warningDark, bg: COLORS.warningBg },
  };
  const s = statusConfig[fg.status] || statusConfig.no_bom;

  return (
    <>
      <tr onClick={onToggle} style={{
        borderBottom: `1px solid ${COLORS.borderFaint}`, cursor: fg.hasBom ? "pointer" : "default",
        background: expanded ? `${BRAND.accent}08` : "transparent",
      }}>
        <td style={{ padding: "10px 12px", width: 24 }}>
          {fg.hasBom && <Ic name={expanded ? "chevronDown" : "chevron"} size={12} color={expanded ? BRAND.accent : COLORS.textFaint} />}
        </td>
        <td style={{ padding: "10px 16px", fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{fg.itemcode}</td>
        <td style={{ padding: "10px 16px", fontSize: 12, color: COLORS.text }}>{fg.description}</td>
        <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt0(fg.pendingQty)}</td>
        <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt0(fg.currentStock)}</td>
        <td style={{ padding: "10px 16px" }}>
          <Pill color={s.color} bg={s.bg} size="sm">{s.label}</Pill>
        </td>
      </tr>
      {expanded && fg.components.length > 0 && (
        <tr>
          <td colSpan={6} style={{ padding: 0 }}>
            <div style={{ padding: "8px 24px 12px 60px", background: COLORS.surfaceAlt }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.textFaint, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                BOM Components for {fg.itemcode}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thSm}>Component</th>
                    <th style={thSm}>Name</th>
                    <th style={{ ...thSm, textAlign: "right" }}>Needed</th>
                    <th style={{ ...thSm, textAlign: "right" }}>Stock</th>
                    <th style={{ ...thSm, textAlign: "right" }}>Shortage</th>
                    <th style={thSm}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {fg.components.map((comp, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${COLORS.borderFaint}22` }}>
                      <td style={{ padding: "5px 8px", fontFamily: FONT.mono, fontSize: 11, color: "#1E3A5F" }}>{comp.code}</td>
                      <td style={{ padding: "5px 8px", fontSize: 11, color: COLORS.text }}>{comp.name}</td>
                      <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11 }}>{comp.needed} {comp.uom}</td>
                      <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, color: COLORS.textMuted }}>{fmt0(comp.stock)}</td>
                      <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 700, color: comp.shortage > 0 ? COLORS.dangerDark : COLORS.successDark }}>
                        {comp.shortage > 0 ? comp.shortage.toFixed(2) : "—"}
                      </td>
                      <td style={{ padding: "5px 8px" }}>
                        <Pill color={comp.status === "sufficient" ? COLORS.successDark : COLORS.dangerDark}
                          bg={comp.status === "sufficient" ? COLORS.successBg : COLORS.dangerBg} size="sm">
                          {comp.status === "sufficient" ? "OK" : "Short"}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const th = { padding: "10px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };
const thSm = { padding: "5px 8px", textAlign: "left", fontSize: 9, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" };
