import { useState, useEffect, useMemo } from "react";
import Ic from "../components/Ic";
import KpiCard from "../components/KpiCard";
import Card from "../components/Card";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import SortableTable from "../components/SortableTable";
import WhatChanged from "../components/WhatChanged";
import ComparisonPanel from "./ComparisonPanel";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";
import { useDateRange } from "../contexts/DateRangeContext";

export default function SalesOverview() {
  const { range } = useDateRange();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [compareOpen, setCompareOpen] = useState(false);
  const [productsData, setProductsData] = useState(null);
  const [productsLoading, setProductsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchJson(`/api/prospects?type=overview&days=${range.days}`)
      .then((resp) => !cancelled && setData(resp))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));

    setProductsLoading(true);
    fetchJson(`/api/prospects?type=top_products&days=${range.days}`)
      .then((resp) => !cancelled && setProductsData(resp))
      .catch(() => {})
      .finally(() => !cancelled && setProductsLoading(false));

    return () => { cancelled = true; };
  }, [range.days]);

  const kpis = data?.kpis || {};
  const trend = data?.trend || [];
  const topCustomers = data?.topCustomers || [];
  const recentSOs = data?.recentSOs || [];
  const whatChanged = data?.whatChanged || [];
  const comparison = data?.comparison || {};

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      {whatChanged.length > 0 && <WhatChanged items={whatChanged} />}

      <div style={{ display: "flex", gap: 18, marginBottom: 28, flexWrap: "wrap" }}>
        <KpiCard
          icon="chart"
          iconBg={COLORS.infoBg}
          iconColor={COLORS.info}
          label={`Invoiced (${range.label})`}
          value={loading ? "" : fmt(kpis.invoiced || 0)}
          trend={kpis.invoicedTrend}
          loading={loading}
        />
        <KpiCard
          icon="trending"
          iconBg={COLORS.successBg}
          iconColor={COLORS.success}
          label="Collected"
          value={loading ? "" : fmt(kpis.collected || 0)}
          trend={kpis.collectedTrend}
          loading={loading}
        />
        <KpiCard
          icon="monitor"
          iconBg={COLORS.dangerBg}
          iconColor={COLORS.danger}
          label="AR Outstanding"
          value={loading ? "" : fmt(kpis.arOutstanding || 0)}
          trend={kpis.arTrend}
          loading={loading}
        />
        <KpiCard
          icon="sparkle"
          iconBg={BRAND.accentGlow}
          iconColor={BRAND.accent}
          label="Comparison"
          badge="MoM"
          value={
            loading
              ? ""
              : `${comparison.delta >= 0 ? "+" : ""}${fmt(comparison.delta || 0)}`
          }
          trend={compareOpen ? "Hide details" : `${comparison.deltaPct || ""} · click for detail`}
          trendDirection={compareOpen ? "neutral" : comparison.delta >= 0 ? "up" : "down"}
          onClick={() => setCompareOpen(!compareOpen)}
          active={compareOpen}
          loading={loading}
        />
      </div>

      {compareOpen && <ComparisonPanel onClose={() => setCompareOpen(false)} />}

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20, marginBottom: 20 }}>
        <Card
          title="Revenue Trend"
          subtitle={`Monthly totals · ${range.label}`}
          action={
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <Legend color="linear-gradient(180deg, #60A5FA, #2563EB)" label="Invoiced" />
              <Legend color="linear-gradient(180deg, #34D399, #059669)" label="Collected" />
            </div>
          }
        >
          <TrendChart data={trend} loading={loading} />
        </Card>
        <Card
          title="Top Customers"
          subtitle={`By revenue · ${range.label}`}
          action={
            <span style={{ fontSize: 12, color: BRAND.accent, cursor: "pointer", fontWeight: 600 }}>
              View all →
            </span>
          }
        >
          <TopCustomersList items={topCustomers} loading={loading} />
        </Card>
      </div>

      {/* Top Products with GP */}
      <div style={{ marginBottom: 20 }}>
        <Card
          title="Top Products"
          subtitle={productsData?.note || `Revenue & margin · ${range.label}`}
          action={
            productsData?.totals ? (
              <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Total Revenue</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.text }}>{fmt(productsData.totals.revenue)}</div>
                </div>
                {productsData.totals.cost != null && (
                  <>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Total Cost</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.danger }}>{fmt(productsData.totals.cost)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Gross Profit</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.success }}>{fmt(productsData.totals.gp)} ({productsData.totals.gpPct}%)</div>
                    </div>
                  </>
                )}
              </div>
            ) : null
          }
        >
          {productsLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>Loading…</div>
          ) : !productsData?.products?.length ? (
            <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>No product data in this period.</div>
          ) : (
            <SortableTable
              rows={productsData.products}
              rowKey={(r) => r.code}
              defaultSort={{ key: "revenue", dir: "desc" }}
              columns={[
                {
                  key: "name",
                  label: "Product",
                  render: (r) => (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 2, fontFamily: FONT.mono }}>{r.code}</div>
                    </div>
                  ),
                },
                {
                  key: "qtySold",
                  label: "Qty Sold",
                  align: "right",
                  render: (r) => <span style={{ fontWeight: 500 }}>{fmt0(r.qtySold)} {r.uom || ""}</span>,
                },
                {
                  key: "revenue",
                  label: "Revenue",
                  align: "right",
                  render: (r) => <span style={{ fontWeight: 700, color: COLORS.text }}>{fmt(r.revenue)}</span>,
                },
                {
                  key: "totalCost",
                  label: "Cost",
                  align: "right",
                  render: (r) => r.totalCost != null
                    ? <span style={{ fontWeight: 600, color: COLORS.danger }}>{fmt(r.totalCost)}</span>
                    : <span style={{ fontSize: 11, color: COLORS.textFaint }}>No BOM</span>,
                },
                {
                  key: "gp",
                  label: "Gross Profit",
                  align: "right",
                  render: (r) => r.gp != null
                    ? <span style={{ fontWeight: 700, color: r.gp >= 0 ? COLORS.success : COLORS.danger }}>{fmt(r.gp)}</span>
                    : <span style={{ fontSize: 11, color: COLORS.textFaint }}>—</span>,
                },
                {
                  key: "gpPct",
                  label: "GP %",
                  align: "right",
                  render: (r) => r.gpPct != null
                    ? (
                      <Pill
                        color={Number(r.gpPct) >= 30 ? COLORS.successDark : Number(r.gpPct) >= 15 ? COLORS.warningDark : COLORS.dangerDark}
                        bg={Number(r.gpPct) >= 30 ? COLORS.successBg : Number(r.gpPct) >= 15 ? COLORS.warningBg : COLORS.dangerBg}
                      >
                        {r.gpPct}%
                      </Pill>
                    )
                    : <span style={{ fontSize: 11, color: COLORS.textFaint }}>—</span>,
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Card
        title="Recent Sales Orders"
        subtitle={`Latest activity · ${range.label}`}
      >
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
            Loading…
          </div>
        ) : (
          <SortableTable
            rows={recentSOs}
            rowKey={(r) => r.docno || r.dockey}
            defaultSort={{ key: "date", dir: "desc" }}
            columns={[
              {
                key: "docno",
                label: "SO Number",
                render: (r) => (
                  <span
                    style={{
                      fontFamily: FONT.mono,
                      fontWeight: 700,
                      color: "#1E3A5F",
                      fontSize: 13,
                    }}
                  >
                    {r.docno}
                  </span>
                ),
              },
              {
                key: "customer",
                label: "Customer",
                render: (r) => (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={r.customer} size={30} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                      {r.customer}
                    </span>
                  </div>
                ),
              },
              {
                key: "date",
                label: "Date",
                render: (r) => <span style={{ color: COLORS.textFaint }}>{fmtD(r.date)}</span>,
              },
              {
                key: "amount",
                label: "Amount",
                align: "right",
                render: (r) => (
                  <span style={{ fontWeight: 700, color: COLORS.text }}>{fmt(r.amount)}</span>
                ),
              },
              {
                key: "status",
                label: "Status",
                sortable: false,
                render: (r) => <StatusPill status={r.status} />,
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function StatusPill({ status }) {
  const s = String(status || "").toLowerCase();
  if (s === "complete" || s === "done")
    return (
      <Pill color={COLORS.successDark} bg={COLORS.successBg} dot>
        Complete
      </Pill>
    );
  if (s === "cancelled")
    return (
      <Pill color={COLORS.neutral} bg={COLORS.neutralBg}>
        Cancelled
      </Pill>
    );
  return (
    <Pill color={COLORS.warningDark} bg={COLORS.warningBg} dot>
      Pending
    </Pill>
  );
}

function Legend({ color, label }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: COLORS.textMuted,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
      {label}
    </span>
  );
}

function TrendChart({ data, loading }) {
  const maxV = useMemo(() => {
    if (!data || !data.length) return 1;
    return Math.max(...data.map((d) => Math.max(d.invoiced || 0, d.collected || 0)));
  }, [data]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
        Loading…
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
        Not enough data in this period.
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 28px 28px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 32, height: 170 }}>
        {data.map((m) => (
          <div key={m.label} style={{ flex: 1, textAlign: "center" }}>
            <div
              style={{
                display: "flex",
                gap: 6,
                justifyContent: "center",
                alignItems: "flex-end",
                height: 140,
              }}
            >
              <Bar value={m.invoiced || 0} max={maxV} color="inv" />
              <Bar value={m.collected || 0} max={maxV} color="col" />
            </div>
            <div
              style={{
                fontSize: 12,
                color: COLORS.textMuted,
                marginTop: 12,
                fontWeight: 600,
              }}
            >
              {m.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const bg =
    color === "inv"
      ? "linear-gradient(180deg, #60A5FA 0%, #2563EB 100%)"
      : "linear-gradient(180deg, #34D399 0%, #059669 100%)";
  const shadow =
    color === "inv"
      ? "0 3px 12px rgba(37, 99, 235, 0.2)"
      : "0 3px 12px rgba(5, 150, 105, 0.2)";
  return (
    <div
      style={{
        width: 32,
        background: bg,
        borderRadius: "8px 8px 4px 4px",
        height: `${pct}%`,
        minHeight: value > 0 ? 4 : 0,
        boxShadow: shadow,
      }}
      title={fmt(value)}
    />
  );
}

function TopCustomersList({ items, loading }) {
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
        Loading…
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
        No customer activity in this period.
      </div>
    );
  }
  return (
    <div style={{ padding: "8px 24px 16px" }}>
      {items.map((c, i) => (
        <div
          key={c.code || c.name}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 0",
            borderBottom: i < items.length - 1 ? `1px solid ${COLORS.borderGhost}` : "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Avatar name={c.name} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{c.name}</div>
              {c.code && (
                <div style={{ fontSize: 11, color: COLORS.textFaint, fontFamily: FONT.mono }}>
                  {c.code}
                </div>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt(c.revenue)}</div>
            {c.trend && (
              <div
                style={{
                  fontSize: 10,
                  color:
                    c.trend === "New"
                      ? BRAND.accent
                      : c.trend.startsWith("+")
                      ? COLORS.success
                      : COLORS.danger,
                  fontWeight: 600,
                  marginTop: 2,
                }}
              >
                {c.trend}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: RADIUS.lg,
        background: COLORS.dangerBg,
        border: `1px solid ${COLORS.danger}33`,
        fontSize: 12,
        color: COLORS.dangerDark,
        marginBottom: 20,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Ic name="alert" size={14} color={COLORS.dangerDark} />
      {message}
    </div>
  );
}
