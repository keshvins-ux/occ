import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import Avatar from "../components/Avatar";
import SortableTable from "../components/SortableTable";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmtD, fetchJson } from "../utils";
import { useDateRange } from "../contexts/DateRangeContext";

export default function ManagementSOLifecycle() {
  const { range } = useDateRange();
  const [sos, setSOs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson(`/api/prospects?type=so_lifecycle&days=${range.days}`)
      .then((resp) => !cancelled && setSOs(resp?.sos || []))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.days]);

  const filtered = useMemo(() => {
    let arr = sos;
    if (filter !== "all") {
      arr = arr.filter((s) => (s.status || "").toLowerCase() === filter);
    }
    if (query) {
      const q = query.toLowerCase();
      arr = arr.filter(
        (s) =>
          (s.docno || "").toLowerCase().includes(q) ||
          (s.customer || "").toLowerCase().includes(q)
      );
    }
    return arr;
  }, [sos, filter, query]);

  const counts = {
    all: sos.length,
    active: sos.filter((s) => (s.status || "").toLowerCase() === "active").length,
    partial: sos.filter((s) => (s.status || "").toLowerCase() === "partial").length,
    complete: sos.filter((s) => (s.status || "").toLowerCase() === "complete").length,
  };

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <Card
        title="Sales Order Lifecycle"
        subtitle={`${sos.length} orders in the last ${range.label}`}
        action={
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 2, background: COLORS.borderFaint, borderRadius: RADIUS.md, padding: 3 }}>
              {[
                ["all", "All"],
                ["active", `Active ${counts.active ? `(${counts.active})` : ""}`],
                ["partial", `Partial ${counts.partial ? `(${counts.partial})` : ""}`],
                ["complete", `Complete ${counts.complete ? `(${counts.complete})` : ""}`],
              ].map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  style={{
                    padding: "7px 14px",
                    borderRadius: RADIUS.sm,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    background: filter === k ? COLORS.text : "transparent",
                    color: filter === k ? "#fff" : COLORS.textFaint,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
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
          </div>
        }
      >
        {loading ? (
          <Loading />
        ) : (
          <SortableTable
            rows={filtered}
            rowKey={(r) => r.docno}
            defaultSort={{ key: "date", dir: "desc" }}
            columns={[
              {
                key: "docno",
                label: "SO Number",
                render: (r) => (
                  <span
                    style={{ fontFamily: FONT.mono, fontWeight: 700, color: "#1E3A5F", fontSize: 13 }}
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
                key: "deliveryDate",
                label: "Delivery",
                render: (r) => {
                  if (!r.deliveryDate) return <span style={{ color: COLORS.textFaint }}>—</span>;
                  const days = Math.ceil(
                    (new Date(r.deliveryDate).getTime() - Date.now()) / 86400000
                  );
                  const overdue = days < 0;
                  const urgent = days <= 3 && days >= 0;
                  return (
                    <div>
                      <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
                        {fmtD(r.deliveryDate)}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: overdue
                            ? COLORS.dangerDark
                            : urgent
                            ? COLORS.warningDark
                            : COLORS.textFaint,
                          fontWeight: 600,
                          marginTop: 2,
                        }}
                      >
                        {overdue ? `${Math.abs(days)}d overdue` : `${days}d left`}
                      </div>
                    </div>
                  );
                },
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
                render: (r) => <StatusPill status={r.status} />,
              },
            ]}
            emptyMessage={query ? `No orders match "${query}"` : "No orders in this period."}
          />
        )}
      </Card>
    </div>
  );
}

function StatusPill({ status }) {
  const s = String(status || "").toLowerCase();
  if (s === "complete")
    return (
      <Pill color={COLORS.successDark} bg={COLORS.successBg} dot>
        Complete
      </Pill>
    );
  if (s === "partial")
    return (
      <Pill color={COLORS.warningDark} bg={COLORS.warningBg} dot>
        Partial
      </Pill>
    );
  if (s === "cancelled")
    return (
      <Pill color={COLORS.neutral} bg={COLORS.neutralBg}>
        Cancelled
      </Pill>
    );
  return (
    <Pill color={COLORS.info} bg={COLORS.infoBg} dot>
      Active
    </Pill>
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
