import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import Avatar from "../components/Avatar";
import SortableTable from "../components/SortableTable";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";

export default function ManagementCustomers() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson("/api/prospects?type=customers")
      .then((resp) => !cancelled && setCustomers(resp?.customers || []))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!query) return customers;
    const q = query.toLowerCase();
    return customers.filter(
      (c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.code || "").toLowerCase().includes(q)
    );
  }, [customers, query]);

  const exportCsv = () => {
    const header = ["Customer Code", "Customer Name", "Total Invoiced", "Outstanding", "Last Payment"];
    const rows = filtered.map((c) => [
      c.code || "",
      c.name || "",
      c.totalInvoiced || 0,
      c.outstanding || 0,
      c.lastPayment || "",
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customers_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <Card
        title={`Customer AR Breakdown`}
        subtitle={`${customers.length} customers · sortable, searchable, exportable`}
        action={
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customer, code..."
              style={{
                padding: "9px 16px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.borderStrong}`,
                fontSize: 12,
                outline: "none",
                width: 260,
                color: COLORS.textSecondary,
                background: COLORS.surfaceAlt,
              }}
            />
            <button
              onClick={exportCsv}
              style={{
                padding: "8px 14px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.borderStrong}`,
                background: COLORS.surface,
                color: BRAND.accent,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Ic name="download" size={12} color={BRAND.accent} />
              Export CSV
            </button>
          </div>
        }
      >
        {loading ? (
          <Loading />
        ) : (
          <SortableTable
            rows={filtered}
            rowKey={(r) => r.code || r.name}
            defaultSort={{ key: "outstanding", dir: "desc" }}
            columns={[
              {
                key: "name",
                label: "Customer",
                render: (r) => (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={r.name} size={32} />
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
                  </div>
                ),
              },
              {
                key: "totalInvoiced",
                label: "Total Invoiced",
                align: "right",
                render: (r) => (
                  <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>
                    {fmt(r.totalInvoiced || 0)}
                  </span>
                ),
              },
              {
                key: "outstanding",
                label: "Outstanding",
                align: "right",
                render: (r) => (
                  <span
                    style={{
                      fontWeight: 700,
                      color: r.outstanding > 0 ? COLORS.dangerDark : COLORS.successDark,
                    }}
                  >
                    {fmt(r.outstanding || 0)}
                  </span>
                ),
              },
              {
                key: "lastPayment",
                label: "Last Payment",
                render: (r) => (
                  <span style={{ color: COLORS.textFaint, fontSize: 12 }}>
                    {r.lastPayment ? fmtD(r.lastPayment) : "—"}
                  </span>
                ),
              },
              {
                key: "status",
                label: "Status",
                sortable: false,
                render: (r) => {
                  if ((r.outstanding || 0) === 0) {
                    return (
                      <Pill color={COLORS.successDark} bg={COLORS.successBg} dot>
                        Paid up
                      </Pill>
                    );
                  }
                  if ((r.daysSincePayment || 0) > 60) {
                    return (
                      <Pill color={COLORS.dangerDark} bg={COLORS.dangerBg} dot>
                        Overdue
                      </Pill>
                    );
                  }
                  return (
                    <Pill color={COLORS.warningDark} bg={COLORS.warningBg} dot>
                      Open
                    </Pill>
                  );
                },
              },
            ]}
            emptyMessage={query ? `No customers match "${query}"` : "No customer data."}
          />
        )}
      </Card>
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
