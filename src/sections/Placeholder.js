import Ic from "../components/Ic";
import { BRAND, COLORS, SHADOWS } from "../theme";

export default function Placeholder({ title, description, icon = "sparkle", session = "Session 2" }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "100px 40px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          background: `linear-gradient(135deg, ${BRAND.accentGlow}, rgba(99, 102, 241, 0.1))`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 24,
          boxShadow: SHADOWS.glowHeavy,
        }}
      >
        <Ic name={icon} size={32} color={BRAND.accent} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.text, marginBottom: 10 }}>
        {title}
      </div>
      <div
        style={{
          fontSize: 13,
          color: COLORS.textMuted,
          maxWidth: 440,
          lineHeight: 1.7,
        }}
      >
        {description}
      </div>
      <div
        style={{
          marginTop: 28,
          padding: "12px 24px",
          borderRadius: 12,
          background: COLORS.surfaceAlt,
          border: `1px solid ${COLORS.borderStrong}`,
          fontSize: 12,
          color: COLORS.textMuted,
          fontWeight: 600,
        }}
      >
        Coming in {session}
      </div>
    </div>
  );
}
