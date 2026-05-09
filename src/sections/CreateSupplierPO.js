// ============================================================
// CREATE SUPPLIER PO — Procurement v1 (Day 7, 2026-05-08)
//
// Two-pane page for creating a new supplier purchase order:
//   - Left pane (60%): PO Composer
//       Supplier picker → Date/ref → Line items → Submit
//   - Right pane (40%): Decision Support
//       Supplier's recent POs · Selected item's price history
//
// Stage machine: compose → submitting → done
//   (Halal warnings interrupt to a 'reviewWarnings' substage)
//
// Submit endpoint: /api/create-doc?type=purchaseorder
//   Verified working Day 3 — the handler enforces:
//     - supplier code required
//     - lines must have itemcode + qty + uom + unitprice
//     - Halal compliance check (per line)
//     - Returns { error, warnings[] } 400 if blockers without overrides
//     - Returns { success, dockey, docno, ... } 200 on success
// ============================================================

import { useState, useEffect } from "react";
import Card from "../components/Card";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import SupplierPickerModal from "../components/SupplierPickerModal";
import StockItemPickerModal from "../components/StockItemPickerModal";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fmtD, isoDate, fetchJson } from "../utils";
import { useAuth } from "../contexts/AuthContext";

export default function CreateSupplierPO() {
  const { user } = useAuth();
  const submittedBy = user?.username || user?.name || "unknown";

  // ── Page-level state ──────────────────────────────────────
  const [stage, setStage] = useState("compose"); // compose | submitting | reviewWarnings | done
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // ── PO header state ───────────────────────────────────────
  const [supplier, setSupplier] = useState(null); // { code, name }
  const [docdate, setDocdate] = useState(isoDate(new Date()));
  const [docref1, setDocref1] = useState("");
  const [description, setDescription] = useState("Purchase Order");

  // ── Line items state ──────────────────────────────────────
  // Each line: { itemcode, description, qty, uom, unitprice, deliverydate }
  const [lines, setLines] = useState([]);

  // ── Stock items catalogue (loaded once on mount) ──────────
  // StockItemPickerModal does in-memory search; needs the full list.
  const [stockItems, setStockItems] = useState([]);
  const [stockItemsLoading, setStockItemsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchJson("/api/prospects?type=stock_items")
      .then(d => { if (!cancelled) setStockItems(d.items || d.stockItems || []); })
      .catch(() => { /* swallow — picker will show empty state */ })
      .finally(() => { if (!cancelled) setStockItemsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ── Modal state ───────────────────────────────────────────
  const [showSupplierPicker, setShowSupplierPicker] = useState(false);
  const [showItemPicker, setShowItemPicker] = useState(false);

  // ── Right-pane focus: which item is currently being inspected ──
  // When user clicks an item code in the lines list, the right pane
  // shows that item's price history. Defaults to the most recently
  // added line.
  const [focusedItemcode, setFocusedItemcode] = useState(null);

  // ── Halal warnings state ──────────────────────────────────
  // When the submit handler returns 400 with warnings[], we show
  // the override modal as a stage substate.
  const [warnings, setWarnings] = useState([]); // array of { itemcode, warning_level, message }
  const [overrideReasons, setOverrideReasons] = useState({}); // itemcode → reason string

  // ──────────────────────────────────────────────────────────
  // ── HANDLERS ──────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────

  function handleSupplierPick({ code, name }) {
    setSupplier({ code, name });
    setShowSupplierPicker(false);
    setError("");
  }

  function handleItemPick(item) {
    // StockItemPickerModal returns: { code, description, defuom_st }
    // We map to our line shape: { itemcode, description, qty, uom, unitprice, deliverydate }
    const newLine = {
      itemcode:     item.code,
      description:  item.description || "",
      qty:          1,
      uom:          item.defuom_st || "UNIT",
      unitprice:    0, // user fills in (or we suggest from history once focused)
      deliverydate: docdate,
    };
    setLines(prev => [...prev, newLine]);
    setFocusedItemcode(item.code);
    setShowItemPicker(false);
  }

  function updateLine(idx, key, value) {
    setLines(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [key]: value };
      return next;
    });
  }

  function removeLine(idx) {
    setLines(prev => {
      const next = prev.filter((_, i) => i !== idx);
      // If we removed the focused item, defocus
      if (prev[idx] && prev[idx].itemcode === focusedItemcode) {
        setFocusedItemcode(next.length > 0 ? next[next.length - 1].itemcode : null);
      }
      return next;
    });
  }

  function reset() {
    setStage("compose");
    setSupplier(null);
    setDocdate(isoDate(new Date()));
    setDocref1("");
    setDescription("Purchase Order");
    setLines([]);
    setFocusedItemcode(null);
    setWarnings([]);
    setOverrideReasons({});
    setError("");
    setResult(null);
  }

  // ── Submission ────────────────────────────────────────────
  async function submitPO(overrides = []) {
    // Client-side validation gate
    if (!supplier?.code) {
      setError("Pick a supplier first.");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one line item.");
      return;
    }
    const lineErrors = [];
    lines.forEach((l, i) => {
      if (!l.itemcode)                 lineErrors.push(`Line ${i + 1}: missing item code`);
      if (!l.qty || Number(l.qty) <= 0) lineErrors.push(`Line ${i + 1}: qty must be > 0`);
      if (!l.uom)                      lineErrors.push(`Line ${i + 1}: missing UOM`);
      if (l.unitprice === undefined || l.unitprice === null || l.unitprice === "") {
        lineErrors.push(`Line ${i + 1}: missing unit price`);
      }
    });
    if (lineErrors.length > 0) {
      setError(lineErrors.join(" · "));
      return;
    }

    setStage("submitting");
    setError("");

    // Build request body matching the handler's contract (create-doc.js line 1073+)
    const poPayload = {
      code:        supplier.code,
      docdate,
      postdate:    docdate,
      docref1:     docref1 || "",
      description: description || "Purchase Order",
      sdsdocdetail: lines.map((l, i) => ({
        seq:          (i + 1) * 10, // 10, 20, 30 — gives room to insert later
        itemcode:     l.itemcode,
        description:  l.description,
        qty:          Number(l.qty),
        uom:          l.uom,
        unitprice:    Number(l.unitprice),
        amount:       Number(l.qty) * Number(l.unitprice),
        deliverydate: l.deliverydate || docdate,
      })),
    };

    try {
      const resp = await fetch("/api/create-doc?type=purchaseorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poPayload, submittedBy, overrides }),
      });
      const data = await resp.json();

      // Halal compliance interrupt — the handler returns 400 with warnings[]
      if (resp.status === 400 && data?.error === "Halal compliance warnings require override") {
        setWarnings(data.warnings || []);
        setStage("reviewWarnings");
        return;
      }

      if (!resp.ok || data?.error) {
        setError(data?.error || `Submission failed (HTTP ${resp.status})`);
        setStage("compose");
        return;
      }

      // Success
      setResult(data);
      setStage("done");
    } catch (e) {
      setError(e.message || "Network error during submission.");
      setStage("compose");
    }
  }

  // Resubmit with overrides (called from the warnings modal)
  function submitWithOverrides() {
    const overrides = warnings.map(w => ({
      itemcode:      w.itemcode,
      warning_level: w.warning_level,
      reason:        overrideReasons[w.itemcode] || "",
    }));
    // Validation: every blocking warning needs a reason
    const missing = overrides.filter(o => !o.reason.trim());
    if (missing.length > 0) {
      setError(`Override reason required for: ${missing.map(m => m.itemcode).join(", ")}`);
      return;
    }
    setError("");
    submitPO(overrides);
  }

  // ──────────────────────────────────────────────────────────
  // ── DERIVED VALUES ────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  const total = lines.reduce(
    (sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitprice) || 0),
    0
  );

  // ──────────────────────────────────────────────────────────
  // ── RENDER ────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────

  // ── DONE state (full-width success) ───────────────────────
  if (stage === "done" && result) {
    return (
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <Card>
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{
              width: 56, height: 56, borderRadius: 16, background: COLORS.successBg,
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
            }}>
              <Ic name="check" size={24} color={COLORS.success} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>
              Purchase Order Created
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: BRAND.accent, marginBottom: 12, fontFamily: FONT.mono }}>
              {result.docno}
            </div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 4 }}>
              {result.supplier || supplier?.name}
            </div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 24 }}>
              {fmt(result.amount || total)}
            </div>
            {result.halal_warnings && result.halal_warnings.length > 0 && (
              <div style={{
                padding: "10px 14px", borderRadius: RADIUS.md,
                background: COLORS.warningBg, color: COLORS.warningDark,
                fontSize: 11, marginBottom: 20, textAlign: "left",
              }}>
                {result.halal_warnings.length} compliance note(s) recorded for audit.
              </div>
            )}
            <button
              onClick={reset}
              style={{
                padding: "12px 28px", borderRadius: RADIUS.lg,
                background: BRAND.accentGradient, color: "#fff",
                fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer",
                boxShadow: SHADOWS.glow,
              }}
            >
              Create Another PO
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ── SUBMITTING state ──────────────────────────────────────
  if (stage === "submitting") {
    return (
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>
              Creating Purchase Order…
            </div>
            <div style={{ fontSize: 13, color: COLORS.textMuted }}>
              Submitting to SQL Account
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // ── COMPOSE state — main two-pane layout ──────────────────
  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      {/* Page header strip */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 20,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: BRAND.accent,
          textTransform: "uppercase", letterSpacing: "0.06em",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <Ic name="cart" size={12} color={BRAND.accent} /> Create Supplier PO
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: "12px 18px", borderRadius: RADIUS.lg,
          background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`,
          color: COLORS.dangerDark, fontSize: 13, marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* Halal warnings interrupt */}
      {stage === "reviewWarnings" && warnings.length > 0 && (
        <WarningsPanel
          warnings={warnings}
          overrideReasons={overrideReasons}
          setOverrideReasons={setOverrideReasons}
          onCancel={() => { setStage("compose"); setWarnings([]); setOverrideReasons({}); }}
          onConfirm={submitWithOverrides}
        />
      )}

      {/* Two-pane grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 420px",
        gap: 20,
        alignItems: "start",
      }}>
        {/* ════════════════════════════════════════════════════ */}
        {/* LEFT PANE — Composer                                  */}
        {/* ════════════════════════════════════════════════════ */}
        <div>
          {/* Supplier card */}
          <Card title="Supplier" subtitle="Pick the supplier this PO is for" style={{ marginBottom: 16 }}>
            <div style={{ padding: "16px 24px" }}>
              {supplier ? (
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "12px 16px", borderRadius: RADIUS.md,
                  background: COLORS.surfaceAlt, border: `1px solid ${COLORS.borderStrong}`,
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>
                      {supplier.name}
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 2, fontFamily: FONT.mono }}>
                      {supplier.code}
                    </div>
                  </div>
                  <button onClick={() => setShowSupplierPicker(true)} style={btnSec}>
                    Change
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowSupplierPicker(true)}
                  style={{
                    width: "100%", padding: "14px 18px",
                    borderRadius: RADIUS.md,
                    border: `1.5px dashed ${COLORS.borderStrong}`,
                    background: COLORS.surface, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                    color: COLORS.textMuted, fontSize: 13, fontWeight: 600,
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = BRAND.accent;
                    e.currentTarget.style.color = BRAND.accent;
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = COLORS.borderStrong;
                    e.currentTarget.style.color = COLORS.textMuted;
                  }}
                >
                  <Ic name="search" size={14} color="currentColor" />
                  Pick supplier
                </button>
              )}
            </div>
          </Card>

          {/* Header fields card */}
          <Card title="PO Details" style={{ marginBottom: 16 }}>
            <div style={{ padding: "16px 24px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <FieldGroup label="Document date" required>
                  <input
                    type="date"
                    value={docdate}
                    onChange={e => setDocdate(e.target.value)}
                    style={inputStyle}
                  />
                </FieldGroup>
                <FieldGroup label="Internal reference">
                  <input
                    value={docref1}
                    onChange={e => setDocref1(e.target.value)}
                    placeholder="Optional — e.g. order ID, your ref"
                    style={inputStyle}
                  />
                </FieldGroup>
              </div>
              <FieldGroup label="Description">
                <input
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Optional"
                  style={inputStyle}
                />
              </FieldGroup>
            </div>
          </Card>

          {/* Line items card */}
          <Card
            title="Line Items"
            subtitle={lines.length === 0 ? "Add at least one item" : `${lines.length} item${lines.length === 1 ? "" : "s"}`}
            action={
              <button
                onClick={() => setShowItemPicker(true)}
                disabled={stockItemsLoading}
                style={{
                  padding: "8px 14px", borderRadius: RADIUS.md,
                  background: stockItemsLoading ? COLORS.borderStrong : BRAND.accent,
                  color: "#fff",
                  fontSize: 12, fontWeight: 600, border: "none",
                  cursor: stockItemsLoading ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                  boxShadow: stockItemsLoading ? "none" : SHADOWS.glow,
                  opacity: stockItemsLoading ? 0.7 : 1,
                }}
              >
                <Ic name="plus" size={12} color="#fff" />
                {stockItemsLoading ? "Loading items…" : "Add Line"}
              </button>
            }
          >
            {lines.length === 0 ? (
              <div style={{ padding: "40px 24px", textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>
                No items added yet. Click <strong>Add Line</strong> to pick from stock items.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Item</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Qty</th>
                    <th style={thStyle}>UOM</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Unit Price</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const isFocused = line.itemcode === focusedItemcode;
                    const lineAmount = (Number(line.qty) || 0) * (Number(line.unitprice) || 0);
                    return (
                      <tr
                        key={i}
                        onClick={() => setFocusedItemcode(line.itemcode)}
                        style={{
                          borderBottom: `1px solid ${COLORS.borderFaint}`,
                          background: isFocused ? COLORS.infoBg : "transparent",
                          cursor: "pointer", transition: "background 0.1s",
                        }}
                      >
                        <td style={tdStyle}>
                          <div style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>
                            {line.itemcode}
                          </div>
                          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 1 }}>
                            {line.description}
                          </div>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <input
                            type="number"
                            value={line.qty}
                            min={0}
                            step="0.01"
                            onClick={e => e.stopPropagation()}
                            onChange={e => updateLine(i, "qty", e.target.value)}
                            style={numInputStyle}
                          />
                        </td>
                        <td style={tdStyle}>
                          <input
                            value={line.uom}
                            onClick={e => e.stopPropagation()}
                            onChange={e => updateLine(i, "uom", e.target.value)}
                            style={{ ...numInputStyle, width: 60, textAlign: "left" }}
                          />
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <input
                            type="number"
                            value={line.unitprice}
                            min={0}
                            step="0.0001"
                            onClick={e => e.stopPropagation()}
                            onChange={e => updateLine(i, "unitprice", e.target.value)}
                            style={numInputStyle}
                          />
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700, fontSize: 12 }}>
                          {fmt(lineAmount)}
                        </td>
                        <td style={tdStyle}>
                          <button
                            onClick={e => { e.stopPropagation(); removeLine(i); }}
                            style={{
                              width: 24, height: 24, borderRadius: 6,
                              border: "none", background: "transparent",
                              cursor: "pointer", color: COLORS.textFaint,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                            onMouseEnter={e => {
                              e.currentTarget.style.background = COLORS.dangerBg;
                              e.currentTarget.style.color = COLORS.dangerDark;
                            }}
                            onMouseLeave={e => {
                              e.currentTarget.style.background = "transparent";
                              e.currentTarget.style.color = COLORS.textFaint;
                            }}
                          >
                            <Ic name="x" size={12} color="currentColor" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${COLORS.borderStrong}` }}>
                    <td colSpan={4} style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14 }}>
                      Total
                    </td>
                    <td style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14, color: BRAND.accent }}>
                      {fmt(total)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Card>

          {/* Submit footer */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
            <button onClick={reset} style={btnSec}>Cancel</button>
            <button
              onClick={() => submitPO()}
              disabled={!supplier || lines.length === 0}
              style={{
                padding: "12px 32px", borderRadius: RADIUS.lg,
                background: BRAND.accentGradient,
                color: "#fff", fontSize: 13, fontWeight: 700,
                border: "none",
                cursor: (!supplier || lines.length === 0) ? "not-allowed" : "pointer",
                opacity: (!supplier || lines.length === 0) ? 0.5 : 1,
                boxShadow: SHADOWS.glow,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <Ic name="send" size={14} color="#fff" />
              Submit Purchase Order
            </button>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════ */}
        {/* RIGHT PANE — Decision Support                         */}
        {/* ════════════════════════════════════════════════════ */}
        <div>
          <SupplierRecentPOs supplierCode={supplier?.code} />
          <ItemPriceHistory itemcode={focusedItemcode} />
        </div>
      </div>

      {/* Modals */}
      {showSupplierPicker && (
        <SupplierPickerModal
          onPick={handleSupplierPick}
          onClose={() => setShowSupplierPicker(false)}
        />
      )}
      {showItemPicker && (
        <StockItemPickerModal
          stockItems={stockItems}
          onPick={handleItemPick}
          onClose={() => setShowItemPicker(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// ── RIGHT-PANE COMPONENT: Supplier Recent POs ───────────────
// ============================================================
function SupplierRecentPOs({ supplierCode }) {
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!supplierCode) {
      setPos([]); setErr(""); setLoading(false);
      return;
    }
    setLoading(true); setErr(""); setPos([]);
    fetchJson(`/api/prospects?type=supplier_recent_pos&code=${encodeURIComponent(supplierCode)}&limit=5`)
      .then(d => { if (!cancelled) setPos(d.pos || []); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [supplierCode]);

  if (!supplierCode) {
    return (
      <Card title="Recent POs" subtitle="Pick a supplier to see history" style={{ marginBottom: 16 }}>
        <div style={{ padding: "30px 24px", textAlign: "center", fontSize: 12, color: COLORS.textFaint }}>
          No supplier selected
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Recent POs"
      subtitle="Last 5 to this supplier (operational PIs)"
      style={{ marginBottom: 16 }}
    >
      {loading && <div style={paneEmptyStyle}>Loading…</div>}
      {err && <div style={{ ...paneEmptyStyle, color: COLORS.dangerDark }}>{err}</div>}
      {!loading && !err && pos.length === 0 && (
        <div style={paneEmptyStyle}>No prior POs found for this supplier.</div>
      )}
      {!loading && !err && pos.length > 0 && (
        <div>
          {pos.map((p, i) => (
            <div
              key={p.docno}
              style={{
                padding: "10px 16px",
                borderBottom: i < pos.length - 1 ? `1px solid ${COLORS.borderFaint}` : "none",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
              }}
            >
              <div>
                <div style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: COLORS.text }}>
                  {p.docno}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 1 }}>
                  {fmtD(p.docdate)} · {p.line_count} line{p.line_count === 1 ? "" : "s"}
                </div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.text }}>
                {fmt(p.amount)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// ── RIGHT-PANE COMPONENT: Item Price History ────────────────
// ============================================================
function ItemPriceHistory({ itemcode }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!itemcode) {
      setData(null); setErr(""); setLoading(false);
      return;
    }
    setLoading(true); setErr(""); setData(null);
    fetchJson(`/api/prospects?type=item_price_history&itemcode=${encodeURIComponent(itemcode)}&limit=5`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [itemcode]);

  if (!itemcode) {
    return (
      <Card title="Item Price History" subtitle="Click a line to inspect">
        <div style={{ padding: "30px 24px", textAlign: "center", fontSize: 12, color: COLORS.textFaint }}>
          No item selected
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Item Price History"
      subtitle={`${itemcode} — last 5 purchases`}
    >
      {loading && <div style={paneEmptyStyle}>Loading…</div>}
      {err && <div style={{ ...paneEmptyStyle, color: COLORS.dangerDark }}>{err}</div>}
      {!loading && !err && data && (
        <div>
          {/* Summary band */}
          {data.summary && data.summary.purchase_count > 0 && (
            <div style={{
              padding: "12px 16px",
              background: COLORS.surfaceAlt,
              borderBottom: `1px solid ${COLORS.borderFaint}`,
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8,
            }}>
              <SummaryStat label="Min" value={data.summary.min_price !== null ? fmt(data.summary.min_price) : "—"} />
              <SummaryStat label="Avg" value={data.summary.avg_price !== null ? fmt(data.summary.avg_price) : "—"} />
              <SummaryStat label="Max" value={data.summary.max_price !== null ? fmt(data.summary.max_price) : "—"} />
            </div>
          )}
          {data.summary && (
            <div style={{
              padding: "8px 16px", fontSize: 10, color: COLORS.textFaint,
              borderBottom: `1px solid ${COLORS.borderFaint}`,
            }}>
              {data.summary.purchase_count} purchase{data.summary.purchase_count === 1 ? "" : "s"}
              {" · "}
              {data.summary.supplier_count} supplier{data.summary.supplier_count === 1 ? "" : "s"}
            </div>
          )}
          {/* Recent rows */}
          {data.recent && data.recent.length === 0 && (
            <div style={paneEmptyStyle}>No purchase history for this item.</div>
          )}
          {data.recent && data.recent.length > 0 && (
            <div>
              {data.recent.map((r, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 16px",
                    borderBottom: i < data.recent.length - 1 ? `1px solid ${COLORS.borderFaint}` : "none",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.text }}>
                      {fmt(r.unitprice)}<span style={{ fontSize: 10, color: COLORS.textFaint, fontWeight: 400 }}> / {r.uom}</span>
                    </div>
                    <div style={{ fontSize: 10, color: COLORS.textFaint }}>
                      {fmtD(r.docdate)}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                    {r.supplier_name}
                  </div>
                  <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 1, display: "flex", gap: 8 }}>
                    <span style={{ fontFamily: FONT.mono }}>{r.docno}</span>
                    <span>·</span>
                    <span>{fmt0(r.qty)} {r.uom}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// ── HALAL WARNINGS PANEL ────────────────────────────────────
// ============================================================
function WarningsPanel({ warnings, overrideReasons, setOverrideReasons, onCancel, onConfirm }) {
  return (
    <Card
      title="Halal Compliance Warnings"
      subtitle="Override required to proceed"
      accent
      style={{ marginBottom: 16, borderColor: COLORS.warning }}
    >
      <div style={{ padding: "16px 24px" }}>
        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 14 }}>
          One or more lines have Halal compliance warnings. Provide a reason for each
          override below — these will be recorded in the audit log alongside the PO.
        </div>
        {warnings.map((w, i) => (
          <div
            key={w.itemcode + i}
            style={{
              padding: "12px 14px", marginBottom: 10,
              borderRadius: RADIUS.md, background: COLORS.warningBg,
              border: `1px solid ${COLORS.warning}33`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 700, color: COLORS.text }}>
                {w.itemcode}
              </div>
              <Pill color={COLORS.warningDark} bg="rgba(255,255,255,0.6)" size="sm">
                {w.warning_level}
              </Pill>
            </div>
            <div style={{ fontSize: 11, color: COLORS.warningDark, marginBottom: 8 }}>
              {w.message || `Halal warning '${w.warning_level}' for this item.`}
            </div>
            <textarea
              value={overrideReasons[w.itemcode] || ""}
              onChange={e => setOverrideReasons(prev => ({ ...prev, [w.itemcode]: e.target.value }))}
              placeholder="Reason for override (required)…"
              rows={2}
              style={{
                width: "100%", padding: "8px 10px", fontSize: 12,
                borderRadius: RADIUS.sm, border: `1px solid ${COLORS.borderStrong}`,
                outline: "none", resize: "vertical", fontFamily: "inherit",
                background: COLORS.surface, color: COLORS.text,
                boxSizing: "border-box",
              }}
            />
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 12 }}>
          <button onClick={onCancel} style={btnSec}>Cancel</button>
          <button
            onClick={onConfirm}
            style={{
              padding: "10px 20px", borderRadius: RADIUS.md,
              background: COLORS.warningDark, color: "#fff",
              fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
            }}
          >
            Submit with overrides
          </button>
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// ── SMALL UTILS ─────────────────────────────────────────────
// ============================================================
function FieldGroup({ label, required, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textMuted, marginBottom: 4 }}>
        {label} {required && <span style={{ color: COLORS.danger }}>*</span>}
      </div>
      {children}
    </div>
  );
}

function SummaryStat({ label, value }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 9, color: COLORS.textFaint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.text, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

// ── Shared style tokens (kept inline for locality) ──────────
const inputStyle = {
  width: "100%", padding: "8px 12px", fontSize: 13,
  borderRadius: RADIUS.sm, border: `1.5px solid ${COLORS.borderStrong}`,
  outline: "none", color: COLORS.text, fontFamily: "inherit",
  background: COLORS.surface,
  boxSizing: "border-box",
};
const numInputStyle = {
  width: 80, padding: "6px 8px", fontSize: 12, fontWeight: 600,
  borderRadius: RADIUS.sm, border: `1px solid ${COLORS.borderStrong}`,
  outline: "none", color: COLORS.text, textAlign: "right",
  background: COLORS.surface,
  boxSizing: "border-box",
};
const btnSec = {
  padding: "8px 16px", borderRadius: RADIUS.md,
  border: `1px solid ${COLORS.borderStrong}`,
  background: COLORS.surface, color: COLORS.textMuted,
  fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const thStyle = {
  padding: "10px 16px", textAlign: "left",
  fontSize: 10, color: COLORS.textFaint, fontWeight: 600,
  letterSpacing: "0.06em", textTransform: "uppercase",
  borderBottom: `1px solid ${COLORS.borderFaint}`,
};
const tdStyle = {
  padding: "10px 16px", fontSize: 12, color: COLORS.text,
};
const paneEmptyStyle = {
  padding: "20px 16px", textAlign: "center", fontSize: 11, color: COLORS.textFaint,
};
