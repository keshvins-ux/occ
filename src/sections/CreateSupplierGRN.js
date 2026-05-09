// ============================================================
// CREATE SUPPLIER GRN — Placeholder (Day 7)
//
// Will become the Goods Received Note creation flow:
//   - Pick an open PO
//   - Adjust received qty per line (vs ordered qty)
//   - Capture batch numbers, expiry dates, Halal cert refs
//   - Submit to SQL Account /goodsreceivednote endpoint
//
// Currently displays a "coming soon" placeholder so the sub-tab
// renders cleanly in Layout's navigation.
// ============================================================

import Card from "../components/Card";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS } from "../theme";

export default function CreateSupplierGRN() {
  return <ComingSoonCard
    icon="truck"
    title="Create Supplier GRN"
    subtitle="Goods Received Note flow"
    bullets={[
      "Pick an open Purchase Order",
      "Capture received qty (vs ordered)",
      "Record batch numbers, expiry dates, Halal certs",
      "Submit to SQL Account",
    ]}
  />;
}

// Shared "coming soon" card — exported so other placeholders reuse it
export function ComingSoonCard({ icon, title, subtitle, bullets }) {
  return (
    <div style={{ maxWidth: 680, margin: "40px auto" }}>
      <Card>
        <div style={{ padding: "48px 32px", textAlign: "center" }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: BRAND.accentGlow,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 24px",
          }}>
            <Ic name={icon} size={28} color={BRAND.accent} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 24 }}>
            {subtitle}
          </div>
          <div style={{
            display: "inline-block",
            padding: "5px 12px", borderRadius: 999,
            background: COLORS.warningBg, color: COLORS.warningDark,
            fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
            textTransform: "uppercase",
            marginBottom: 28,
          }}>
            Coming Soon
          </div>
          {bullets && bullets.length > 0 && (
            <div style={{
              maxWidth: 360, margin: "0 auto", textAlign: "left",
              padding: "16px 18px", borderRadius: RADIUS.md,
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.borderFaint}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                Planned scope
              </div>
              {bullets.map((b, i) => (
                <div key={i} style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: BRAND.accent, fontWeight: 700 }}>·</span>
                  <span>{b}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
