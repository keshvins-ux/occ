// OCC Design System — single source of truth for colors, spacing, shadows.
// Every component imports from here. Changing a token here changes it everywhere.

export const BRAND = {
  accent: "#4F7CF7",              // signature blue-violet
  accentDark: "#6366F1",          // gradient partner
  accentGlow: "rgba(79, 124, 247, 0.18)",
  accentGradient: "linear-gradient(135deg, #4F7CF7 0%, #6366F1 100%)",
};

export const COLORS = {
  // Text
  text: "#0F172A",
  textSecondary: "#475569",
  textMuted: "#64748B",
  textFaint: "#94A3B8",
  textGhost: "#CBD5E1",

  // Surfaces
  bg: "#F5F7FB",
  surface: "#FFFFFF",
  surfaceAlt: "#F8FAFC",
  surfaceMuted: "#FAFBFD",

  // Borders
  border: "rgba(226, 232, 240, 0.6)",
  borderStrong: "#E2E8F0",
  borderFaint: "#F1F5F9",
  borderGhost: "#F8FAFC",

  // Status
  success: "#10B981",
  successDark: "#059669",
  successBg: "#ECFDF5",
  warning: "#F59E0B",
  warningDark: "#D97706",
  warningBg: "#FEF3C7",
  danger: "#EF4444",
  dangerDark: "#DC2626",
  dangerBg: "#FEE2E2",
  info: "#3B82F6",
  infoDark: "#2563EB",
  infoBg: "#EFF6FF",
  neutral: "#64748B",
  neutralBg: "#F1F5F9",
};

export const SHADOWS = {
  card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 12px rgba(15, 23, 42, 0.03)",
  cardHover: "0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06)",
  glow: `0 4px 14px ${BRAND.accentGlow}`,
  glowHover: `0 6px 20px ${BRAND.accentGlow}`,
  glowHeavy: `0 8px 24px ${BRAND.accentGlow}`,
  drawer: "-8px 0 32px rgba(15, 23, 42, 0.15)",
  dropdown: "0 8px 32px rgba(15, 23, 42, 0.12)",
  button: "0 2px 6px rgba(15, 23, 42, 0.2)",
};

export const RADIUS = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  xxl: 18,
  pill: 99,
};

export const FONT = {
  mono: "'JetBrains Mono', 'SF Mono', monospace",
};

// Avatar color palettes — deterministic assignment by hashing the input string
const PALETTES = [
  ["#DBEAFE", "#2563EB"],   // blue
  ["#D1FAE5", "#059669"],   // green
  ["#FEF3C7", "#D97706"],   // amber
  ["#E0E7FF", "#4F46E5"],   // indigo
  ["#FCE7F3", "#DB2777"],   // pink
  ["#FEE2E2", "#DC2626"],   // red
  ["#F5F3FF", "#7C3AED"],   // violet
  ["#FFF7ED", "#EA580C"],   // orange
  ["#ECFEFF", "#0891B2"],   // cyan
];

export function paletteFor(str) {
  const s = String(str || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PALETTES[Math.abs(h) % PALETTES.length];
}

export function initialsOf(str) {
  const parts = String(str || "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
