import { COLORS, RADIUS, SHADOWS } from "../theme";

export default function Card({
  children,
  title,
  subtitle,
  action,
  style = {},
  contentStyle = {},
  accent = false, // highlights with brand border + subtle bg tint
}) {
  return (
    <div
      style={{
        background: COLORS.surface,
        borderRadius: RADIUS.xxl,
        boxShadow: SHADOWS.card,
        border: accent ? "1.5px solid rgba(79, 124, 247, 0.3)" : `1px solid ${COLORS.border}`,
        overflow: "hidden",
        ...style,
      }}
    >
      {(title || action) && (
        <div
          style={{
            padding: "20px 24px 18px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: `1px solid ${COLORS.borderFaint}`,
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            {title && (
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: COLORS.text,
                  letterSpacing: "-0.015em",
                }}
              >
                {title}
              </div>
            )}
            {subtitle && (
              <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 2 }}>
                {subtitle}
              </div>
            )}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      <div style={contentStyle}>{children}</div>
    </div>
  );
}
