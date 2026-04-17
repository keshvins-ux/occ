import { useState, useEffect } from "react";
import Card from "../components/Card";
import Avatar from "../components/Avatar";
import WhatChanged from "../components/WhatChanged";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fetchJson } from "../utils";

const STAGES = [
  { id: "cold", label: "Cold", color: COLORS.neutral, bg: COLORS.neutralBg },
  { id: "warm", label: "Warm", color: COLORS.warningDark, bg: COLORS.warningBg },
  { id: "hot", label: "Hot", color: COLORS.dangerDark, bg: COLORS.dangerBg },
  { id: "won", label: "Won", color: COLORS.successDark, bg: COLORS.successBg },
  { id: "lost", label: "Lost", color: COLORS.neutral, bg: COLORS.neutralBg },
];

export default function SalesPipeline() {
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJson("/api/prospects?type=pipeline")
      .then((resp) => !cancelled && setProspects(resp?.prospects || []))
      .catch((err) => !cancelled && setError(err.message || "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const byStage = STAGES.reduce((acc, s) => {
    acc[s.id] = prospects.filter((p) => (p.stage || "").toLowerCase() === s.id);
    return acc;
  }, {});

  return (
    <div>
      <WhatChanged
        items={[
          {
            text: "Total prospects",
            value: String(prospects.length),
            color: BRAND.accent,
          },
          {
            text: "Hot leads",
            value: String((byStage.hot || []).length),
            color: COLORS.dangerDark,
          },
          {
            text: "Won",
            value: String((byStage.won || []).length),
            color: COLORS.success,
          },
        ]}
      />

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <Card>
          <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
            Loading pipeline…
          </div>
        </Card>
      ) : (
        <div style={{ display: "flex", gap: 18 }}>
          {STAGES.slice(0, 4).map((s) => {
            const items = byStage[s.id] || [];
            return (
              <div key={s.id} style={{ flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 14,
                    padding: "0 4px",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 700, color: s.color }}>
                    {s.label}
                  </span>
                  <span
                    style={{
                      minWidth: 26,
                      height: 26,
                      padding: "0 8px",
                      borderRadius: 8,
                      background: s.bg,
                      color: s.color,
                      fontSize: 12,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: `0 0 0 1px ${s.color}22`,
                    }}
                  >
                    {items.length}
                  </span>
                </div>
                {items.length === 0 ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: COLORS.textFaint,
                      padding: "20px 12px",
                      textAlign: "center",
                      background: COLORS.surfaceAlt,
                      borderRadius: RADIUS.lg,
                      border: `1px dashed ${COLORS.borderStrong}`,
                    }}
                  >
                    No {s.label.toLowerCase()} prospects
                  </div>
                ) : (
                  items.slice(0, 6).map((p) => (
                    <div
                      key={p.id || p.name}
                      style={{
                        background: COLORS.surface,
                        borderRadius: RADIUS.xl,
                        padding: "14px 16px",
                        marginBottom: 10,
                        boxShadow: SHADOWS.card,
                        borderLeft: `3px solid ${s.color}`,
                        cursor: "pointer",
                        transition: "transform 0.15s, box-shadow 0.15s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = "translateY(-1px)";
                        e.currentTarget.style.boxShadow = SHADOWS.cardHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = "translateY(0)";
                        e.currentTarget.style.boxShadow = SHADOWS.card;
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <Avatar name={p.name} size={28} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
                            {p.name}
                          </div>
                          {p.industry && (
                            <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 1 }}>
                              {p.industry}
                            </div>
                          )}
                        </div>
                      </div>
                      {p.value > 0 && (
                        <div
                          style={{
                            fontSize: 11,
                            color: s.color,
                            fontWeight: 700,
                            marginTop: 6,
                          }}
                        >
                          {fmt(p.value)}
                        </div>
                      )}
                      {p.agent && (
                        <div
                          style={{
                            fontSize: 10,
                            color: COLORS.textFaint,
                            marginTop: 4,
                          }}
                        >
                          Owner: {p.agent}
                        </div>
                      )}
                    </div>
                  ))
                )}
                {items.length > 6 && (
                  <div
                    style={{
                      textAlign: "center",
                      fontSize: 11,
                      color: COLORS.textFaint,
                      padding: 8,
                    }}
                  >
                    + {items.length - 6} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
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
