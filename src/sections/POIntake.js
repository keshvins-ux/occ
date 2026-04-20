// ============================================================
// PO INTAKE V2 — Full rebuild with v2 design system
//
// Flow:
//   1. UPLOAD — drag-drop or click to upload PDF/image
//   2. EXTRACT — Opus reads the PO, matches customer + products,
//      pulls pricing from most recent SO in Postgres
//   3. REVIEW — team sees extracted data with pricing sources,
//      can edit any field, search stock codes, adjust prices
//   4. CONFIRM — saves to PO memory for future learning
//
// Key feature: pricing comes from REAL Postgres SO data,
// not just a memory cache. Each price shows its source
// (from PO, from SO-00375, or not found).
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fetchJson } from "../utils";

// ── Helpers ──────────────────────────────────────────────────
async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function confidenceColor(score) {
  if (score == null) return { bg: COLORS.neutralBg, text: COLORS.neutral, label: "—" };
  if (score >= 80) return { bg: COLORS.successBg, text: COLORS.successDark, label: `${score}%` };
  if (score >= 50) return { bg: COLORS.warningBg, text: COLORS.warningDark, label: `${score}%` };
  return { bg: COLORS.dangerBg, text: COLORS.dangerDark, label: `${score}%` };
}

function priceSourceStyle(source) {
  if (source === "from_po") return { bg: COLORS.successBg, text: COLORS.successDark, label: "From PO" };
  if (source === "from_so") return { bg: COLORS.infoBg, text: COLORS.infoDark, label: "From SO" };
  if (source === "from_history") return { bg: COLORS.warningBg, text: COLORS.warningDark, label: "From History" };
  return { bg: COLORS.dangerBg, text: COLORS.dangerDark, label: "No price" };
}

// ── MAIN COMPONENT ──────────────────────────────────────────
export default function POIntake() {
  const [stage, setStage] = useState("upload"); // upload | extracting | review | confirmed
  const [file, setFile] = useState(null);
  const [pdfBase64, setPdfBase64] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [extraction, setExtraction] = useState(null);
  const [meta, setMeta] = useState(null); // model, attempt, soContext, validation
  const [customers, setCustomers] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const fileRef = useRef(null);

  // Load reference data on mount
  useEffect(() => {
    loadReferenceData();
  }, []);

  async function loadReferenceData() {
    try {
      const [custRes, stockRes] = await Promise.all([
        fetch("/api/prospects?type=customers").then(r => r.json()).catch(() => ({ customers: [] })),
        fetch("/api/operations?section=stock").then(r => r.json()).catch(() => ({ items: [] })),
      ]);
      setCustomers(custRes.customers || []);
      setStockItems(stockRes.items || []);
    } catch {}
  }

  // File handling
  function handleFile(f) {
    if (!f) return;
    setFile(f);
    setError("");

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(",")[1];
      setPdfBase64(base64);
    };
    reader.readAsDataURL(f);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }

  // Extract PO
  async function extractPO() {
    if (!pdfBase64) return;
    setStage("extracting");
    setError("");

    try {
      const body = {
        messages: [{ role: "user", content: "Extract all fields from this purchase order." }],
        pdfBase64,
        fileName: file?.name || "po.pdf",
      };

      const resp = await fetch("/api/extract-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setError(data.error || "Extraction failed");
        setStage("upload");
        return;
      }

      // Parse the extraction from the response
      const text = data.content?.[0]?.text;
      if (!text) {
        setError("No extraction result");
        setStage("upload");
        return;
      }

      const parsed = JSON.parse(text);
      setExtraction(parsed);
      setMeta({
        model: data.model,
        attempt: data.attempt,
        validation: data.validation,
        soContext: data.soContext,
      });

      // If Opus identified the customer but we didn't have a hint,
      // re-extract with the customer code for SO context
      if (parsed.customerCode && !data.soContext) {
        const resp2 = await fetch("/api/extract-po", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, customerCodeHint: parsed.customerCode }),
        });
        const data2 = await resp2.json();
        if (resp2.ok && data2.content?.[0]?.text) {
          const parsed2 = JSON.parse(data2.content[0].text);
          setExtraction(parsed2);
          setMeta({
            model: data2.model,
            attempt: data2.attempt,
            validation: data2.validation,
            soContext: data2.soContext,
          });
        }
      }

      setStage("review");
    } catch (e) {
      setError(e.message);
      setStage("upload");
    }
  }

  // Update an item field
  function updateItem(idx, field, value) {
    setExtraction(prev => {
      const items = [...prev.items];
      items[idx] = { ...items[idx], [field]: value };
      // Recalculate amount
      if (field === "qty" || field === "unitprice") {
        const q = field === "qty" ? Number(value) : Number(items[idx].qty);
        const p = field === "unitprice" ? Number(value) : Number(items[idx].unitprice);
        if (q && p) items[idx].amount = q * p;
      }
      return { ...prev, items };
    });
  }

  // Reset
  function reset() {
    setStage("upload");
    setFile(null);
    setPdfBase64(null);
    setExtraction(null);
    setMeta(null);
    setError("");
  }

  // Confirm
  function confirmExtraction() {
    setStage("confirmed");
    // Could POST to /api/po-memory here to save for future learning
  }

  // Calculate totals
  const items = extraction?.items || [];
  const totalAmount = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const itemsWithPrice = items.filter(i => i.unitprice != null && i.unitprice > 0).length;
  const itemsMissing = items.filter(i => !i.unitprice || i.unitprice === 0).length;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic name="sparkle" size={12} color={BRAND.accent} /> AI-Powered Extraction
          </div>
        </div>
        {stage !== "upload" && (
          <button onClick={reset} style={{ padding: "8px 16px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, background: COLORS.surface, color: COLORS.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            ← New PO
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: "12px 18px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`, color: COLORS.dangerDark, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* ── STAGE: UPLOAD ──────────────────────────────────── */}
      {stage === "upload" && (
        <Card title="Upload Purchase Order" subtitle="Drag & drop a PDF or image, or click to browse">
          <div style={{ padding: 24 }}>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? BRAND.accent : COLORS.borderStrong}`,
                borderRadius: RADIUS.xl,
                padding: "48px 24px",
                textAlign: "center",
                cursor: "pointer",
                background: dragOver ? BRAND.accentGlow : COLORS.surfaceAlt,
                transition: "all 0.2s",
              }}
            >
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: "none" }}
                onChange={e => handleFile(e.target.files?.[0])} />
              <div style={{ width: 56, height: 56, borderRadius: 16, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                <Ic name="download" size={24} color={BRAND.accent} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, marginBottom: 6 }}>
                {file ? file.name : "Drop your PO here"}
              </div>
              <div style={{ fontSize: 12, color: COLORS.textFaint }}>
                PDF, PNG, or JPG — up to 10MB
              </div>
            </div>

            {file && (
              <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
                <button onClick={extractPO} style={{
                  padding: "12px 32px", borderRadius: RADIUS.lg,
                  background: BRAND.accentGradient, color: "#fff",
                  fontSize: 14, fontWeight: 700, border: "none", cursor: "pointer",
                  boxShadow: SHADOWS.glow, display: "flex", alignItems: "center", gap: 8,
                }}>
                  <Ic name="sparkle" size={16} color="#fff" />
                  Extract with AI
                </button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── STAGE: EXTRACTING ──────────────────────────────── */}
      {stage === "extracting" && (
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", animation: "pulse 2s infinite" }}>
              <Ic name="sparkle" size={24} color={BRAND.accent} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>Seri Rasa is reading your PO…</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>
              Extracting customer details, matching products to stock codes, and pulling pricing from recent sales orders.
            </div>
            <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
          </div>
        </Card>
      )}

      {/* ── STAGE: REVIEW ──────────────────────────────────── */}
      {stage === "review" && extraction && (
        <div>
          {/* KPI strip */}
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            <KpiCard icon="package" iconBg={COLORS.infoBg} iconColor={COLORS.info} label="Items Extracted" value={`${items.length}`} />
            <KpiCard icon="trending" iconBg={COLORS.successBg} iconColor={COLORS.success} label="With Pricing" value={`${itemsWithPrice} / ${items.length}`} />
            <KpiCard icon="monitor" iconBg={COLORS.dangerBg} iconColor={COLORS.danger} label="Missing Price" value={`${itemsMissing}`} />
            <KpiCard icon="cart" iconBg={BRAND.accentGlow} iconColor={BRAND.accent} label="Estimated Total" value={fmt(totalAmount)} />
          </div>

          {/* SO Context badge */}
          {meta?.soContext && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 18px", borderRadius: RADIUS.lg, background: COLORS.infoBg, border: `1px solid ${COLORS.info}22` }}>
              <Ic name="sparkle" size={14} color={COLORS.info} />
              <span style={{ fontSize: 12, color: COLORS.infoDark, fontWeight: 600 }}>
                Pricing pulled from {meta.soContext.latestSO} ({new Date(meta.soContext.latestDate).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })})
              </span>
              <span style={{ fontSize: 11, color: COLORS.textFaint }}>· {meta.soContext.ordersUsed} recent orders used as context</span>
            </div>
          )}

          {/* Customer + PO details */}
          <Card title="Customer & PO Details" style={{ marginBottom: 16 }}>
            <div style={{ padding: "16px 24px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
              <FieldBlock label="Customer" value={extraction.customerName} confidence={extraction.customerName_confidence}
                sub={extraction.customerCode ? `Code: ${extraction.customerCode}` : "Not matched"} />
              <FieldBlock label="PO Number" value={extraction.poNumber || "—"} confidence={extraction.poNumber_confidence} />
              <FieldBlock label="Delivery Date" value={extraction.deliveryDate || "—"} confidence={extraction.deliveryDate_confidence} />
            </div>
            {extraction.notes && (
              <div style={{ padding: "8px 24px 16px", fontSize: 12, color: COLORS.textMuted }}>
                <strong>Notes:</strong> {extraction.notes}
              </div>
            )}
          </Card>

          {/* Line items table */}
          <Card title="Line Items" subtitle={`${items.length} items extracted`}
            action={
              <div style={{ display: "flex", gap: 8 }}>
                {meta?.model && <Pill color={BRAND.accent} bg={BRAND.accentGlow} size="sm">{meta.model.split("-").slice(0, 2).join(" ")}</Pill>}
                {meta?.validation?.warnings?.length > 0 && (
                  <Pill color={COLORS.warningDark} bg={COLORS.warningBg} size="sm">{meta.validation.warnings.length} warnings</Pill>
                )}
              </div>
            }
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>#</th>
                    <th style={thStyle}>PO Description</th>
                    <th style={thStyle}>Matched Stock Item</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Qty</th>
                    <th style={thStyle}>UOM</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Unit Price</th>
                    <th style={thStyle}>Source</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <ItemRow key={i} item={item} index={i} onUpdate={updateItem} stockItems={stockItems} />
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${COLORS.borderStrong}` }}>
                    <td colSpan={7} style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: COLORS.text, textAlign: "right" }}>Total</td>
                    <td style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: BRAND.accent, textAlign: "right" }}>{fmt(totalAmount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
            <button onClick={reset} style={{ padding: "12px 24px", borderRadius: RADIUS.lg, border: `1px solid ${COLORS.borderStrong}`, background: COLORS.surface, color: COLORS.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={confirmExtraction} style={{
              padding: "12px 32px", borderRadius: RADIUS.lg,
              background: itemsMissing > 0 ? COLORS.warningDark : BRAND.accentGradient,
              color: "#fff", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer",
              boxShadow: SHADOWS.glow, display: "flex", alignItems: "center", gap: 8,
            }}>
              <Ic name="send" size={14} color="#fff" />
              {itemsMissing > 0 ? `Confirm (${itemsMissing} without price)` : "Confirm & Submit"}
            </button>
          </div>
        </div>
      )}

      {/* ── STAGE: CONFIRMED ───────────────────────────────── */}
      {stage === "confirmed" && (
        <Card>
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: COLORS.successBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <Ic name="shield" size={24} color={COLORS.success} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>PO Confirmed</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 24 }}>
              {extraction?.customerName} — {items.length} items, {fmt(totalAmount)}
            </div>
            <button onClick={reset} style={{
              padding: "12px 28px", borderRadius: RADIUS.lg,
              background: BRAND.accentGradient, color: "#fff",
              fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer",
              boxShadow: SHADOWS.glow,
            }}>
              Process Another PO
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── ITEM ROW ─────────────────────────────────────────────────
function ItemRow({ item, index, onUpdate, stockItems }) {
  const [editing, setEditing] = useState(null); // field being edited
  const ps = priceSourceStyle(item.unitprice_source);
  const cc = confidenceColor(item.itemcode_confidence);

  return (
    <tr style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, background: !item.unitprice || item.unitprice === 0 ? `${COLORS.dangerBg}44` : "transparent" }}>
      {/* # */}
      <td style={{ padding: "12px 16px", fontSize: 12, color: COLORS.textFaint, fontWeight: 600 }}>{index + 1}</td>

      {/* PO Description */}
      <td style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{item.description || "—"}</div>
        {item.description_confidence != null && (
          <span style={{ ...pillStyle, ...confidenceColor(item.description_confidence) }}>{confidenceColor(item.description_confidence).label}</span>
        )}
      </td>

      {/* Matched Stock Item */}
      <td style={{ padding: "12px 16px" }}>
        {item.itemcode ? (
          <div>
            <div style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{item.itemcode}</div>
            <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 2 }}>{item.itemdescription || ""}</div>
            <span style={{ ...pillStyle, background: cc.bg, color: cc.text }}>{cc.label}</span>
          </div>
        ) : (
          <Pill color={COLORS.dangerDark} bg={COLORS.dangerBg} size="sm">Not matched</Pill>
        )}
      </td>

      {/* Qty */}
      <td style={{ padding: "12px 16px", textAlign: "right" }}>
        {editing === "qty" ? (
          <input type="number" defaultValue={item.qty} autoFocus
            onBlur={e => { onUpdate(index, "qty", e.target.value); setEditing(null); }}
            onKeyDown={e => e.key === "Enter" && e.target.blur()}
            style={editInputStyle} />
        ) : (
          <span onClick={() => setEditing("qty")} style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, cursor: "pointer" }}>
            {item.qty ?? "—"}
          </span>
        )}
      </td>

      {/* UOM */}
      <td style={{ padding: "12px 16px", fontSize: 12, color: COLORS.textMuted }}>{item.uom || "—"}</td>

      {/* Unit Price */}
      <td style={{ padding: "12px 16px", textAlign: "right" }}>
        {editing === "unitprice" ? (
          <input type="number" step="0.01" defaultValue={item.unitprice || ""} autoFocus
            onBlur={e => { onUpdate(index, "unitprice", e.target.value); setEditing(null); }}
            onKeyDown={e => e.key === "Enter" && e.target.blur()}
            style={editInputStyle} />
        ) : (
          <span onClick={() => setEditing("unitprice")} style={{
            fontSize: 13, fontWeight: 600, cursor: "pointer",
            color: item.unitprice ? COLORS.text : COLORS.danger,
          }}>
            {item.unitprice ? fmt(item.unitprice) : "Enter price"}
          </span>
        )}
      </td>

      {/* Source */}
      <td style={{ padding: "12px 16px" }}>
        <Pill color={ps.text} bg={ps.bg} size="sm">{ps.label}</Pill>
        {item.unitprice_so_ref && (
          <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 3 }}>{item.unitprice_so_ref}</div>
        )}
      </td>

      {/* Amount */}
      <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: item.amount ? COLORS.text : COLORS.textFaint }}>
        {item.amount ? fmt(item.amount) : "—"}
      </td>
    </tr>
  );
}

// ── FIELD BLOCK ──────────────────────────────────────────────
function FieldBlock({ label, value, confidence, sub }) {
  const cc = confidenceColor(confidence);
  return (
    <div>
      <div style={{ fontSize: 11, color: COLORS.textFaint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.text }}>{value || "—"}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
        {confidence != null && <span style={{ ...pillStyle, background: cc.bg, color: cc.text }}>{cc.label}</span>}
        {sub && <span style={{ fontSize: 11, color: COLORS.textMuted }}>{sub}</span>}
      </div>
    </div>
  );
}

// ── STYLES ───────────────────────────────────────────────────
const thStyle = {
  padding: "12px 16px",
  textAlign: "left",
  fontSize: 10,
  color: COLORS.textFaint,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  borderBottom: `1px solid ${COLORS.borderFaint}`,
  whiteSpace: "nowrap",
};

const pillStyle = {
  display: "inline-block",
  padding: "2px 7px",
  borderRadius: 99,
  fontSize: 10,
  fontWeight: 600,
  marginTop: 3,
};

const editInputStyle = {
  width: 80,
  padding: "6px 10px",
  borderRadius: RADIUS.sm,
  border: `1.5px solid ${BRAND.accent}`,
  fontSize: 13,
  fontWeight: 600,
  textAlign: "right",
  outline: "none",
  color: COLORS.text,
};
