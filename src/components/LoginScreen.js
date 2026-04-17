import { useState } from "react";
import Ic from "./Ic";
import { BRAND, COLORS, RADIUS, SHADOWS } from "../theme";
import { useAuth } from "../contexts/AuthContext";

export default function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        background: `linear-gradient(135deg, #F5F7FB 0%, ${BRAND.accentGlow} 100%)`,
        padding: 32,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: COLORS.surface,
          borderRadius: 24,
          padding: "40px 40px 36px",
          boxShadow: "0 20px 60px rgba(15, 23, 42, 0.08), 0 4px 12px rgba(15, 23, 42, 0.04)",
          border: `1px solid ${COLORS.border}`,
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: BRAND.accentGradient,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: `${SHADOWS.glowHeavy}, inset 0 1px 0 rgba(255,255,255,0.3)`,
            }}
          >
            <svg
              width="24"
              height="24"
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
                fontSize: 22,
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
                marginTop: 4,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              Operations Command Centre
            </div>
          </div>
        </div>

        <div
          style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}
        >
          Welcome back
        </div>
        <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 28 }}>
          Sign in with your OCC email and password.
        </div>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 16 }}>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: COLORS.textMuted,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              style={{
                width: "100%",
                padding: "11px 14px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.borderStrong}`,
                fontSize: 14,
                outline: "none",
                color: COLORS.text,
                background: COLORS.surface,
              }}
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: COLORS.textMuted,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{
                width: "100%",
                padding: "11px 14px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.borderStrong}`,
                fontSize: 14,
                outline: "none",
                color: COLORS.text,
                background: COLORS.surface,
              }}
            />
          </div>

          {error && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: RADIUS.md,
                background: COLORS.dangerBg,
                border: `1px solid ${COLORS.danger}33`,
                fontSize: 12,
                color: COLORS.dangerDark,
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Ic name="alert" size={14} color={COLORS.dangerDark} />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "12px 16px",
              borderRadius: 11,
              background: loading ? COLORS.textGhost : BRAND.accentGradient,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              border: "none",
              cursor: loading ? "not-allowed" : "pointer",
              boxShadow: loading ? "none" : SHADOWS.glow,
              transition: "all 0.15s",
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div
          style={{
            marginTop: 28,
            paddingTop: 20,
            borderTop: `1px solid ${COLORS.borderFaint}`,
            fontSize: 11,
            color: COLORS.textFaint,
            textAlign: "center",
          }}
        >
          Seri Rasa / Vertical Target Services Sdn. Bhd.
        </div>
      </div>
    </div>
  );
}
