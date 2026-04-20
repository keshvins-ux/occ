import { useState, useEffect } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Avatar from "../components/Avatar";
import SortableTable from "../components/SortableTable";
import WhatChanged from "../components/WhatChanged";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fetchJson, dateQs } from "../utils";
import { useDateRange } from "../contexts/DateRangeContext";

export default function ManagementAROverview() {
  const { range } = useDateRange();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson(`/api/prospects?type=ar_overview${dateQs(range)}`)
      .then((resp) => !cancelled && setData(resp))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.days]);

  const kpis = data?.kpis || {};
  const aging = data?.aging || [];
  const overdue = data?.overdue || [];
  const whatChanged = data?.whatChanged || [];

  return (
    <div>
      {whatChanged.length > 0 && <WhatChanged items={whatChanged} />}

      {error && <ErrorBanner message={error} />}

      <div style={{ display: "flex", gap: 18, marginBottom: 28, flexWrap: "wrap" }}>
        <KpiCard
          icon="monitor"
          iconBg={COLORS.dangerBg}
          iconColor={COLORS.danger}
          label="Total AR"
          value={loading ? "" : fmt(kpis.totalAR || 0)}
          loading={loading}
        />
        <KpiCard
          icon="chart"
          iconBg="#FFF7ED"
          iconColor={COLORS.warningDark}
          label="Overdue"
          value={loading ? "" : fmt(kpis.overdue || 0)}
          trend={kpis.overdueCount ? `${kpis.overdueCount} invoices` : undefined}
          trendDirection="neutral"
          loading={loading}
        />
        <KpiCard
          icon="trending"
          iconBg={COLORS.successBg}
          iconColor={COLORS.success}
          label={`Collected (${range.label})`}
          value={loading ? "" : fmt(kpis.collected || 0)}
          trend={kpis.collectedTrend}
          loading={loading}
        />
        <KpiCard
          icon="package"
          iconBg="#EEF2FF"
          iconColor="#4F46E5"
          label="Active SOs"
          value={loading ? "" : fmt0(kpis.activeSOs || 0)}
          loading={loading}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card title="Invoice Aging" subtitle="Outstanding by aging bucket">
          {loading ? (
            <Loading />
          ) : (
            <AgingChart buckets={aging} />
          )}
        </Card>

        <Card title="Top Overdue Accounts" subtitle="Immediate attention required">
          {loading ? (
            <Loading />
          ) : (
            <SortableTable
              rows={overdue}
              rowKey={(r) => r.customer || r.name}
              defaultSort={{ key: "days", dir: "desc" }}
              columns={[
                {
                  key: "customer",
                  label: "Customer",
                  render: (r) => (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Avatar name={r.customer || r.name} size={30} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                        {r.customer || r.name}
                      </span>
                    </div>
                  ),
                },
                {
                  key: "days",
                  label: "Days",
                  render: (r) => (
                    <span
                      style={{
                        fontSize: 12,
                        color: r.days > 90 ? COLORS.dangerDark : COLORS.warningDark,
                        fontWeight: 600,
                      }}
                    >
                      {r.days}d
                    </span>
                  ),
                },
                {
                  key: "amount",
                  label: "Amount",
                  align: "right",
                  render: (r) => (
                    <span style={{ fontWeight: 700, color: COLORS.dangerDark }}>
                      {fmt(r.amount)}
                    </span>
                  ),
                },
              ]}
              emptyMessage="No overdue accounts — nice job."
            />
          )}
        </Card>
      </div>
    </div>
  );
}

function AgingChart({ buckets }) {
  if (!buckets || buckets.length === 0) {
    return <Loading />;
  }
  const total = buckets.reduce((s, b) => s + (b.amount || 0), 0);
  const pcts = buckets.map((b) => ({ ...b, pct: total > 0 ? (b.amount / total) * 100 : 0 }));
  const colors = {
    current: COLORS.success,
    "1-30d": COLORS.info,
    "31-60d": COLORS.warningDark,
    "61-90d": "#F97316",
    "90d+": COLORS.danger,
  };
  return (
    <div style={{ padding: "20px 24px 24px" }}>
      <div
        style={{
          display: "flex",
          borderRadius: 10,
          overflow: "hidden",
          height: 14,
          marginBottom: 20,
          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.06)",
        }}
      >
        {pcts.map((b) => {
          const c = colors[b.label.toLowerCase()] || COLORS.neutral;
          return (
            <div
              key={b.label}
              style={{
                width: `${b.pct}%`,
                background: `linear-gradient(180deg, ${c}CC, ${c})`,
              }}
              title={`${b.label}: ${fmt(b.amount)}`}
            />
          );
        })}
      </div>
      {pcts.map((b) => {
        const c = colors[b.label.toLowerCase()] || COLORS.neutral;
        return (
          <div
            key={b.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "9px 0",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: c,
                  boxShadow: `0 0 8px ${c}44`,
                }}
              />
              <span style={{ fontSize: 13, color: COLORS.textSecondary, fontWeight: 500 }}>
                {b.label}
              </span>
            </div>
            <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: COLORS.textFaint, width: 50, textAlign: "right" }}>
                {b.pct.toFixed(0)}%
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: COLORS.text,
                  width: 120,
                  textAlign: "right",
                }}
              >
                {fmt(b.amount)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Loading() {
  return (
    <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
      Loading…
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
