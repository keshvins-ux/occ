import { useState, useEffect } from "react";
import Ic from "../components/Ic";
import Avatar from "../components/Avatar";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fetchJson } from "../utils";

export default function ComparisonPanel({ onClose }) {
  const [tab, setTab] = useState("customers");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchJson("/api/prospects?type=comparison")
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Failed to load comparison");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const items = tab === "customers" ? data?.customers || [] : data?.products || [];
  const totalLast = items.reduce((s, d) => s + (d.last || 0), 0);
  const totalCurr = items.reduce((s, d) => s + (d.curr || 0), 0);
  const delta = totalCurr - totalLast;
  const deltaPct = totalLast > 0 ? ((delta / totalLast) * 100).toFixed(1) : "—";
  const summary = {
    growing: items.filter((d) => d.type === "growing").length,
    declining: items.filter((d) => d.type === "declining").length,
    new: items.filter((d) => d.type === "new").length,
    churned: items.filter((d) => d.type === "churned").length,
  };

  return (
    <div
      style={{
        marginBottom: 20,
        background: COLORS.surface,
        borderRadius: RADIUS.xxl,
        boxShadow: SHADOWS.card,
        border: `1.5px solid rgba(79, 124, 247, 0.25)`,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "18px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${COLORS.borderFaint}`,
          background: `linear-gradient(90deg, rgba(79, 124, 247, 0.1) 0%, rgba(99, 102, 241, 0.05) 100%)`,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Ic name="sparkle" size={14} color={BRAND.accent} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: BRAND.accent,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Month vs Month Comparison
            </span>
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: COLORS.text,
              letterSpacing: "-0.015em",
            }}
          >
            {data?.title || "Loading comparison…"}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            width: 32,
            height: 32,
            borderRadius: RADIUS.md,
            background: COLORS.surface,
            border: `1px solid ${COLORS.borderStrong}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <Ic name="x" size={14} color={COLORS.textMuted} />
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
          Loading comparison…
        </div>
      ) : error ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: COLORS.dangerDark,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : (
        <>
          {/* Summary */}
          <div
            style={{
              padding: "18px 24px",
              display: "flex",
              gap: 20,
              flexWrap: "wrap",
              borderBottom: `1px solid ${COLORS.borderFaint}`,
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: COLORS.textFaint,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Previous month
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.textSecondary }}>
                {fmt(totalLast)}
              </div>
            </div>
            <div style={{ color: COLORS.textGhost, fontSize: 20 }}>→</div>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: COLORS.textFaint,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Current month
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>
                {fmt(totalCurr)}
              </div>
            </div>
            <div
              style={{
                marginLeft: 16,
                padding: "8px 14px",
                borderRadius: RADIUS.md,
                background: delta >= 0 ? COLORS.successBg : COLORS.dangerBg,
                border: `1px solid ${delta >= 0 ? "#A7F3D0" : "#FECACA"}`,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: delta >= 0 ? COLORS.successDark : COLORS.dangerDark,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  fontWeight: 700,
                  marginBottom: 2,
                }}
              >
                Change
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 800,
                  color: delta >= 0 ? COLORS.successDark : COLORS.dangerDark,
                }}
              >
                {delta >= 0 ? "+" : ""}
                {fmt(delta)} · {deltaPct}%
              </div>
            </div>
            <div
              style={{ display: "flex", gap: 12, marginLeft: "auto", flexWrap: "wrap" }}
            >
              <SummaryChip color={COLORS.success} label={`${summary.growing} growing`} />
              <SummaryChip color={COLORS.danger} label={`${summary.declining} declining`} />
              <SummaryChip color={BRAND.accent} label={`${summary.new} new`} />
              {summary.churned > 0 && (
                <SummaryChip color={COLORS.neutral} label={`${summary.churned} churned`} />
              )}
            </div>
          </div>

          {/* Tabs */}
          <div
            style={{
              padding: "14px 24px 0",
              display: "flex",
              gap: 4,
              borderBottom: `1px solid ${COLORS.borderFaint}`,
            }}
          >
            {[
              ["customers", "Customer Comparison"],
              ["products", "Product Comparison"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  padding: "10px 20px",
                  fontSize: 12,
                  fontWeight: 600,
                  color: tab === k ? BRAND.accent : COLORS.textFaint,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  borderBottom: tab === k ? `2px solid ${BRAND.accent}` : "2px solid transparent",
                  marginBottom: -1,
                  transition: "all 0.15s",
                }}
              >
                {l}
              </button>
            ))}
          </div>

          {/* Table */}
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead
                style={{ position: "sticky", top: 0, background: COLORS.surface, zIndex: 1 }}
              >
                <tr>
                  <TH>{tab === "customers" ? "Customer" : "Product"}</TH>
                  <TH align="right">Previous</TH>
                  <TH align="right">Current</TH>
                  <TH align="right">Change</TH>
                  <TH>Trend</TH>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        padding: "40px 20px",
                        textAlign: "center",
                        fontSize: 13,
                        color: COLORS.textFaint,
                      }}
                    >
                      No comparison data available yet.
                    </td>
                  </tr>
                )}
                {items.map((d, i) => (
                  <tr key={(d.name || d.code) + i} style={{ borderBottom: `1px solid ${COLORS.borderGhost}` }}>
                    <td style={{ padding: "14px 24px" }}>
                      {tab === "customers" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <Avatar name={d.name} size={32} />
                          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                            {d.name}
                          </span>
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                            {d.name}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: COLORS.textFaint,
                              marginTop: 2,
                              fontFamily: FONT.mono,
                            }}
                          >
                            {d.code}
                          </div>
                        </div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "14px 18px",
                        textAlign: "right",
                        fontSize: 13,
                        fontWeight: 500,
                        color: COLORS.textMuted,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {d.last === 0
                        ? "—"
                        : tab === "customers"
                        ? fmt(d.last)
                        : `${fmt0(d.last)} ${d.uom || ""}`}
                    </td>
                    <td
                      style={{
                        padding: "14px 18px",
                        textAlign: "right",
                        fontSize: 13,
                        fontWeight: 700,
                        color: COLORS.text,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {d.curr === 0
                        ? "—"
                        : tab === "customers"
                        ? fmt(d.curr)
                        : `${fmt0(d.curr)} ${d.uom || ""}`}
                    </td>
                    <td style={{ padding: "14px 18px", textAlign: "right" }}>
                      {formatDelta(d.last, d.curr, tab === "customers")}
                    </td>
                    <td style={{ padding: "14px 24px" }}>
                      <TypeBadge type={d.type} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              padding: "14px 24px",
              borderTop: `1px solid ${COLORS.borderFaint}`,
              background: COLORS.surfaceMuted,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 11, color: COLORS.textFaint }}>
              Source: sql_salesinvoices + sql_inv_lines · {data?.source_note || "current vs previous month"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TH({ children, align }) {
  return (
    <th
      style={{
        padding: "12px 24px",
        textAlign: align || "left",
        fontSize: 10,
        color: COLORS.textFaint,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        borderBottom: `1px solid ${COLORS.borderFaint}`,
      }}
    >
      {children}
    </th>
  );
}

function SummaryChip({ color, label }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color, fontWeight: 600 }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
      {label}
    </div>
  );
}

function TypeBadge({ type }) {
  const styles = {
    growing: { bg: COLORS.successBg, color: COLORS.successDark, label: "↑ Growing" },
    declining: { bg: COLORS.dangerBg, color: COLORS.dangerDark, label: "↓ Declining" },
    new: { bg: BRAND.accentGlow, color: BRAND.accent, label: "● New" },
    churned: { bg: COLORS.neutralBg, color: COLORS.neutral, label: "✕ Churned" },
  };
  const s = styles[type] || styles.growing;
  return (
    <span
      style={{
        padding: "3px 10px",
        borderRadius: RADIUS.pill,
        fontSize: 10.5,
        fontWeight: 600,
        background: s.bg,
        color: s.color,
      }}
    >
      {s.label}
    </span>
  );
}

function formatDelta(last, curr, isMoney = true) {
  if (last === 0)
    return <span style={{ color: BRAND.accent, fontWeight: 700, fontSize: 12 }}>NEW</span>;
  if (curr === 0)
    return (
      <span style={{ color: COLORS.neutral, fontWeight: 600, fontSize: 12 }}>Lost</span>
    );
  const d = curr - last;
  const pct = ((d / last) * 100).toFixed(1);
  const up = d > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: up ? COLORS.successDark : COLORS.dangerDark,
        }}
      >
        {up ? "+" : ""}
        {isMoney ? fmt(d) : fmt0(d)}
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: up ? COLORS.success : COLORS.danger,
          marginTop: 1,
        }}
      >
        {up ? "+" : ""}
        {pct}%
      </span>
    </div>
  );
}
