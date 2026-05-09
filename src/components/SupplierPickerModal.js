// ============================================================
// Supplier Picker Modal
//
// Search-only mode for procurement v1. The user opens this from
// the Create Supplier PO page to find an existing supplier.
//
// Why search-only (no Create mode in v1):
//   Per Day 6 handover, the create-supplier flow is deferred
//   to a later session. Yuges adds suppliers carefully (QC sample
//   approval first), so creating from inside a PO flow would
//   skip a workflow step she relies on. For now, suppliers must
//   be created in SQL Account directly, then will appear here on
//   next sync (every 10 min).
//
// Soft-deleted suppliers (e.g. 400-TEST06) are filtered out at
// the API layer — this modal trusts the API.
//
// Used by: src/sections/CreateSupplierPO.js
// ============================================================

import { useState, useEffect, useRef } from "react";
import Ic from "./Ic";
import Pill from "./Pill";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";

export default function SupplierPickerModal({ onPick, onClose }) {
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Debounced search — same 300ms cadence as CustomerPickerModal.
  const debounceRef = useRef(null);
  useEffect(() => {
    if (!searchQ || searchQ.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/prospects?type=supplier_search&q=${encodeURIComponent(searchQ)}`)
          .then(r => r.json()).catch(() => ({}));
        setSearchResults(r.matches || []);
      } catch {
        // Swallow — show empty results
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [searchQ]);

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={e => e.stopPropagation()} style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Ic name="search" size={20} color={BRAND.accent} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>
                Find supplier
              </div>
              <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                Search by name or supplier code (min. 2 characters)
              </div>
            </div>
          </div>
          <button onClick={onClose} style={closeBtn}>
            <Ic name="x" size={14} color={COLORS.textMuted} />
          </button>
        </div>

        {/* Search input + results */}
        <div style={{ padding: "20px 24px" }}>
          <input
            autoFocus
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder="Type supplier name or code…"
            style={{
              width: "100%", padding: "12px 16px", fontSize: 14,
              borderRadius: RADIUS.md, border: `1.5px solid ${COLORS.borderStrong}`,
              outline: "none", color: COLORS.text, fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />

          <div style={{ marginTop: 16, maxHeight: 420, overflowY: "auto" }}>
            {searching && (
              <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: COLORS.textMuted }}>
                Searching…
              </div>
            )}
            {!searching && searchQ.trim().length >= 2 && searchResults.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: COLORS.textMuted, background: COLORS.surfaceAlt, borderRadius: RADIUS.md }}>
                No suppliers match "<strong>{searchQ}</strong>".
              </div>
            )}
            {!searching && searchQ.trim().length < 2 && (
              <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: COLORS.textFaint }}>
                Start typing to search…
              </div>
            )}
            {searchResults.map(s => (
              <div
                key={s.code}
                onClick={() => onPick({ code: s.code, name: s.name })}
                style={resultCardStyle}
                onMouseEnter={e => e.currentTarget.style.borderColor = BRAND.accent}
                onMouseLeave={e => e.currentTarget.style.borderColor = COLORS.borderStrong}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>
                    {s.name}
                  </div>
                  {s.outlet && (
                    <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                      {s.outlet}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 4, display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ fontFamily: FONT.mono }}>{s.code}</span>
                    {s.area && <span>·</span>}
                    {s.area && <span>{s.area}</span>}
                    {s.creditterm && <span>·</span>}
                    {s.creditterm && <Pill color={COLORS.infoDark} bg={COLORS.infoBg} size="sm">{s.creditterm}</Pill>}
                  </div>
                </div>
                <Ic name="chevron" size={14} color={COLORS.textFaint} />
              </div>
            ))}
          </div>

          {/* Footer hint — no Create button in v1 */}
          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${COLORS.borderFaint}`, fontSize: 11, color: COLORS.textFaint, textAlign: "center" }}>
            Need to add a new supplier? Create it in SQL Account first — it will appear here on next sync (within 10 min).
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles (mirroring CustomerPickerModal's tokens) ────────
const overlayStyle = {
  position: "fixed", inset: 0, zIndex: 200,
  background: "rgba(15, 23, 42, 0.45)", backdropFilter: "blur(4px)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
};
const modalStyle = {
  background: COLORS.surface, borderRadius: RADIUS.xl,
  maxWidth: 640, width: "100%", maxHeight: "90vh",
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
