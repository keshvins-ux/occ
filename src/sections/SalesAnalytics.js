import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Avatar from "../components/Avatar";
import SortableTable from "../components/SortableTable";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fetchJson } from "../utils";
import { useDateRange } from "../contexts/DateRangeContext";

export default function SalesAnalytics() {
  const { range } = useDateRange();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson(`/api/prospects?type=analytics&days=${range.days}`)
      .then((resp) => !cancelled && setData(resp))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.days]);

  const agents = data?.agents || [];
  const products = data?.products || [];
  const kpis = data?.kpis || {};

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <div style={{ display: "flex", gap: 18, marginBottom: 28, flexWrap: "wrap" }}>
        <KpiCard
          icon="trending"
          iconBg={COLORS.infoBg}
          iconColor={COLORS.info}
          label={`Growth (${range.label})`}
          value={loading ? "" : kpis.growth || "—"}
          trend={kpis.growthTrend}
          loading={loading}
        />
        <KpiCard
          icon="user"
          iconBg={BRAND.accentGlow}
          iconColor={BRAND.accent}
          label="Active agents"
          value={loading ? "" : fmt0(agents.length)}
          loading={loading}
        />
        <KpiCard
          icon="package"
          iconBg={COLORS.successBg}
          iconColor={COLORS.success}
          label="Top product revenue"
          value={loading ? "" : fmt(products[0]?.revenue || 0)}
          loading={loading}
        />
        <KpiCard
          icon="monitor"
          iconBg="#FFF7ED"
          iconColor={COLORS.warningDark}
          label="Customer concentration"
          value={loading ? "" : `${kpis.topCustomerShare || 0}%`}
          trend={kpis.topCustomerShare ? "Top 5 customers" : undefined}
          trendDirection="neutral"
          loading={loading}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card title="Agent Performance" subtitle={`Revenue by sales agent · Last ${range.label}`}>
          {loading ? (
            <Loading />
          ) : (
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
                      <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                        {r.name}
                      </span>
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
          )}
        </Card>

        <Card title="Top Products" subtitle={`By revenue · Last ${range.label}`}>
          {loading ? (
            <Loading />
          ) : (
            <SortableTable
              rows={products.slice(0, 10)}
              rowKey={(r) => r.code || r.name}
              defaultSort={{ key: "revenue", dir: "desc" }}
              columns={[
                {
                  key: "name",
                  label: "Product",
                  render: (r) => (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                        {r.name}
                      </div>
                      {r.code && (
                        <div
                          style={{
                            fontSize: 11,
                            color: COLORS.textFaint,
                            marginTop: 2,
                            fontFamily: FONT.mono,
                          }}
                        >
                          {r.code}
                        </div>
                      )}
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
              ]}
              emptyMessage="No product data available."
            />
          )}
        </Card>
      </div>
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
