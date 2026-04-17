import { paletteFor, initialsOf } from "../theme";

// Colored initials avatar. Palette is deterministic from the name.
// Pass `palette` as [bg, fg] to override auto-assignment.
export default function Avatar({ name, text, palette, size = 36 }) {
  const initials = text || initialsOf(name);
  const [bg, fg] = palette || paletteFor(name || text || "?");
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size >= 40 ? 12 : 10,
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size >= 40 ? 13 : 11,
        fontWeight: 700,
        color: fg,
        flexShrink: 0,
        letterSpacing: "-0.02em",
      }}
    >
      {initials}
    </div>
  );
}
