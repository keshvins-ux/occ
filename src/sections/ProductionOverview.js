// ============================================================
// PRODUCTION — Overview
// CEO morning dashboard: stock position, readiness, price trends, AI brief
// ============================================================

import { useState, useEffect } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fetchJson } from "../utils";

export default function ProductionOverview() {
  const [data, setData] = useState(null);
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [briefLoading, setBriefLoading] = useState(false);
  const [error, setError] = useState("");
  const [stockSearch, setStockSearch] = useState("");
  const [trendView, setTrendView] = useState("alerts");

  useEffect(() => {
    setLoading(true);
    fetchJson("/api/prospects?type=production_overview")
      .then(resp => setData(resp))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function loadBrief() {
    setBriefLoading(true);
    fetchJson("/api/prospects?type=production_brief")
      .then(resp => setBrief(resp))
      .catch(() => setBrief({ summary: "Brief unavailable", brief: "", actions: [] }))
      .finally(() => setBriefLoading(false));
  }

  const stock = data?.stock || {};
  const priceTrends = data?.priceTrends || [];
  const priceAlerts = data?.priceAlerts || [];
  const readiness = data?.readiness || {};

  const filteredStock = (stock.items || []).filter(s =>
    !stockSearch ||
    s.code?.toLowerCase().includes(stockSearch.toLowerCase()) ||
    s.description?.toLowerCase().includes(stockSearch.toLowerCase())
  );

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: COLORS.textMuted }}>Loading production overview…</div>;
  if (error) return <div style={{ padding: 16, background: COLORS.dangerBg, color: COLORS.dangerDark, borderRadius: RADIUS.lg }}>{error}</div>;

  const readyPct = readiness.total > 0 ? Math.round((readiness.ready / readiness.total) * 100) : 0;

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <KpiCard icon="package" iconBg={BRAND.accentGlow} iconColor={BRAND.accent}
          label="Total Stock Value" value={fmt(stock.totalValue || 0)}
          trend={`${fmt0(stock.totalItems || 0)} items`} />
        <KpiCard icon="shield" iconBg={readyPct >= 50 ? COLORS.successBg : COLORS.dangerBg}
          iconColor={readyPct >= 50 ? COLORS.success : COLORS.danger}
          label="Production Readiness" value={`${readyPct}%`}
          trend={`${readiness.ready} ready, ${readiness.shortage} short, ${readiness.noBom} no BOM`} />
        <KpiCard icon="alert" iconBg={stock.negativeStock > 0 ? COLORS.dangerBg : COLORS.successBg}
          iconColor={stock.negativeStock > 0 ? COLORS.danger : COLORS.success}
          label="Stock Alerts" value={fmt0(stock.zeroStock || 0)}
          trend={`${stock.negativeStock || 0} negative balance`} />
        <KpiCard icon="trending" iconBg={priceAlerts.length > 0 ? COLORS.warningBg : COLORS.successBg}
          iconColor={priceAlerts.length > 0 ? COLORS.warningDark : COLORS.success}
          label="Price Alerts" value={fmt0(priceAlerts.length)}
          trend="Items with >10% cost increase" />
      </div>

      {/* AI Production Brief */}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ padding: "20px 24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: brief ? 16 : 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 12, background: `linear-gradient(135deg, ${BRAND.accent}, #6366F1)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Ic name="sparkle" size={16} color="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.text }}>AI Production Brief</div>
                <div style={{ fontSize: 11, color: COLORS.textMuted }}>Month-over-month analysis powered by Claude Opus 4.7</div>
              </div>
            </div>
            {!brief && !briefLoading && (
              <button onClick={loadBrief} style={{
                padding: "10px 20px", borderRadius: RADIUS.lg, background: BRAND.accentGradient,
                color: "#fff", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                boxShadow: SHADOWS.glow, display: "flex", alignItems: "center", gap: 6,
              }}>
                <Ic name="sparkle" size={12} color="#fff" /> Generate Brief
              </button>
            )}
            {briefLoading && (
              <div style={{ fontSize: 12, color: BRAND.accent, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: BRAND.accent, animation: "pulse 1.5s infinite" }} />
                Analysing production data…
              </div>
            )}
          </div>

          {brief && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: BRAND.accent, marginBottom: 12, lineHeight: 1.4 }}>{brief.summary}</div>
              <div style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.8, whiteSpace: "pre-line", marginBottom: 16 }}>{brief.brief}</div>
              {brief.actions?.length > 0 && (
                <div style={{ padding: "14px 18px", borderRadius: RADIUS.lg, background: COLORS.surfaceAlt, border: `1px solid ${COLORS.borderFaint}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Recommended Actions</div>
                  {brief.actions.map((a, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
                      <div style={{ width: 20, height: 20, borderRadius: 6, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: BRAND.accent, flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                      <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.5 }}>{a}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
      </Card>

      {/* Row: Stock Inventory + Price Trends */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 20 }}>

        {/* Stock Inventory */}
        <Card title="Stock Inventory" subtitle={`${fmt0(stock.totalItems || 0)} items · Total value ${fmt(stock.totalValue || 0)}`}>
          <div style={{ padding: "12px 24px 0", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
            <input value={stockSearch} onChange={e => setStockSearch(e.target.value)}
              placeholder="Search stock items…"
              style={{ width: "100%", padding: "8px 12px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, outline: "none", background: COLORS.surfaceAlt, color: COLORS.text, marginBottom: 12 }} />
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0, background: COLORS.surface, zIndex: 1 }}>
                <tr>
                  <th style={th}>Code</th>
                  <th style={th}>Description</th>
                  <th style={{ ...th, textAlign: "right" }}>Balance</th>
                  <th style={th}>UOM</th>
                  <th style={{ ...th, textAlign: "right" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {filteredStock.slice(0, 100).map(s => {
                  const statusColor = s.balance < 0 ? COLORS.dangerDark : s.balance === 0 ? COLORS.warningDark : COLORS.text;
                  const rowBg = s.balance < 0 ? COLORS.dangerBg + "44" : s.balance === 0 ? COLORS.warningBg + "44" : "transparent";
                  return (
                    <tr key={s.code} style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, background: rowBg }}>
                      <td style={{ padding: "8px 16px", fontFamily: FONT.mono, fontSize: 11, fontWeight: 600, color: "#1E3A5F" }}>{s.code}</td>
                      <td style={{ padding: "8px 16px", fontSize: 11, color: COLORS.text }}>{s.description}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right", fontSize: 12, fontWeight: 700, color: statusColor }}>{fmt0(s.balance)}</td>
                      <td style={{ padding: "8px 16px", fontSize: 10, color: COLORS.textFaint }}>{s.uom}</td>
                      <td style={{ padding: "8px 16px", textAlign: "right", fontSize: 11, color: s.value > 0 ? COLORS.text : COLORS.textFaint }}>{s.value > 0 ? fmt(s.value) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredStock.length > 100 && (
            <div style={{ padding: "10px 24px", fontSize: 11, color: COLORS.textFaint, borderTop: `1px solid ${COLORS.borderFaint}` }}>
              Showing 100 of {filteredStock.length} items. Search to narrow down.
            </div>
          )}
        </Card>

        {/* Purchase Price Trends */}
        <Card title="Purchase Price Trends" subtitle="6-month raw material cost movement">
          <div style={{ padding: "12px 24px 0", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              {[["alerts", `Alerts (${priceAlerts.length})`], ["all", `All (${priceTrends.length})`]].map(([k, l]) => (
                <button key={k} onClick={() => setTrendView(k)} style={{
                  padding: "6px 14px", borderRadius: RADIUS.pill, border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  background: trendView === k ? BRAND.accent : COLORS.surfaceAlt,
                  color: trendView === k ? "#fff" : COLORS.textMuted,
                }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {(trendView === "alerts" ? priceAlerts : priceTrends).length === 0 ? (
              <div style={{ padding: 40, textAlign: "center" }}>
                <div style={{ width: 48, height: 48, borderRadius: 14, background: COLORS.successBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                  <Ic name="shield" size={20} color={COLORS.success} />
                </div>
                <div style={{ fontSize: 13, color: COLORS.textMuted }}>No significant price changes</div>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Material</th>
                    <th style={{ ...th, textAlign: "right" }}>Early</th>
                    <th style={{ ...th, textAlign: "right" }}>Latest</th>
                    <th style={{ ...th, textAlign: "right" }}>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {(trendView === "alerts" ? priceAlerts : priceTrends).map(t => (
                    <tr key={t.code} style={{ borderBottom: `1px solid ${COLORS.borderFaint}` }}>
                      <td style={{ padding: "10px 16px" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text }}>{t.name}</div>
                        <div style={{ fontSize: 10, fontFamily: FONT.mono, color: COLORS.textFaint }}>{t.code}</div>
                      </td>
                      <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt(t.earliestPrice)}</td>
                      <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, fontWeight: 700, color: COLORS.text }}>{fmt(t.latestPrice)}</td>
                      <td style={{ padding: "10px 16px", textAlign: "right" }}>
                        <Pill
                          color={t.changePct > 10 ? COLORS.dangerDark : t.changePct > 0 ? COLORS.warningDark : COLORS.successDark}
                          bg={t.changePct > 10 ? COLORS.dangerBg : t.changePct > 0 ? COLORS.warningBg : COLORS.successBg}
                          size="sm">
                          {t.changePct > 0 ? "+" : ""}{t.changePct}%
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

const th = { padding: "8px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };
