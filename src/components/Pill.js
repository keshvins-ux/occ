import { RADIUS } from "../theme";

export default function Pill({ children, color, bg, dot = false, size = "md" }) {
  const padding = size === "sm" ? "3px 9px" : "4px 11px";
  const fontSize = size === "sm" ? 10 : 11;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding,
        borderRadius: RADIUS.pill,
        fontSize,
        fontWeight: 600,
        background: bg,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {dot && (
        <span
          style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }}
        />
      )}
      {children}
    </span>
  );
}
