// ============================================================
// Customer Picker Modal
//
// Two-mode modal for resolving "AI didn't match a customer code":
//   1. SEARCH — let the team find an existing customer by name or code.
//      The AI's fuzzy match in extract-po.js can miss obvious cases
//      (trailing spaces, abbreviations, branch wording). This step
//      catches those before we accidentally create a duplicate record.
//   2. CREATE — if no match, build a strict, validated customer record
//      and POST it to SQL Account. Mandatory fields enforced both client-
//      and server-side.
//
// Used by: src/sections/POIntake.js (Review screen, when the AI
// couldn't determine a customerCode).
// ============================================================

import { useState, useEffect, useRef } from "react";
import Ic from "./Ic";
import Pill from "./Pill";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import config from "../config";

const CREDIT_TERMS = ["14 Days", "30 Days", "45 Days", "60 Days", "C.O.D."];

// AREAS — must match values registered in SQL Account's Area master.
// Currently only 3 values exist in sql_customers: ----, CORP, VS.
// If the team starts using a new area code, add it in SQL Account first
// (Customer → Maintain Area), then add it here.
const AREAS = [
  { value: "----", label: "---- (Default / unassigned)" },
  { value: "CORP", label: "CORP (Corporate)" },
  { value: "VS",   label: "VS (Vertical Services)" },
];

export default function CustomerPickerModal({ prefilledName, prefilledAddress, onPick, onClose }) {
  const [mode, setMode] = useState("search"); // 'search' | 'create'
  const [searchQ, setSearchQ] = useState(prefilledName || "");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [recentCodes, setRecentCodes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [suggestingCode, setSuggestingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  // Create-mode form state
  // Defaults match SQL Account's expected values:
  //   - currencycode: "----" is what existing customers use (NOT "MYR" — that fails FK validation)
  //   - country: "MY" is the 2-char ISO code SQL Account stores (NOT "Malaysia" — gets truncated to "Ma")
  //   - companycategory: required, must match one of the values from /api/prospects?type=customer_categories
  const [form, setForm] = useState({
    code:            "",
    companyname:     prefilledName || "",
    companyname2:    "",
    companycategory: "", // forced pick — required by SQL Account FK
    controlaccount:  config.sqlControlAccount || "300-0000",
    currencycode:    "----",  // SQL Account default — DO NOT change to "MYR"
    creditterm:      "", // forced pick — no default
    area:            "", // forced pick — must match an existing area code
    brn:             "",
    branch: {
      address1:  prefilledAddress?.line1 || "",
      address2:  prefilledAddress?.line2 || "",
      address3:  "",
      address4:  "",
      postcode:  prefilledAddress?.postcode || "",
      city:      prefilledAddress?.city || "",
      state:     prefilledAddress?.state || "",
      country:   "MY", // ISO 2-char — SQL Account stores 2 chars max
      attention: "",
      phone1:    prefilledAddress?.phone || "",
      mobile:    prefilledAddress?.mobile || "",
      email:     "",
    },
  });

  // Debounced search
  const debounceRef = useRef(null);
  useEffect(() => {
    if (mode !== "search") return;
    if (!searchQ || searchQ.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/prospects?type=customer_search&q=${encodeURIComponent(searchQ)}`)
          .then(r => r.json()).catch(() => ({}));
        setSearchResults(r.matches || []);
      } catch {} finally { setSearching(false); }
    }, 300);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [searchQ, mode]);

  // Trigger initial search if prefilled
  useEffect(() => {
    if (prefilledName && prefilledName.trim().length >= 2) {
      setSearchQ(prefilledName);
    }
  }, [prefilledName]);

  // Load recent codes + categories + auto-suggest a code on entering create mode
  async function enterCreateMode() {
    setMode("create");
    setErr("");

    // 1. Recent codes (existing — keeps the visual hint)
    try {
      const r = await fetch("/api/prospects?type=recent_customer_codes").then(r => r.json()).catch(() => ({}));
      setRecentCodes(r.codes || []);
    } catch {}

    // 2. Company categories — populates the dropdown
    try {
      const r = await fetch("/api/prospects?type=customer_categories").then(r => r.json()).catch(() => ({}));
      setCategories(r.categories || []);
    } catch {}

    // 3. Suggest the next code based on the customer name (if we have one).
    //    User can override in the form — this is just a hint, not a lock.
    if (form.companyname?.trim()) {
      setSuggestingCode(true);
      try {
        const r = await fetch(
          `/api/prospects?type=next_customer_code&name=${encodeURIComponent(form.companyname.trim())}`
        ).then(r => r.json()).catch(() => ({}));
        if (r.suggested) {
          setForm(prev => ({ ...prev, code: prev.code || r.suggested }));
        }
      } catch {} finally { setSuggestingCode(false); }
    }
  }

  function updateField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
  }
  function updateBranch(key, value) {
    setForm(prev => ({ ...prev, branch: { ...prev.branch, [key]: value } }));
  }

  // Client-side validation gate — mirrors the server-side gate in create-doc.js
  // so the team gets immediate feedback instead of a round-trip for obvious gaps.
  function getMissingFields() {
    const missing = [];
    if (!form.code?.trim())            missing.push("Customer code");
    if (!form.companyname?.trim())     missing.push("Company name");
    if (!form.companycategory?.trim()) missing.push("Company category");
    if (!form.controlaccount?.trim())  missing.push("Control account");
    if (!form.currencycode?.trim())    missing.push("Currency");
    if (!form.creditterm?.trim())      missing.push("Credit term");
    if (!form.area?.trim())            missing.push("Area");
    if (!form.brn?.trim())             missing.push("BRN");
    if (!form.branch.address1?.trim()) missing.push("Address line 1");
    if (!form.branch.phone1 && !form.branch.mobile) missing.push("Phone or mobile");
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
      const resp = await fetch("/api/create-doc?type=customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (data.duplicate) {
          setErr(data.error || "This customer code is already taken.");
        } else if (data.missing) {
          setErr(`Server validation: ${data.missing.join(", ")} required.`);
        } else {
          setErr(data.error || "Failed to create customer.");
        }
        setSubmitting(false);
        return;
      }
      // Success — pass the new code back to PO Intake
      onPick({ code: data.code, name: data.companyname });
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
              <Ic name={mode === "search" ? "search" : "userPlus"} size={20} color={BRAND.accent} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>
                {mode === "search" ? "Find or create customer" : "Create new customer"}
              </div>
              <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                {mode === "search"
                  ? "Search existing first — avoid creating duplicates"
                  : "All required fields will be sent to SQL Account"}
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
              placeholder="Type customer name or code (min. 2 characters)…"
              style={{
                width: "100%", padding: "12px 16px", fontSize: 14,
                borderRadius: RADIUS.md, border: `1.5px solid ${COLORS.borderStrong}`,
                outline: "none", color: COLORS.text, fontFamily: "inherit",
              }}
            />

            <div style={{ marginTop: 16, maxHeight: 360, overflowY: "auto" }}>
              {searching && (
                <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: COLORS.textMuted }}>
                  Searching…
                </div>
              )}
              {!searching && searchResults.length === 0 && searchQ.trim().length >= 2 && (
                <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: COLORS.textMuted, background: COLORS.surfaceAlt, borderRadius: RADIUS.md }}>
                  No matches found for "<strong>{searchQ}</strong>".
                </div>
              )}
              {searchResults.map(c => (
                <div
                  key={c.code}
                  onClick={() => onPick({ code: c.code, name: c.name })}
                  style={resultCardStyle}
                  onMouseEnter={e => e.currentTarget.style.borderColor = BRAND.accent}
                  onMouseLeave={e => e.currentTarget.style.borderColor = COLORS.borderStrong}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>
                      {c.name}
                    </div>
                    {c.outlet && (
                      <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                        {c.outlet}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 4, display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ fontFamily: FONT.mono }}>{c.code}</span>
                      {c.area && <span>·</span>}
                      {c.area && <span>{c.area}</span>}
                      {c.creditterm && <span>·</span>}
                      {c.creditterm && <Pill color={COLORS.infoDark} bg={COLORS.infoBg} size="sm">{c.creditterm}</Pill>}
                    </div>
                  </div>
                  <Ic name="chevron" size={14} color={COLORS.textFaint} />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${COLORS.borderFaint}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                {searchResults.length > 0 ? "None of these match?" : "Customer doesn't exist yet?"}
              </div>
              <button onClick={enterCreateMode} style={primaryBtn}>
                <Ic name="userPlus" size={14} color="#fff" />
                Create new customer
              </button>
            </div>
          </div>
        )}

        {/* CREATE MODE */}
        {mode === "create" && (
          <div style={{ padding: "20px 24px", maxHeight: "70vh", overflowY: "auto" }}>
            {/* Recent codes hint */}
            {recentCodes.length > 0 && (
              <div style={{ marginBottom: 14, padding: "10px 14px", background: COLORS.infoBg, borderRadius: RADIUS.md, fontSize: 11, color: COLORS.infoDark }}>
                <strong>Recent codes used:</strong>{" "}
                <span style={{ fontFamily: FONT.mono }}>{recentCodes.join("  ·  ")}</span>
              </div>
            )}

            {/* Required note */}
            <div style={{ marginBottom: 16, fontSize: 11, color: COLORS.textMuted }}>
              Fields marked <span style={{ color: COLORS.danger, fontWeight: 700 }}>*</span> are required.
              BRN is mandatory for e-invoicing.
            </div>

            {/* Customer identity */}
            <SectionLabel>Customer identity</SectionLabel>
            <FormRow>
              <Field
                label={suggestingCode ? "Customer code (suggesting…)" : "Customer code"}
                required
                value={form.code}
                onChange={v => updateField("code", v)}
                placeholder="e.g. 300-T0042"
                mono
              />
              <Field label="Company name" required value={form.companyname} onChange={v => updateField("companyname", v)} placeholder="e.g. Tarik Bistro Sdn Bhd" />
            </FormRow>
            <FormRow>
              <Field label="Outlet / branch name" value={form.companyname2} onChange={v => updateField("companyname2", v)} placeholder="e.g. TTDI (optional)" />
              <Field label="BRN" required value={form.brn} onChange={v => updateField("brn", v)} placeholder="Business Registration No." mono />
            </FormRow>

            {/* Account setup */}
            <SectionLabel>Account setup</SectionLabel>
            <FormRow>
              <SelectField
                label="Company category"
                required
                value={form.companycategory}
                onChange={v => updateField("companycategory", v)}
                options={categories}
                placeholder={categories.length === 0 ? "Loading…" : "Pick one…"}
              />
              <Field label="Control account" required value={form.controlaccount} onChange={v => updateField("controlaccount", v)} mono />
            </FormRow>
            <FormRow>
              <Field label="Currency" required value={form.currencycode} onChange={v => updateField("currencycode", v)} mono />
              <SelectField
                label="Credit term"
                required
                value={form.creditterm}
                onChange={v => updateField("creditterm", v)}
                options={CREDIT_TERMS}
                placeholder="Pick one…"
              />
            </FormRow>
            <FormRow>
              <SelectField
                label="Area"
                required
                value={form.area}
                onChange={v => updateField("area", v)}
                options={AREAS.map(a => a.value)}
                placeholder="Pick one…"
              />
              {/* Empty cell to keep grid alignment */}
              <div />
            </FormRow>

            {/* Branch / contact */}
            <SectionLabel>Address & contact</SectionLabel>
            <FormRow>
              <Field label="Address line 1" required value={form.branch.address1} onChange={v => updateBranch("address1", v)} fullWidth />
            </FormRow>
            <FormRow>
              <Field label="Address line 2" value={form.branch.address2} onChange={v => updateBranch("address2", v)} fullWidth />
            </FormRow>
            <FormRow>
              <Field label="City" value={form.branch.city} onChange={v => updateBranch("city", v)} />
              <Field label="Postcode" value={form.branch.postcode} onChange={v => updateBranch("postcode", v)} />
            </FormRow>
            <FormRow>
              <Field label="State" value={form.branch.state} onChange={v => updateBranch("state", v)} />
              <Field label="Country" value={form.branch.country} onChange={v => updateBranch("country", v)} />
            </FormRow>
            <FormRow>
              <Field
                label={form.branch.mobile ? "Phone" : "Phone *"}
                value={form.branch.phone1}
                onChange={v => updateBranch("phone1", v)}
                placeholder="Required if no mobile"
              />
              <Field
                label={form.branch.phone1 ? "Mobile" : "Mobile *"}
                value={form.branch.mobile}
                onChange={v => updateBranch("mobile", v)}
                placeholder="Required if no phone"
              />
            </FormRow>
            <FormRow>
              <Field label="Email" value={form.branch.email} onChange={v => updateBranch("email", v)} fullWidth />
            </FormRow>

            {/* Footer actions */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${COLORS.borderFaint}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <button onClick={() => setMode("search")} style={secondaryBtn}>
                ← Back to search
              </button>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                {missing.length > 0 && (
                  <span style={{ fontSize: 11, color: COLORS.warningDark, fontWeight: 600 }}>
                    {missing.length} required field{missing.length === 1 ? "" : "s"} missing
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
                  {submitting ? "Creating…" : "Create customer in SQL Account"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", margin: "20px 0 10px" }}>
      {children}
    </div>
  );
}

function FormRow({ children }) {
  return <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>{children}</div>;
}

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
          background: COLORS.surface,
          boxSizing: "border-box",
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
  maxWidth: 720, width: "100%", maxHeight: "90vh",
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
