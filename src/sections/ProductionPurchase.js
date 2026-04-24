// ============================================================
// PRODUCTION — Purchase List
// Shows raw materials that need to be purchased to fill shortages
// Answers: "What do we need to buy today?"
// ============================================================

import { useState, useEffect } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fetchJson } from "../utils";

export default function ProductionPurchase() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchJson("/api/prospects?type=production_purchase")
      .then(resp => setData(resp))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const items = data?.items || [];
  const stats = data?.stats || {};

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: COLORS.textMuted }}>Calculating shortages…</div>;
  if (error) return <div style={{ padding: 16, background: COLORS.dangerBg, color: COLORS.dangerDark, borderRadius: RADIUS.lg }}>{error}</div>;

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <KpiCard icon="cart" iconBg={COLORS.dangerBg} iconColor={COLORS.danger}
          label="Items to Purchase" value={fmt0(stats.totalItems || 0)}
          trend="Raw materials short" />
        <KpiCard icon="trending" iconBg={COLORS.warningBg} iconColor={COLORS.warningDark}
          label="Estimated Cost" value={fmt(stats.totalCost || 0)}
          trend="Based on BOM ref cost" />
      </div>

      {items.length === 0 ? (
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: COLORS.successBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Ic name="shield" size={24} color={COLORS.success} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>All Stock Sufficient</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4 }}>No raw material shortages for current orders.</div>
          </div>
        </Card>
      ) : (
        <Card title="Purchase Requirements" subtitle="Raw materials needed to fulfil all active orders">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Material Code</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>Needed</th>
                <th style={{ ...th, textAlign: "right" }}>In Stock</th>
                <th style={{ ...th, textAlign: "right" }}>To Buy</th>
                <th style={th}>UOM</th>
                <th style={{ ...th, textAlign: "right" }}>Unit Cost</th>
                <th style={{ ...th, textAlign: "right" }}>Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.code} style={{ borderBottom: `1px solid ${COLORS.borderFaint}` }}>
                  <td style={{ padding: "12px 16px", fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{item.code}</td>
                  <td style={{ padding: "12px 16px", fontSize: 12, color: COLORS.text }}>{item.name}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 12, color: COLORS.text }}>{item.needed}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt0(item.stock)}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: COLORS.dangerDark }}>{item.shortage}</td>
                  <td style={{ padding: "12px 16px", fontSize: 10, color: COLORS.textFaint }}>{item.uom}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt(item.unitCost)}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt(item.totalCost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${COLORS.borderStrong}` }}>
                <td colSpan={7} style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14 }}>Total Purchase Cost</td>
                <td style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14, color: BRAND.accent }}>{fmt(stats.totalCost || 0)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}

const th = { padding: "10px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };
