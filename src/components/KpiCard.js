import Ic from "./Ic";
import { COLORS, RADIUS, SHADOWS } from "../theme";

// A KPI card with a colored icon badge and optional trend indicator.
// If onClick is provided, card becomes interactive with hover/active states.
export default function KpiCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  trend,
  trendDirection, // "up" | "down" | "neutral" — overrides auto-detection
  onClick,
  active = false,
  badge, // small badge next to label (e.g. "MoM")
  loading = false,
}) {
  const up = trendDirection === "up" || (trendDirection == null && trend && trend.startsWith("+"));
  const down = trendDirection === "down" || (trendDirection == null && trend && trend.startsWith("-"));
  const trendColor = up ? COLORS.success : down ? COLORS.danger : COLORS.textMuted;
  const trendIcon = up ? "trending" : down ? "trendingDown" : "chart";

  const style = {
    flex: 1,
    minWidth: 175,
    background: active ? "linear-gradient(135deg, #4F7CF7 0%, #6366F1 100%)" : COLORS.surface,
    borderRadius: RADIUS.xxl,
    padding: "22px 24px",
    position: "relative",
    overflow: "hidden",
    boxShadow: active ? SHADOWS.glowHeavy : SHADOWS.card,
    border: active
      ? "1px solid #4F7CF7"
      : onClick
      ? "1px solid rgba(79, 124, 247, 0.25)"
      : `1px solid ${COLORS.border}`,
    cursor: onClick ? "pointer" : "default",
    transition: "all 0.2s ease",
  };

  const onEnter = (e) => {
    if (!onClick || active) return;
    e.currentTarget.style.boxShadow = "0 4px 20px rgba(79, 124, 247, 0.18)";
    e.currentTarget.style.transform = "translateY(-1px)";
  };
  const onLeave = (e) => {
    if (!onClick || active) return;
    e.currentTarget.style.boxShadow = SHADOWS.card;
    e.currentTarget.style.transform = "translateY(0)";
  };

  return (
    <div style={style} onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div
        style={{
          position: "absolute",
          top: -30,
          right: -30,
          width: 100,
          height: 100,
          borderRadius: "50%",
          background: active ? "#fff" : iconColor,
          opacity: active ? 0.1 : 0.04,
          filter: "blur(8px)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 16, position: "relative" }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            background: active ? "rgba(255,255,255,0.2)" : iconBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: active
              ? "inset 0 1px 0 rgba(255,255,255,0.3)"
              : `0 0 0 1px ${iconColor}15`,
          }}
        >
          <Ic name={icon} size={22} color={active ? "#fff" : iconColor} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: active ? "rgba(255,255,255,0.8)" : COLORS.textFaint,
              fontWeight: 500,
              marginBottom: 5,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {label}
            {badge && (
              <span
                style={{
                  fontSize: 9,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: active ? "rgba(255,255,255,0.2)" : "rgba(79, 124, 247, 0.18)",
                  color: active ? "#fff" : "#4F7CF7",
                  fontWeight: 700,
                  letterSpacing: "0.03em",
                }}
              >
                {badge}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: active ? "#fff" : COLORS.text,
              letterSpacing: "-0.025em",
              lineHeight: 1,
            }}
          >
            {loading ? (
              <span style={{ opacity: 0.4, fontSize: 14 }}>Loading…</span>
            ) : (
              value
            )}
          </div>
          {trend && !loading && (
            <div
              style={{
                fontSize: 11,
                color: active ? "rgba(255,255,255,0.9)" : trendColor,
                fontWeight: 600,
                marginTop: 5,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Ic name={trendIcon} size={12} color={active ? "#fff" : trendColor} />
              {trend}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
