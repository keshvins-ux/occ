// ============================================================
// Stock Item Picker Modal
//
// Slim version of CustomerPickerModal for stock items. Two modes:
//   1. SEARCH — filter the already-loaded stockItems list (no new endpoint)
//   2. CREATE — minimal form: code, description, default UOM, isactive
//
// Used by: src/sections/POIntake.js (Review screen, when an item line
// can't be matched to a stock code and the team needs to create one).
// ============================================================

import { useState } from "react";
import Ic from "./Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";

const VALID_UOMS = ["UNIT", "CTN", "BAG", "CARTON", "KG", "PKT"];

export default function StockItemPickerModal({ stockItems = [], prefilledDescription, onPick, onClose }) {
  const [mode, setMode] = useState("search");
  const [searchQ, setSearchQ] = useState(prefilledDescription || "");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const [form, setForm] = useState({
    code:        "",
    description: prefilledDescription || "",
    defuom_st:   "",
    isactive:    true,
  });

  // Local search — no API call needed since stockItems is already in memory
  const lower = searchQ.toLowerCase().trim();
  const filtered = lower.length < 2 ? [] : stockItems
    .filter(s =>
      (s.code || "").toLowerCase().includes(lower) ||
      (s.description || "").toLowerCase().includes(lower)
    )
    .slice(0, 12);

  function updateField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function getMissingFields() {
    const missing = [];
    if (!form.code?.trim())        missing.push("Stock code");
    if (!form.description?.trim()) missing.push("Description");
    if (!form.defuom_st?.trim())   missing.push("Default UOM");
    return missing;
  }

  async function submitCreate() {
    const missing = getMissingFields();
    if (missing.length > 0) {
      setErr(`Please fill: ${missing.join(", ")}`);
      return;
    }
    setSubmitting(true);
    setErr("");
    try {
      const resp = await fetch("/api/create-doc?type=stockitem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setErr(data.error || (data.duplicate ? "Stock code already taken." : "Failed to create stock item."));
        setSubmitting(false);
        return;
      }
      onPick({ code: data.code, description: data.description, defuom_st: data.defuom_st });
    } catch (e) {
      setErr(e.message || "Network error.");
      setSubmitting(false);
    }
  }

  const missing = getMissingFields();
  const canSubmit = missing.length === 0 && !submitting;

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={e => e.stopPropagation()} style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Ic name={mode === "search" ? "search" : "plusCircle"} size={20} color={BRAND.accent} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>
                {mode === "search" ? "Find or create stock item" : "Create new stock item"}
              </div>
              <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                {mode === "search"
                  ? "Search before adding — avoid duplicates"
                  : "Fields marked * are required"}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn}>
            <Ic name="x" size={14} color={COLORS.textMuted} />
          </button>
        </div>

        {err && (
          <div style={{ margin: "0 24px", padding: "10px 14px", borderRadius: RADIUS.md, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}33`, color: COLORS.dangerDark, fontSize: 12 }}>
            {err}
          </div>
        )}

        {/* SEARCH MODE */}
        {mode === "search" && (
          <div style={{ padding: "20px 24px" }}>
            <input
              autoFocus
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Type description or code (min. 2 characters)…"
              style={{
                width: "100%", padding: "12px 16px", fontSize: 14,
                borderRadius: RADIUS.md, border: `1.5px solid ${COLORS.borderStrong}`,
                outline: "none", color: COLORS.text, fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />

            <div style={{ marginTop: 16, maxHeight: 360, overflowY: "auto" }}>
              {filtered.length === 0 && lower.length >= 2 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: COLORS.textMuted, background: COLORS.surfaceAlt, borderRadius: RADIUS.md }}>
                  No matches for "<strong>{searchQ}</strong>".
                </div>
              )}
              {filtered.map(s => (
                <div
                  key={s.code}
                  onClick={() => onPick({ code: s.code, description: s.description, defuom_st: s.uom_code })}
                  style={resultCardStyle}
                  onMouseEnter={e => e.currentTarget.style.borderColor = BRAND.accent}
                  onMouseLeave={e => e.currentTarget.style.borderColor = COLORS.borderStrong}
                >
                  <div>
                    <div style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: BRAND.accent }}>
                      {s.code}
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                      {s.description}
                    </div>
                    {s.uom_code && (
                      <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 3 }}>
                        Default UOM: <span style={{ fontFamily: FONT.mono }}>{s.uom_code}</span>
                      </div>
                    )}
                  </div>
                  <Ic name="chevron" size={14} color={COLORS.textFaint} />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${COLORS.borderFaint}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                {filtered.length > 0 ? "None of these match?" : "Item not in the catalogue yet?"}
              </div>
              <button onClick={() => setMode("create")} style={primaryBtn}>
                <Ic name="plusCircle" size={14} color="#fff" />
                Create new stock item
              </button>
            </div>
          </div>
        )}

        {/* CREATE MODE */}
        {mode === "create" && (
          <div style={{ padding: "20px 24px" }}>
            <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
              <Field
                label="Stock code"
                required
                value={form.code}
                onChange={v => updateField("code", v)}
                placeholder="e.g. CRD-25KG"
                mono
              />
              <SelectField
                label="Default UOM"
                required
                value={form.defuom_st}
                onChange={v => updateField("defuom_st", v)}
                options={VALID_UOMS}
                placeholder="Pick one…"
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <Field
                label="Description"
                required
                value={form.description}
                onChange={v => updateField("description", v)}
                placeholder="e.g. CARDAMOM 25KG SACK"
                fullWidth
              />
            </div>

            {/* Footer actions */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${COLORS.borderFaint}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <button onClick={() => setMode("search")} style={secondaryBtn}>
                ← Back to search
              </button>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                {missing.length > 0 && (
                  <span style={{ fontSize: 11, color: COLORS.warningDark, fontWeight: 600 }}>
                    {missing.length} missing
                  </span>
                )}
                <button
                  onClick={submitCreate}
                  disabled={!canSubmit}
                  style={{
                    ...primaryBtn,
                    opacity: canSubmit ? 1 : 0.5,
                    cursor: canSubmit ? "pointer" : "not-allowed",
                  }}
                >
                  {submitting ? "Creating…" : "Create stock item in SQL Account"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Subcomponents (same as CustomerPickerModal) ──────────────
function Field({ label, value, onChange, placeholder, required, mono, fullWidth }) {
  return (
    <div style={{ flex: fullWidth ? "1 1 100%" : 1 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, marginBottom: 4 }}>
        {label} {required && <span style={{ color: COLORS.danger }}>*</span>}
      </div>
      <input
        value={value || ""}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", padding: "8px 12px", fontSize: 13,
          borderRadius: RADIUS.sm, border: `1.5px solid ${COLORS.borderStrong}`,
          outline: "none", color: COLORS.text, fontFamily: mono ? FONT.mono : "inherit",
          background: COLORS.surface, boxSizing: "border-box",
        }}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options, required, placeholder }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, marginBottom: 4 }}>
        {label} {required && <span style={{ color: COLORS.danger }}>*</span>}
      </div>
      <select
        value={value || ""}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", padding: "8px 12px", fontSize: 13,
          borderRadius: RADIUS.sm, border: `1.5px solid ${COLORS.borderStrong}`,
          outline: "none", color: COLORS.text, background: COLORS.surface,
          boxSizing: "border-box",
        }}
      >
        <option value="">{placeholder || "Pick one…"}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────
const overlayStyle = {
  position: "fixed", inset: 0, zIndex: 200,
  background: "rgba(15, 23, 42, 0.45)", backdropFilter: "blur(4px)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
};
const modalStyle = {
  background: COLORS.surface, borderRadius: RADIUS.xl,
  maxWidth: 600, width: "100%", maxHeight: "85vh",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
  display: "flex", flexDirection: "column",
};
const headerStyle = {
  padding: "20px 24px", borderBottom: `1px solid ${COLORS.borderFaint}`,
  display: "flex", justifyContent: "space-between", alignItems: "center",
};
const closeBtn = {
  width: 32, height: 32, borderRadius: 10, background: COLORS.surfaceAlt,
  border: `1px solid ${COLORS.borderStrong}`,
  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
};
const resultCardStyle = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "12px 16px", marginBottom: 8,
  borderRadius: RADIUS.md, border: `1.5px solid ${COLORS.borderStrong}`,
  cursor: "pointer", transition: "border-color 0.15s",
  background: COLORS.surface,
};
const primaryBtn = {
  padding: "10px 18px", borderRadius: RADIUS.md,
  background: BRAND.accentGradient, color: "#fff", fontSize: 12, fontWeight: 700,
  border: "none", cursor: "pointer", boxShadow: SHADOWS.glow,
  display: "flex", alignItems: "center", gap: 8,
};
const secondaryBtn = {
  padding: "8px 14px", borderRadius: RADIUS.md,
  border: `1px solid ${COLORS.borderStrong}`, background: COLORS.surface,
  color: COLORS.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer",
};
