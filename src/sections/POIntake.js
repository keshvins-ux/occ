// ============================================================
// PO INTAKE V2 — Full rebuild
//
// Upload options: Document upload OR paste text (WhatsApp/email)
// Review: Stock Item (searchable dropdown), Qty, UOM (dropdown),
//         Price — all editable inline
// ============================================================

import { useState, useEffect, useRef } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt } from "../utils";

// ── Helpers ──────────────────────────────────────────────────
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

const UOM_OPTIONS = ["KG", "CTN", "PKT", "UNIT", "PCS", "BAG", "BTL", "SET", "BOX", "TIN"];

// ── MAIN COMPONENT ──────────────────────────────────────────
export default function POIntake() {
  const [stage, setStage] = useState("upload"); // upload | extracting | review | confirmed
  const [inputMode, setInputMode] = useState("document"); // document | text
  const [file, setFile] = useState(null);
  const [pdfBase64, setPdfBase64] = useState(null);
  const [pasteText, setPasteText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [extraction, setExtraction] = useState(null);
  const [meta, setMeta] = useState(null);
  const [stockItems, setStockItems] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => { loadStockItems(); }, []);

  async function loadStockItems() {
    try {
      const r = await fetch("/api/operations?section=stock").then(r => r.json()).catch(() => ({ items: [] }));
      setStockItems(r.items || r.stock || []);
    } catch {}
  }

  // File handling
  function handleFile(f) {
    if (!f) return;
    setFile(f);
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => setPdfBase64(e.target.result.split(",")[1]);
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
    if (inputMode === "document" && !pdfBase64) return;
    if (inputMode === "text" && !pasteText.trim()) return;

    setStage("extracting");
    setError("");

    try {
      const body = inputMode === "document"
        ? {
            messages: [{ role: "user", content: "Extract all fields from this purchase order." }],
            pdfBase64,
            fileName: file?.name || "po.pdf",
          }
        : {
            messages: [{ role: "user", content: pasteText.trim() }],
          };

      const resp = await fetch("/api/extract-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await resp.json();
      if (!resp.ok) { setError(data.error || "Extraction failed"); setStage("upload"); return; }

      const text = data.content?.[0]?.text;
      if (!text) { setError("No extraction result"); setStage("upload"); return; }

      const parsed = JSON.parse(text);
      setExtraction(parsed);
      setMeta({ model: data.model, attempt: data.attempt, validation: data.validation, soContext: data.soContext });

      // If customer was identified but no SO context, re-extract with the hint
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
          setMeta({ model: data2.model, attempt: data2.attempt, validation: data2.validation, soContext: data2.soContext });
        }
      }

      setStage("review");
    } catch (e) {
      setError(e.message);
      setStage("upload");
    }
  }

  // Update item field + recalc amount
  function updateItem(idx, field, value) {
    setExtraction(prev => {
      const items = [...prev.items];
      items[idx] = { ...items[idx], [field]: value };
      if (field === "qty" || field === "unitprice") {
        const q = field === "qty" ? Number(value) : Number(items[idx].qty);
        const p = field === "unitprice" ? Number(value) : Number(items[idx].unitprice);
        if (q && p) items[idx].amount = q * p;
        else items[idx].amount = null;
      }
      // If stock item changed, update itemdescription too
      if (field === "itemcode") {
        const match = stockItems.find(s => s.code === value);
        if (match) items[idx].itemdescription = match.description;
      }
      return { ...prev, items };
    });
  }

  function reset() {
    setStage("upload"); setFile(null); setPdfBase64(null); setPasteText("");
    setExtraction(null); setMeta(null); setError("");
  }

  function confirmExtraction() { setStage("confirmed"); }

  const items = extraction?.items || [];
  const totalAmount = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const itemsWithPrice = items.filter(i => i.unitprice != null && i.unitprice > 0).length;
  const itemsMissing = items.filter(i => !i.unitprice || i.unitprice === 0).length;

  const canExtract = inputMode === "document" ? !!pdfBase64 : pasteText.trim().length > 10;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
          <Ic name="sparkle" size={12} color={BRAND.accent} /> AI-Powered Extraction
        </div>
        {stage !== "upload" && (
          <button onClick={reset} style={btnSecondary}>← New PO</button>
        )}
      </div>

      {error && (
        <div style={{ padding: "12px 18px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`, color: COLORS.dangerDark, fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {/* ── UPLOAD STAGE ──────────────────────────────────── */}
      {stage === "upload" && (
        <Card title="Submit Purchase Order" subtitle="Upload a document or paste text from WhatsApp / email">
          <div style={{ padding: 24 }}>
            {/* Input mode tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, background: COLORS.surfaceAlt, borderRadius: RADIUS.lg, padding: 4, width: "fit-content" }}>
              {[["document", "Upload Document"], ["text", "Paste Text"]].map(([k, l]) => (
                <button key={k} onClick={() => setInputMode(k)} style={{
                  padding: "9px 20px", borderRadius: RADIUS.md, border: "none", cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  background: inputMode === k ? COLORS.surface : "transparent",
                  color: inputMode === k ? BRAND.accent : COLORS.textMuted,
                  boxShadow: inputMode === k ? SHADOWS.card : "none",
                  transition: "all 0.15s",
                }}>{l}</button>
              ))}
            </div>

            {/* Document upload */}
            {inputMode === "document" && (
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? BRAND.accent : COLORS.borderStrong}`,
                  borderRadius: RADIUS.xl, padding: "48px 24px", textAlign: "center",
                  cursor: "pointer", background: dragOver ? BRAND.accentGlow : COLORS.surfaceAlt,
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
                <div style={{ fontSize: 12, color: COLORS.textFaint }}>PDF, PNG, or JPG — up to 10MB</div>
              </div>
            )}

            {/* Paste text */}
            {inputMode === "text" && (
              <div>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder={"Paste the PO content here…\n\nExample:\nHi, please prepare the following order:\n1. Chilli Powder 100kg\n2. Turmeric Powder 50kg\n3. Black Pepper 25kg\nDelivery by 25 April.\nThank you,\nIndia Gate Centre Kitchen"}
                  style={{
                    width: "100%", minHeight: 200, padding: 16, borderRadius: RADIUS.lg,
                    border: `1.5px solid ${pasteText.trim() ? BRAND.accent : COLORS.borderStrong}`,
                    fontSize: 13, lineHeight: 1.7, color: COLORS.text, resize: "vertical",
                    outline: "none", fontFamily: "inherit", background: COLORS.surfaceAlt,
                  }}
                />
                <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 6 }}>
                  Paste a WhatsApp message, email body, or any text containing order details
                </div>
              </div>
            )}

            {/* Extract button */}
            {canExtract && (
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

      {/* ── EXTRACTING STAGE ──────────────────────────────── */}
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

      {/* ── REVIEW STAGE ──────────────────────────────────── */}
      {stage === "review" && extraction && (
        <div>
          {/* KPIs */}
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            <KpiCard icon="package" iconBg={COLORS.infoBg} iconColor={COLORS.info} label="Items Extracted" value={`${items.length}`} />
            <KpiCard icon="trending" iconBg={COLORS.successBg} iconColor={COLORS.success} label="With Pricing" value={`${itemsWithPrice} / ${items.length}`} />
            <KpiCard icon="monitor" iconBg={COLORS.dangerBg} iconColor={COLORS.danger} label="Missing Price" value={`${itemsMissing}`} />
            <KpiCard icon="cart" iconBg={BRAND.accentGlow} iconColor={BRAND.accent} label="Estimated Total" value={fmt(totalAmount)} />
          </div>

          {/* SO context badge */}
          {meta?.soContext && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 18px", borderRadius: RADIUS.lg, background: COLORS.infoBg, border: `1px solid ${COLORS.info}22` }}>
              <Ic name="sparkle" size={14} color={COLORS.info} />
              <span style={{ fontSize: 12, color: COLORS.infoDark, fontWeight: 600 }}>
                Pricing pulled from {meta.soContext.latestSO} ({new Date(meta.soContext.latestDate).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })})
              </span>
              <span style={{ fontSize: 11, color: COLORS.textFaint }}>· {meta.soContext.ordersUsed} recent orders used as context</span>
            </div>
          )}

          {/* Customer & PO details */}
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

          {/* Line items */}
          <Card title="Line Items" subtitle={`${items.length} items · click any cell to edit`}
            action={
              <div style={{ display: "flex", gap: 8 }}>
                {meta?.model && <Pill color={BRAND.accent} bg={BRAND.accentGlow} size="sm">{meta.model.split("-").slice(0, 2).join(" ")}</Pill>}
              </div>
            }
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>#</th>
                    <th style={thStyle}>PO Description</th>
                    <th style={{ ...thStyle, minWidth: 200 }}>Stock Item</th>
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
            <button onClick={reset} style={btnSecondary}>Cancel</button>
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

      {/* ── CONFIRMED STAGE ───────────────────────────────── */}
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
              fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer", boxShadow: SHADOWS.glow,
            }}>
              Process Another PO
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── ITEM ROW — fully editable ────────────────────────────────
function ItemRow({ item, index, onUpdate, stockItems }) {
  const [editing, setEditing] = useState(null); // which field is being edited
  const [stockSearch, setStockSearch] = useState("");
  const [showStockDropdown, setShowStockDropdown] = useState(false);
  const ps = priceSourceStyle(item.unitprice_source);

  // Filtered stock items for dropdown
  const filteredStock = stockSearch.trim()
    ? stockItems.filter(s =>
        s.code?.toLowerCase().includes(stockSearch.toLowerCase()) ||
        s.description?.toLowerCase().includes(stockSearch.toLowerCase())
      ).slice(0, 10)
    : stockItems.slice(0, 10);

  function selectStock(s) {
    onUpdate(index, "itemcode", s.code);
    setShowStockDropdown(false);
    setStockSearch("");
    setEditing(null);
  }

  return (
    <tr style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, background: !item.unitprice || item.unitprice === 0 ? `${COLORS.dangerBg}44` : "transparent" }}>
      {/* # */}
      <td style={tdBase}><span style={{ fontSize: 12, color: COLORS.textFaint, fontWeight: 600 }}>{index + 1}</span></td>

      {/* PO Description (read-only — what the customer wrote) */}
      <td style={tdBase}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{item.description || "—"}</div>
      </td>

      {/* Stock Item — editable with searchable dropdown */}
      <td style={{ ...tdBase, position: "relative" }}>
        {editing === "itemcode" ? (
          <div>
            <input
              autoFocus
              value={stockSearch}
              onChange={e => { setStockSearch(e.target.value); setShowStockDropdown(true); }}
              onFocus={() => setShowStockDropdown(true)}
              onBlur={() => setTimeout(() => { setShowStockDropdown(false); setEditing(null); }, 200)}
              placeholder="Search stock code or name…"
              style={{ ...editInputWide, textAlign: "left" }}
            />
            {showStockDropdown && filteredStock.length > 0 && (
              <div style={{
                position: "absolute", top: "100%", left: 12, right: 12, zIndex: 50,
                background: COLORS.surface, borderRadius: RADIUS.lg, border: `1px solid ${COLORS.borderStrong}`,
                boxShadow: SHADOWS.dropdown, maxHeight: 220, overflowY: "auto",
              }}>
                {filteredStock.map(s => (
                  <div key={s.code} onMouseDown={() => selectStock(s)} style={{
                    padding: "8px 14px", cursor: "pointer", borderBottom: `1px solid ${COLORS.borderFaint}`,
                    fontSize: 12,
                  }}>
                    <span style={{ fontFamily: FONT.mono, fontWeight: 600, color: "#1E3A5F" }}>{s.code}</span>
                    <span style={{ color: COLORS.textMuted, marginLeft: 8 }}>{s.description}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div onClick={() => { setEditing("itemcode"); setStockSearch(item.itemcode || ""); }} style={{ cursor: "pointer" }}>
            {item.itemcode ? (
              <div>
                <div style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{item.itemcode}</div>
                <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 2 }}>{item.itemdescription || ""}</div>
              </div>
            ) : (
              <Pill color={COLORS.dangerDark} bg={COLORS.dangerBg} size="sm">Click to match</Pill>
            )}
          </div>
        )}
      </td>

      {/* Qty — editable */}
      <td style={{ ...tdBase, textAlign: "right" }}>
        {editing === "qty" ? (
          <input type="number" defaultValue={item.qty} autoFocus
            onBlur={e => { onUpdate(index, "qty", e.target.value); setEditing(null); }}
            onKeyDown={e => e.key === "Enter" && e.target.blur()}
            style={editInput} />
        ) : (
          <span onClick={() => setEditing("qty")} style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, cursor: "pointer", padding: "4px 8px", borderRadius: RADIUS.xs, background: "transparent" }}
            onMouseEnter={e => e.target.style.background = COLORS.surfaceAlt}
            onMouseLeave={e => e.target.style.background = "transparent"}>
            {item.qty ?? "—"}
          </span>
        )}
      </td>

      {/* UOM — editable dropdown */}
      <td style={tdBase}>
        {editing === "uom" ? (
          <select autoFocus value={item.uom || "KG"}
            onChange={e => { onUpdate(index, "uom", e.target.value); setEditing(null); }}
            onBlur={() => setEditing(null)}
            style={{ padding: "6px 8px", borderRadius: RADIUS.sm, border: `1.5px solid ${BRAND.accent}`, fontSize: 12, fontWeight: 600, outline: "none", color: COLORS.text, background: COLORS.surface }}
          >
            {UOM_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        ) : (
          <span onClick={() => setEditing("uom")} style={{ fontSize: 12, color: COLORS.textMuted, cursor: "pointer", padding: "4px 8px", borderRadius: RADIUS.xs }}
            onMouseEnter={e => e.target.style.background = COLORS.surfaceAlt}
            onMouseLeave={e => e.target.style.background = "transparent"}>
            {item.uom || "KG"}
          </span>
        )}
      </td>

      {/* Unit Price — editable */}
      <td style={{ ...tdBase, textAlign: "right" }}>
        {editing === "unitprice" ? (
          <input type="number" step="0.01" defaultValue={item.unitprice || ""} autoFocus
            onBlur={e => { onUpdate(index, "unitprice", e.target.value); setEditing(null); }}
            onKeyDown={e => e.key === "Enter" && e.target.blur()}
            style={editInput} />
        ) : (
          <span onClick={() => setEditing("unitprice")} style={{
            fontSize: 13, fontWeight: 600, cursor: "pointer",
            color: item.unitprice ? COLORS.text : COLORS.danger,
            padding: "4px 8px", borderRadius: RADIUS.xs,
          }}
            onMouseEnter={e => e.target.style.background = COLORS.surfaceAlt}
            onMouseLeave={e => e.target.style.background = "transparent"}>
            {item.unitprice ? fmt(item.unitprice) : "Enter price"}
          </span>
        )}
      </td>

      {/* Source */}
      <td style={tdBase}>
        <Pill color={ps.text} bg={ps.bg} size="sm">{ps.label}</Pill>
        {item.unitprice_so_ref && (
          <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 3 }}>{item.unitprice_so_ref}</div>
        )}
      </td>

      {/* Amount */}
      <td style={{ ...tdBase, textAlign: "right", fontSize: 13, fontWeight: 700, color: item.amount ? COLORS.text : COLORS.textFaint }}>
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
        {confidence != null && <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 600, background: cc.bg, color: cc.text }}>{cc.label}</span>}
        {sub && <span style={{ fontSize: 11, color: COLORS.textMuted }}>{sub}</span>}
      </div>
    </div>
  );
}

// ── STYLES ───────────────────────────────────────────────────
const thStyle = {
  padding: "12px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint,
  fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
  borderBottom: `1px solid ${COLORS.borderFaint}`, whiteSpace: "nowrap",
};

const tdBase = { padding: "12px 16px", verticalAlign: "middle" };

const editInput = {
  width: 90, padding: "6px 10px", borderRadius: RADIUS.sm,
  border: `1.5px solid ${BRAND.accent}`, fontSize: 13, fontWeight: 600,
  textAlign: "right", outline: "none", color: COLORS.text,
};

const editInputWide = {
  width: "100%", padding: "7px 12px", borderRadius: RADIUS.sm,
  border: `1.5px solid ${BRAND.accent}`, fontSize: 12, fontWeight: 500,
  outline: "none", color: COLORS.text,
};

const btnSecondary = {
  padding: "8px 16px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`,
  background: COLORS.surface, color: COLORS.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer",
};
