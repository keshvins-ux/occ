import { useState, useRef, useEffect } from "react";
import Ic from "./Ic";
import { BRAND, COLORS, RADIUS, SHADOWS } from "../theme";
import { useDateRange, DATE_PRESETS } from "../contexts/DateRangeContext";

export default function DateRangePicker() {
  const { range, setRange } = useDateRange();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          padding: "8px 14px",
          borderRadius: RADIUS.md,
          border: `1px solid ${COLORS.borderStrong}`,
          fontSize: 12,
          color: COLORS.textSecondary,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontWeight: 600,
          background: COLORS.surfaceAlt,
          cursor: "pointer",
          transition: "all 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = BRAND.accentGlow;
          e.currentTarget.style.borderColor = "rgba(79, 124, 247, 0.4)";
          e.currentTarget.style.color = BRAND.accent;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = COLORS.surfaceAlt;
          e.currentTarget.style.borderColor = COLORS.borderStrong;
          e.currentTarget.style.color = COLORS.textSecondary;
        }}
      >
        <Ic name="calendar" size={14} color="currentColor" />
        <span>Last {range.label}</span>
        <Ic name="chevronDown" size={12} color="currentColor" />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            background: COLORS.surface,
            borderRadius: RADIUS.lg,
            boxShadow: SHADOWS.dropdown,
            border: `1px solid ${COLORS.borderStrong}`,
            padding: 6,
            zIndex: 50,
            minWidth: 160,
          }}
        >
          {DATE_PRESETS.map((p) => (
            <button
              key={p.days}
              onClick={() => {
                setRange(p);
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "9px 14px",
                fontSize: 12,
                color: range.days === p.days ? BRAND.accent : COLORS.textSecondary,
                background: range.days === p.days ? BRAND.accentGlow : "transparent",
                border: "none",
                borderRadius: RADIUS.sm,
                cursor: "pointer",
                textAlign: "left",
                fontWeight: range.days === p.days ? 600 : 500,
                transition: "all 0.12s",
              }}
              onMouseEnter={(e) => {
                if (range.days !== p.days) e.currentTarget.style.background = COLORS.surfaceAlt;
              }}
              onMouseLeave={(e) => {
                if (range.days !== p.days) e.currentTarget.style.background = "transparent";
              }}
            >
              Last {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
