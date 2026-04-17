import Ic from "./Ic";
import { BRAND, COLORS, RADIUS } from "../theme";

/**
 * Period-delta widget. Items shape: { text, value, color, icon? }
 * Renders as a single horizontal strip with brand-accent gradient background.
 */
export default function WhatChanged({ items = [], label = "What changed" }) {
  if (!items.length) return null;
  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${BRAND.accentGlow} 0%, rgba(99, 102, 241, 0.08) 100%)`,
        borderRadius: RADIUS.xl,
        padding: "14px 20px",
        marginBottom: 24,
        border: `1px solid rgba(79, 124, 247, 0.2)`,
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          fontWeight: 700,
          color: BRAND.accent,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          whiteSpace: "nowrap",
        }}
      >
        <Ic name="sparkle" size={14} color={BRAND.accent} />
        {label}
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", flex: 1 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{ width: 6, height: 6, borderRadius: "50%", background: it.color || BRAND.accent }}
            />
            <span style={{ fontSize: 12, color: COLORS.text, fontWeight: 500 }}>{it.text}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: it.color || BRAND.accent }}>
              {it.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
