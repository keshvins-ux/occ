import { useState } from "react";
import Ic from "./Ic";
import DateRangePicker from "./DateRangePicker";
import AIAssistantDrawer from "./AIAssistantDrawer";
import { BRAND, COLORS, RADIUS, SHADOWS, paletteFor, initialsOf } from "../theme";
import { useAuth } from "../contexts/AuthContext";
import { useDateRange } from "../contexts/DateRangeContext";

export const SECTIONS = [
  { id: "sales", label: "Sales", subs: ["Overview", "Pipeline", "Analytics"], icon: "chart" },
  { id: "management", label: "Management", subs: ["AR Overview", "Customers", "SO Lifecycle"], icon: "monitor" },
  { id: "po", label: "Documents", subs: ["Submit PO", "Create DO", "Create Invoice", "Document Tracker"], icon: "download" },
  { id: "production", label: "Production", subs: ["Overview", "Order Queue", "Gap Analysis", "Purchase List", "Capacity", "Floor Display"], icon: "factory" },
  { id: "procurement", label: "Procurement", subs: ["Supplier POs", "GRN", "Stock", "Suppliers"], icon: "cart" },
  { id: "compliance", label: "Compliance", subs: ["Dashboard", "Certificates", "Traceability"], icon: "shield" },
];

export default function Layout({ active, sub, onNavigate, children }) {
  const [hovered, setHovered] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const { user, logout } = useAuth();
  const { range } = useDateRange();

  const section = SECTIONS.find((s) => s.id === active) || SECTIONS[0];
  const currentSub = section?.subs?.[sub] || section?.subs?.[0] || "";
  const userName = user?.name || user?.username || "User";
  const userInitials = initialsOf(userName);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        background: COLORS.bg,
        overflow: "hidden",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: 230,
          background: COLORS.surface,
          borderRight: `1px solid rgba(226, 232, 240, 0.8)`,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            padding: "24px 24px 22px",
            borderBottom: `1px solid ${COLORS.borderFaint}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              background: BRAND.accentGradient,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: `${SHADOWS.glow}, inset 0 1px 0 rgba(255,255,255,0.3)`,
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 800,
                color: COLORS.text,
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              OCC
            </div>
            <div
              style={{
                fontSize: 10,
                color: COLORS.textFaint,
                marginTop: 3,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              {process.env.REACT_APP_BRAND_TAGLINE || 'Command Centre'}
            </div>
          </div>
        </div>

        {/* Nav */}
        <div style={{ flex: 1, padding: "18px 12px", overflowY: "auto" }}>
          <div
            style={{
              fontSize: 10,
              color: COLORS.textGhost,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              padding: "0 12px 10px",
            }}
          >
            Workspace
          </div>
          {SECTIONS.map((s) => {
            const isActive = active === s.id;
            const isHovered = hovered === s.id;
            return (
              <div key={s.id}>
                <button
                  onMouseEnter={() => setHovered(s.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => onNavigate(s.id, 0)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "10px 12px",
                    borderRadius: RADIUS.md,
                    border: "none",
                    cursor: "pointer",
                    marginBottom: 3,
                    background: isActive
                      ? `linear-gradient(90deg, ${BRAND.accentGlow} 0%, rgba(99, 102, 241, 0.1) 100%)`
                      : isHovered
                      ? "rgba(79, 124, 247, 0.06)"
                      : "transparent",
                    color: isActive ? BRAND.accent : isHovered ? COLORS.text : COLORS.textMuted,
                    fontSize: 13,
                    fontWeight: isActive ? 600 : isHovered ? 500 : 400,
                    textAlign: "left",
                    transition: "all 0.2s ease",
                    boxShadow: isActive
                      ? `inset 2px 0 0 ${BRAND.accent}, 0 0 20px ${BRAND.accentGlow}`
                      : isHovered
                      ? `0 0 16px ${BRAND.accentGlow}`
                      : "none",
                    position: "relative",
                  }}
                >
                  <Ic
                    name={s.icon}
                    size={18}
                    color={isActive ? BRAND.accent : isHovered ? BRAND.accent : COLORS.textFaint}
                  />
                  <span style={{ flex: 1 }}>{s.label}</span>
                  {s.subs.length > 1 && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={isActive ? BRAND.accent : COLORS.textGhost}
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      style={{
                        transform: isActive ? "rotate(90deg)" : "none",
                        transition: "transform 0.2s",
                      }}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  )}
                </button>
                {isActive && s.subs.length > 1 && (
                  <div
                    style={{
                      paddingLeft: 40,
                      marginBottom: 6,
                      marginTop: 2,
                      borderLeft: `1px dashed rgba(79, 124, 247, 0.3)`,
                      marginLeft: 20,
                    }}
                  >
                    {s.subs.map((subLabel, i) => (
                      <button
                        key={subLabel}
                        onClick={() => onNavigate(s.id, i)}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "7px 12px",
                          borderRadius: RADIUS.sm,
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 12,
                          color: sub === i ? BRAND.accent : COLORS.textFaint,
                          fontWeight: sub === i ? 600 : 400,
                          background: sub === i ? BRAND.accentGlow : "transparent",
                          marginBottom: 1,
                          transition: "all 0.15s",
                        }}
                      >
                        {subLabel}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom */}
        <div style={{ padding: "12px", borderTop: `1px solid ${COLORS.borderFaint}` }}>
          <button
            onClick={logout}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: RADIUS.sm,
              border: "none",
              cursor: "pointer",
              background: "transparent",
              color: COLORS.textFaint,
              fontSize: 12,
              textAlign: "left",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = COLORS.dangerBg;
              e.currentTarget.style.color = COLORS.dangerDark;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = COLORS.textFaint;
            }}
          >
            <Ic name="logout" size={14} color="currentColor" />
            Sign out
          </button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Top bar */}
        <div
          style={{
            padding: "16px 32px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: COLORS.surface,
            borderBottom: `1px solid rgba(226, 232, 240, 0.8)`,
            position: "sticky",
            top: 0,
            zIndex: 20,
            backdropFilter: "blur(8px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
            <div style={{ position: "relative", maxWidth: 380, flex: 1 }}>
              <input
                placeholder="Search SOs, customers, products..."
                style={{
                  width: "100%",
                  padding: "10px 16px 10px 40px",
                  borderRadius: RADIUS.lg,
                  border: `1px solid ${COLORS.borderStrong}`,
                  fontSize: 12,
                  outline: "none",
                  color: COLORS.textSecondary,
                  background: COLORS.surfaceAlt,
                }}
              />
              <div
                style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }}
              >
                <Ic name="search" size={14} color={COLORS.textFaint} />
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <DateRangePicker />
            <button
              style={{
                width: 38,
                height: 38,
                borderRadius: RADIUS.md,
                background: COLORS.surfaceAlt,
                border: `1px solid ${COLORS.borderStrong}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                position: "relative",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = BRAND.accentGlow;
                e.currentTarget.style.borderColor = "rgba(79, 124, 247, 0.4)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = COLORS.surfaceAlt;
                e.currentTarget.style.borderColor = COLORS.borderStrong;
              }}
            >
              <Ic name="bell" size={16} color={COLORS.textMuted} />
            </button>
            <UserChip name={userName} initials={userInitials} />
          </div>
        </div>

        {/* Page header */}
        <div style={{ padding: "28px 32px 24px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
              color: COLORS.textFaint,
              marginBottom: 6,
              fontWeight: 500,
            }}
          >
            <span>{section.label}</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke={COLORS.textGhost}
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            <span style={{ color: BRAND.accent, fontWeight: 600 }}>{currentSub}</span>
            <span style={{ color: COLORS.textGhost }}>·</span>
            <span style={{ color: COLORS.textMuted }}>{range.label}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: COLORS.text,
                  letterSpacing: "-0.03em",
                  marginBottom: 4,
                }}
              >
                {currentSub}
              </div>
              <div style={{ fontSize: 13, color: COLORS.textMuted }}>
                {new Date().toLocaleDateString("en-MY", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </div>
            </div>
            <button
              onClick={() => setAiOpen(true)}
              style={{
                padding: "10px 18px",
                borderRadius: 11,
                background: BRAND.accentGradient,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                boxShadow: SHADOWS.glow,
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.boxShadow = SHADOWS.glowHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = SHADOWS.glow;
              }}
            >
              <Ic name="sparkle" size={14} color="#fff" />
              Ask AI
            </button>
          </div>
        </div>

        <div style={{ padding: "0 32px 32px" }}>{children}</div>
      </div>

      <AIAssistantDrawer open={aiOpen} onClose={() => setAiOpen(false)} />
    </div>
  );
}

function UserChip({ name, initials }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 12px 5px 5px",
        borderRadius: RADIUS.lg,
        background: COLORS.surfaceAlt,
        border: `1px solid ${COLORS.borderStrong}`,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: RADIUS.md,
          background: BRAND.accentGradient,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: 12,
          fontWeight: 700,
          boxShadow: "0 2px 8px rgba(79, 124, 247, 0.18)",
        }}
      >
        {initials}
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.text }}>{name}</div>
        <div style={{ fontSize: 10, color: COLORS.textFaint }}>Administrator</div>
      </div>
    </div>
  );
}
