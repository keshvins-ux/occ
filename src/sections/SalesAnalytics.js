// ============================================================
// SALES ANALYTICS — CEO-Level Intelligence
//
// Answers: "Where is the business heading and what should I do?"
//
// Sections:
//   1. KPIs — Growth, New vs Repeat, Concentration, Unassigned alert
//   2. Revenue Trend — 6-month bar chart with visual trajectory
//   3. Customer Intelligence — concentration risk + new vs repeat split
//   4. Agent Performance — revenue, orders, avg order size
//   5. Product Analysis — top products by revenue with qty
// ============================================================

import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Avatar from "../components/Avatar";
import Pill from "../components/Pill";
import SortableTable from "../components/SortableTable";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fetchJson, dateQs } from "../utils";
import { useDateRange } from "../contexts/DateRangeContext";

export default function SalesAnalytics() {
  const { range } = useDateRange();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson(`/api/prospects?type=analytics${dateQs(range)}`)
      .then((resp) => !cancelled && setData(resp))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [range.days, range.fromDate]);

  const agents = data?.agents || [];
  const products = data?.products || [];
  const kpis = data?.kpis || {};
  const trend = data?.monthlyTrend || [];
  const topCustomers = data?.topCustomers || [];

  if (loading) return <LoadingState />;
  if (error) return <ErrorBanner message={error} />;

  const maxTrend = Math.max(...trend.map(t => t.invoiced), 1);

  return (
    <div>
      {/* ── KPI STRIP ──────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <KpiCard
          icon="trending"
          iconBg={kpis.currentRev >= kpis.previousRev ? COLORS.successBg : COLORS.dangerBg}
          iconColor={kpis.currentRev >= kpis.previousRev ? COLORS.success : COLORS.danger}
          label={`Growth (${range.label})`}
          value={kpis.growth || "—"}
          trend={`${fmt(kpis.currentRev || 0)} vs ${fmt(kpis.previousRev || 0)}`}
        />
        <KpiCard
          icon="user"
          iconBg={BRAND.accentGlow}
          iconColor={BRAND.accent}
          label="Customers"
          value={fmt0(kpis.totalCustomers || 0)}
          trend={`${kpis.newCustomers || 0} new · ${kpis.repeatCustomers || 0} repeat`}
        />
        <KpiCard
          icon="monitor"
          iconBg="#FFF7ED"
          iconColor={COLORS.warningDark}
          label="Top 5 Concentration"
          value={`${kpis.topCustomerShare || 0}%`}
          trend={kpis.topCustomerShare > 60 ? "High risk" : kpis.topCustomerShare > 40 ? "Moderate" : "Healthy"}
        />
        {kpis.unassignedRevenue > 0 && (
          <KpiCard
            icon="alert"
            iconBg={COLORS.dangerBg}
            iconColor={COLORS.danger}
            label="Unassigned Orders"
            value={fmt(kpis.unassignedRevenue)}
            trend={`${kpis.unassignedOrders} orders without agent`}
          />
        )}
      </div>

      {/* ── UNASSIGNED ALERT ───────────────────────────────── */}
      {kpis.unassignedRevenue > 0 && (
        <div style={{
          padding: "12px 20px", borderRadius: RADIUS.lg, marginBottom: 20,
          background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <Ic name="alert" size={16} color={COLORS.dangerDark} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.dangerDark }}>
              {fmt(kpis.unassignedRevenue)} in {kpis.unassignedOrders} orders have no sales agent assigned.
            </span>
            <span style={{ fontSize: 12, color: COLORS.dangerDark, marginLeft: 8 }}>
              No commission tracking or accountability for this revenue.
            </span>
          </div>
        </div>
      )}

      {/* ── ROW 1: TREND + CUSTOMER INTELLIGENCE ───────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 20, marginBottom: 20 }}>

        {/* 6-Month Revenue Trend */}
        <Card title="Revenue Trend" subtitle="Monthly invoiced — last 6 months">
          <div style={{ padding: "24px 28px 28px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 20, height: 180 }}>
              {trend.map((m, i) => {
                const pct = (m.invoiced / maxTrend) * 100;
                const isLatest = i === trend.length - 1;
                return (
                  <div key={m.label} style={{ flex: 1, textAlign: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.text, marginBottom: 6 }}>
                      {fmt(m.invoiced)}
                    </div>
                    <div style={{
                      height: 140, display: "flex", alignItems: "flex-end", justifyContent: "center",
                    }}>
                      <div style={{
                        width: "100%", maxWidth: 48,
                        height: `${Math.max(pct, 4)}%`,
                        background: isLatest
                          ? BRAND.accentGradient
                          : `linear-gradient(180deg, #60A5FA 0%, #2563EB 100%)`,
                        borderRadius: "8px 8px 4px 4px",
                        boxShadow: isLatest ? SHADOWS.glow : "0 3px 12px rgba(37, 99, 235, 0.15)",
                        opacity: isLatest ? 1 : 0.7 + (i / trend.length) * 0.3,
                      }} />
                    </div>
                    <div style={{
                      fontSize: 12, marginTop: 10, fontWeight: isLatest ? 700 : 500,
                      color: isLatest ? BRAND.accent : COLORS.textMuted,
                    }}>
                      {m.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Customer Intelligence */}
        <Card title="Customer Intelligence" subtitle={range.label}>
          <div style={{ padding: "20px 24px" }}>

            {/* New vs Repeat */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                New vs Repeat
              </div>
              <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                <div style={{ flex: 1, padding: "12px 14px", borderRadius: RADIUS.lg, background: BRAND.accentGlow, border: `1px solid ${BRAND.accent}22` }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.accent }}>{kpis.newCustomers || 0}</div>
                  <div style={{ fontSize: 11, color: BRAND.accent, fontWeight: 600, marginTop: 2 }}>New customers</div>
                </div>
                <div style={{ flex: 1, padding: "12px 14px", borderRadius: RADIUS.lg, background: COLORS.successBg, border: `1px solid ${COLORS.success}22` }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: COLORS.successDark }}>{kpis.repeatCustomers || 0}</div>
                  <div style={{ fontSize: 11, color: COLORS.successDark, fontWeight: 600, marginTop: 2 }}>Repeat customers</div>
                </div>
              </div>
              {kpis.totalCustomers > 0 && (
                <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", height: 8 }}>
                  <div style={{ width: `${(kpis.newCustomers / kpis.totalCustomers) * 100}%`, background: BRAND.accent }} />
                  <div style={{ flex: 1, background: COLORS.success }} />
                </div>
              )}
            </div>

            {/* Top 5 Concentration */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Top 5 concentration
                </div>
                <Pill
                  color={kpis.topCustomerShare > 60 ? COLORS.dangerDark : kpis.topCustomerShare > 40 ? COLORS.warningDark : COLORS.successDark}
                  bg={kpis.topCustomerShare > 60 ? COLORS.dangerBg : kpis.topCustomerShare > 40 ? COLORS.warningBg : COLORS.successBg}
                  size="sm"
                >
                  {kpis.topCustomerShare}% of revenue
                </Pill>
              </div>
              {topCustomers.map((c, i) => {
                const totalRev = topCustomers.reduce((s, x) => s + x.revenue, 0);
                const share = totalRev > 0 ? (c.revenue / totalRev) * 100 : 0;
                return (
                  <div key={c.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: i < 4 ? `1px solid ${COLORS.borderFaint}` : "none" }}>
                    <Avatar name={c.name} size={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.text, whiteSpace: "nowrap" }}>{fmt(c.revenue)}</div>
                    <div style={{ fontSize: 10, color: COLORS.textFaint, width: 32, textAlign: "right" }}>{share.toFixed(0)}%</div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </div>

      {/* ── ROW 2: AGENT PERFORMANCE + PRODUCTS ────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        {/* Agent Performance */}
        <Card title="Agent Performance" subtitle={`Revenue by sales agent · ${range.label}`}>
          <SortableTable
            rows={agents}
            rowKey={(r) => r.name}
            defaultSort={{ key: "revenue", dir: "desc" }}
            columns={[
              {
                key: "name",
                label: "Agent",
                render: (r) => (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={r.name} size={30} />
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: r.name === "Unassigned" ? COLORS.danger : COLORS.text }}>
                        {r.name}
                      </span>
                      {r.name === "Unassigned" && (
                        <div style={{ fontSize: 10, color: COLORS.danger, fontWeight: 600 }}>needs assignment</div>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: "orders",
                label: "Orders",
                align: "right",
                render: (r) => fmt0(r.orders || 0),
              },
              {
                key: "avgOrder",
                label: "Avg Order",
                align: "right",
                sortValue: (r) => r.orders > 0 ? r.revenue / r.orders : 0,
                render: (r) => (
                  <span style={{ fontSize: 12, color: COLORS.textMuted }}>
                    {r.orders > 0 ? fmt(r.revenue / r.orders) : "—"}
                  </span>
                ),
              },
              {
                key: "revenue",
                label: "Revenue",
                align: "right",
                render: (r) => (
                  <span style={{ fontWeight: 700, color: COLORS.text }}>{fmt(r.revenue || 0)}</span>
                ),
              },
            ]}
            emptyMessage="No agent data available."
          />
        </Card>

        {/* Top Products with Margins */}
        <Card title="Top Products" subtitle={`Revenue & margin · ${range.label}`}>
          <SortableTable
            rows={products.slice(0, 12)}
            rowKey={(r) => r.code || r.name}
            defaultSort={{ key: "revenue", dir: "desc" }}
            columns={[
              {
                key: "name",
                label: "Product",
                render: (r) => (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{r.name}</div>
                    {r.code && <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 2, fontFamily: FONT.mono }}>{r.code}</div>}
                  </div>
                ),
              },
              {
                key: "qty",
                label: "Qty",
                align: "right",
                render: (r) => fmt0(r.qty || 0),
              },
              {
                key: "revenue",
                label: "Revenue",
                align: "right",
                render: (r) => (
                  <span style={{ fontWeight: 700, color: COLORS.text }}>{fmt(r.revenue || 0)}</span>
                ),
              },
              {
                key: "marginPct",
                label: "Margin",
                align: "right",
                sortValue: (r) => r.marginPct ?? -1,
                render: (r) => {
                  if (r.marginPct == null) return <span style={{ fontSize: 11, color: COLORS.textFaint }}>—</span>;
                  const color = r.marginPct >= 40 ? COLORS.successDark : r.marginPct >= 20 ? COLORS.warningDark : COLORS.dangerDark;
                  const bg = r.marginPct >= 40 ? COLORS.successBg : r.marginPct >= 20 ? COLORS.warningBg : COLORS.dangerBg;
                  return (
                    <div style={{ textAlign: "right" }}>
                      <Pill color={color} bg={bg} size="sm">{r.marginPct}%</Pill>
                      <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 3 }}>{fmt(r.marginValue)}</div>
                    </div>
                  );
                },
              },
            ]}
            emptyMessage="No product data available."
          />
        </Card>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{ padding: 60, textAlign: "center" }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", animation: "pulse 2s infinite" }}>
        <Ic name="chart" size={22} color={BRAND.accent} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textMuted }}>Loading analytics…</div>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div style={{ padding: "12px 16px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}33`, fontSize: 12, color: COLORS.dangerDark, marginBottom: 20, display: "flex", alignItems: "center", gap: 8 }}>
      <Ic name="alert" size={14} color={COLORS.dangerDark} />{message}
    </div>
  );
}
