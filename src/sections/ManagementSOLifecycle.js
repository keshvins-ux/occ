import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Avatar from "../components/Avatar";
import SortableTable from "../components/SortableTable";
import Pill from "../components/Pill";
import WhatChanged from "../components/WhatChanged";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT, SHADOWS } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";
import { useDateRange } from "../contexts/DateRangeContext";

export default function ManagementSOLifecycle() {
  const { range } = useDateRange();
  const [sos, setSOs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeBucket, setActiveBucket] = useState(null); // null = no table, "2" | "5" | "10" | "15" | "all"
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson(`/api/prospects?type=so_lifecycle&days=${range.days}${range.fromDate ? `&from=${range.fromDate}` : ''}`)
      .then((resp) => !cancelled && setSOs(resp?.sos || []))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [range.days]);

  // Compute stats
  const stats = useMemo(() => {
    const active = sos.filter((s) => s.status === "active" || s.status === "partial");
    const complete = sos.filter((s) => s.status === "complete");
    const cancelled = sos.filter((s) => s.status === "cancelled");
    const totalActiveAmt = active.reduce((s, o) => s + (o.amount || 0), 0);

    // Aging buckets — days since SO date
    const withAge = active.map((s) => {
      const days = s.deliveryDate
        ? Math.ceil((new Date(s.deliveryDate).getTime() - Date.now()) / 86400000)
        : Math.ceil((Date.now() - new Date(s.date).getTime()) / 86400000);
      return { ...s, daysLeft: days };
    });

    const overdue = withAge.filter((s) => s.daysLeft < 0);
    const gt2 = withAge.filter((s) => s.daysLeft >= 0 && s.daysLeft <= 2);
    const gt5 = withAge.filter((s) => s.daysLeft > 2 && s.daysLeft <= 5);
    const gt10 = withAge.filter((s) => s.daysLeft > 5 && s.daysLeft <= 10);
    const gt15 = withAge.filter((s) => s.daysLeft > 10 && s.daysLeft <= 15);
    const beyond = withAge.filter((s) => s.daysLeft > 15);

    return {
      total: sos.length,
      active,
      activeCount: active.length,
      totalActiveAmt,
      complete: complete.length,
      cancelled: cancelled.length,
      withAge,
      overdue,
      gt2,
      gt5,
      gt10,
      gt15,
      beyond,
    };
  }, [sos]);

  // Get the table rows based on which bucket is clicked
  const tableRows = useMemo(() => {
    if (!activeBucket) return [];
    let rows = [];
    if (activeBucket === "overdue") rows = stats.overdue;
    else if (activeBucket === "2") rows = stats.gt2;
    else if (activeBucket === "5") rows = stats.gt5;
    else if (activeBucket === "10") rows = stats.gt10;
    else if (activeBucket === "15") rows = stats.gt15;
    else if (activeBucket === "beyond") rows = stats.beyond;
    else if (activeBucket === "all") rows = stats.withAge;

    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(
        (s) =>
          (s.docno || "").toLowerCase().includes(q) ||
          (s.customer || "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [activeBucket, stats, query]);

  const bucketLabel = {
    overdue: "Overdue SOs",
    "2": "Due within 2 days",
    "5": "Due in 3–5 days",
    "10": "Due in 6–10 days",
    "15": "Due in 11–15 days",
    beyond: "Due in 15+ days",
    all: "All Active SOs",
  };

  function toggleBucket(key) {
    setActiveBucket((prev) => (prev === key ? null : key));
    setQuery("");
  }

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 18, marginBottom: 28, flexWrap: "wrap" }}>
        <KpiCard
          icon="package"
          iconBg="#EEF2FF"
          iconColor="#4F46E5"
          label="Total Active SOs"
          value={loading ? "" : fmt0(stats.activeCount)}
          loading={loading}
          onClick={() => toggleBucket("all")}
          active={activeBucket === "all"}
        />
        <KpiCard
          icon="dollar"
          iconBg={COLORS.infoBg}
          iconColor={COLORS.info}
          label="Active SO Value"
          value={loading ? "" : fmt(stats.totalActiveAmt)}
          loading={loading}
        />
        <KpiCard
          icon="check"
          iconBg={COLORS.successBg}
          iconColor={COLORS.success}
          label="Completed"
          value={loading ? "" : fmt0(stats.complete)}
          loading={loading}
        />
        <KpiCard
          icon="chart"
          iconBg={COLORS.neutralBg}
          iconColor={COLORS.neutral}
          label="Total SOs"
          value={loading ? "" : fmt0(stats.total)}
          trend={`${range.label}`}
          trendDirection="neutral"
          loading={loading}
        />
      </div>

      {/* Aging Buckets — clickable cards */}
      <Card
        title="Active Pending SOs — Delivery Aging"
        subtitle="Click a bucket to view the orders in that window"
      >
        <div style={{ padding: "20px 24px 24px" }}>
          {loading ? (
            <div style={{ padding: 30, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
              Loading…
            </div>
          ) : (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <BucketCard
                label="Overdue"
                count={stats.overdue.length}
                amount={stats.overdue.reduce((s, o) => s + (o.amount || 0), 0)}
                color={COLORS.dangerDark}
                bg={COLORS.dangerBg}
                icon="alert"
                active={activeBucket === "overdue"}
                onClick={() => toggleBucket("overdue")}
              />
              <BucketCard
                label="≤ 2 days"
                count={stats.gt2.length}
                amount={stats.gt2.reduce((s, o) => s + (o.amount || 0), 0)}
                color="#EA580C"
                bg="#FFF7ED"
                icon="clock"
                active={activeBucket === "2"}
                onClick={() => toggleBucket("2")}
              />
              <BucketCard
                label="3–5 days"
                count={stats.gt5.length}
                amount={stats.gt5.reduce((s, o) => s + (o.amount || 0), 0)}
                color={COLORS.warningDark}
                bg={COLORS.warningBg}
                icon="clock"
                active={activeBucket === "5"}
                onClick={() => toggleBucket("5")}
              />
              <BucketCard
                label="6–10 days"
                count={stats.gt10.length}
                amount={stats.gt10.reduce((s, o) => s + (o.amount || 0), 0)}
                color={COLORS.info}
                bg={COLORS.infoBg}
                icon="clock"
                active={activeBucket === "10"}
                onClick={() => toggleBucket("10")}
              />
              <BucketCard
                label="11–15 days"
                count={stats.gt15.length}
                amount={stats.gt15.reduce((s, o) => s + (o.amount || 0), 0)}
                color="#4F46E5"
                bg="#EEF2FF"
                icon="clock"
                active={activeBucket === "15"}
                onClick={() => toggleBucket("15")}
              />
              <BucketCard
                label="15+ days"
                count={stats.beyond.length}
                amount={stats.beyond.reduce((s, o) => s + (o.amount || 0), 0)}
                color={COLORS.successDark}
                bg={COLORS.successBg}
                icon="check"
                active={activeBucket === "beyond"}
                onClick={() => toggleBucket("beyond")}
              />
            </div>
          )}
        </div>
      </Card>

      {/* Table — only shows when a bucket is clicked */}
      {activeBucket && (
        <div style={{ marginTop: 20 }}>
          <Card
            title={bucketLabel[activeBucket] || "Active SOs"}
            subtitle={`${tableRows.length} orders`}
            action={
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search SO, customer..."
                  style={{
                    padding: "9px 16px",
                    borderRadius: RADIUS.md,
                    border: `1px solid ${COLORS.borderStrong}`,
                    fontSize: 12,
                    outline: "none",
                    width: 220,
                    color: COLORS.textSecondary,
                    background: COLORS.surfaceAlt,
                  }}
                />
                <button
                  onClick={() => setActiveBucket(null)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: RADIUS.md,
                    border: `1px solid ${COLORS.borderStrong}`,
                    background: COLORS.surface,
                    color: COLORS.textMuted,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Ic name="x" size={12} color={COLORS.textMuted} />
                  Close
                </button>
              </div>
            }
          >
            <SortableTable
              rows={tableRows}
              rowKey={(r) => r.docno}
              defaultSort={{ key: "daysLeft", dir: "asc" }}
              columns={[
                {
                  key: "docno",
                  label: "SO Number",
                  render: (r) => (
                    <span style={{ fontFamily: FONT.mono, fontWeight: 700, color: "#1E3A5F", fontSize: 13 }}>
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
                  key: "deliveryDate",
                  label: "Delivery",
                  render: (r) => {
                    if (!r.deliveryDate) return <span style={{ color: COLORS.textFaint }}>—</span>;
                    const overdue = r.daysLeft < 0;
                    const urgent = r.daysLeft >= 0 && r.daysLeft <= 2;
                    return (
                      <div>
                        <div style={{ fontSize: 13, color: COLORS.textSecondary }}>{fmtD(r.deliveryDate)}</div>
                        <div
                          style={{
                            fontSize: 11,
                            color: overdue ? COLORS.dangerDark : urgent ? COLORS.warningDark : COLORS.textFaint,
                            fontWeight: 600,
                            marginTop: 2,
                          }}
                        >
                          {overdue ? `${Math.abs(r.daysLeft)}d overdue` : `${r.daysLeft}d left`}
                        </div>
                      </div>
                    );
                  },
                },
                {
                  key: "amount",
                  label: "Amount",
                  align: "right",
                  render: (r) => <span style={{ fontWeight: 700, color: COLORS.text }}>{fmt(r.amount)}</span>,
                },
                {
                  key: "status",
                  label: "Status",
                  render: (r) => <StatusPill status={r.status} />,
                },
              ]}
              emptyMessage={query ? `No orders match "${query}"` : "No orders in this bucket."}
            />
          </Card>
        </div>
      )}
    </div>
  );
}

function BucketCard({ label, count, amount, color, bg, icon, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 140,
        padding: "18px 20px",
        borderRadius: RADIUS.xxl,
        background: active ? color : COLORS.surface,
        border: active ? `2px solid ${color}` : `1px solid ${COLORS.border}`,
        cursor: "pointer",
        transition: "all 0.2s ease",
        boxShadow: active ? `0 4px 20px ${color}33` : SHADOWS.card,
        position: "relative",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.boxShadow = `0 4px 16px ${color}22`;
          e.currentTarget.style.borderColor = `${color}66`;
          e.currentTarget.style.transform = "translateY(-1px)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.boxShadow = SHADOWS.card;
          e.currentTarget.style.borderColor = COLORS.border;
          e.currentTarget.style.transform = "translateY(0)";
        }
      }}
    >
      <div style={{ position: "absolute", top: -20, right: -20, width: 70, height: 70, borderRadius: "50%", background: active ? "#fff" : color, opacity: active ? 0.15 : 0.06, filter: "blur(6px)" }} />
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: active ? "rgba(255,255,255,0.25)" : bg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ic name={icon} size={14} color={active ? "#fff" : color} />
          </div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: active ? "rgba(255,255,255,0.85)" : COLORS.textFaint,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {label}
          </span>
        </div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: active ? "#fff" : COLORS.text,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            marginBottom: 6,
          }}
        >
          {count}
        </div>
        <div
          style={{
            fontSize: 11,
            color: active ? "rgba(255,255,255,0.8)" : COLORS.textMuted,
            fontWeight: 500,
          }}
        >
          {fmt(amount)}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const s = String(status || "").toLowerCase();
  if (s === "complete") return <Pill color={COLORS.successDark} bg={COLORS.successBg} dot>Complete</Pill>;
  if (s === "partial") return <Pill color={COLORS.warningDark} bg={COLORS.warningBg} dot>Partial</Pill>;
  if (s === "cancelled") return <Pill color={COLORS.neutral} bg={COLORS.neutralBg}>Cancelled</Pill>;
  return <Pill color={COLORS.info} bg={COLORS.infoBg} dot>Active</Pill>;
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
