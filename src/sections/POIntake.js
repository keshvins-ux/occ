// ============================================================
// PO INTAKE V2 — Fully wired end-to-end
//
// Flow:
//   1. Upload PDF/image OR paste text (WhatsApp/email)
//   2. AI extracts customer, items, matches stock codes
//   3. Pulls pricing from customer's most recent SO in Postgres
//   4. Team reviews — edits stock item, qty, UOM, price
//   5. Submit → creates SO in SQL Account via /api/create-doc?type=so
//   6. Saves to PO memory for future learning
//   7. Shows history of past submissions
// ============================================================

import { useState, useEffect, useRef } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Ic from "../components/Ic";
import CustomerPickerModal from "../components/CustomerPickerModal";
import StockItemPickerModal from "../components/StockItemPickerModal";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt } from "../utils";
import { useAuth } from "../contexts/AuthContext";
import config from "../config";

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

// Valid UOMs — sourced from actual sql_so_lines data in SQL Account (not assumed)
const UOM_OPTIONS = ["UNIT", "CTN", "BAG", "CARTON", "KG", "PKT"];

// Auto-correct common UOM abbreviations from customer POs
const UOM_MAP = {
  // KG variants
  KG: "KG", KILOGRAM: "KG", KGS: "KG", KILO: "KG",
  // CTN variants
  CTN: "CTN", CRTN: "CTN",
  // CARTON (separate UOM in SQL Account, not same as CTN)
  CARTON: "CARTON", CARTONS: "CARTON",
  // BAG variants
  BAG: "BAG", BAGS: "BAG", BG: "BAG", BEG: "BAG",
  // PKT variants
  PKT: "PKT", PACKET: "PKT", PK: "PKT", PT: "PKT", PCK: "PKT",
  // UNIT — default for everything else
  UNIT: "UNIT", UNITS: "UNIT", UN: "UNIT", TU: "UNIT", TUB: "UNIT",
  EA: "UNIT", EACH: "UNIT", JC: "UNIT", PCS: "UNIT", PIECE: "UNIT",
  PIECES: "UNIT", PC: "UNIT", BTL: "UNIT", BOTTLE: "UNIT", BOX: "UNIT",
  SET: "UNIT", TIN: "UNIT",
};
function normalizeUOM(raw) {
  if (!raw) return "UNIT";
  const upper = String(raw).toUpperCase().trim();
  return UOM_MAP[upper] || (UOM_OPTIONS.includes(upper) ? upper : "UNIT");
}

// ── MAIN COMPONENT ──────────────────────────────────────────
export default function POIntake() {
  const { user } = useAuth();
  const [stage, setStage] = useState("upload"); // upload | extracting | review | submitting | done | error
  const [inputMode, setInputMode] = useState("document");
  const [file, setFile] = useState(null);
  const [pdfBase64, setPdfBase64] = useState(null);
  const [pasteText, setPasteText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [extraction, setExtraction] = useState(null);
  const [outlets, setOutlets] = useState([]);
  const [selectedOutlet, setSelectedOutlet] = useState(null);
  const [meta, setMeta] = useState(null);
  const [stockItems, setStockItems] = useState([]);
  const [soResult, setSoResult] = useState(null);
  // Fix #2: Confirmation modal state — shown before submit when items would be dropped
  const [confirmDrop, setConfirmDrop] = useState(null); // { droppedItems: [], onProceed }
  // PR (B): Find-or-create modals
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [stockPickerForRow, setStockPickerForRow] = useState(null); // index of row needing match, or null
  const fileRef = useRef(null);

  useEffect(() => { loadStockItems(); }, []);

  // Fix #8: Source stock items from the new v2 endpoint instead of
  // /api/operations?section=stock which never actually responded to that
  // section param — was silently returning [] for the entire feature lifetime,
  // which is why the stock-item dropdown for matching items was empty.
  async function loadStockItems() {
    try {
      const r = await fetch("/api/prospects?type=stock_items").then(r => r.json()).catch(() => ({}));
      setStockItems(r.items || []);
    } catch {}
  }

  function handleFile(f) {
    if (!f) return;
    setFile(f); setError("");
    const reader = new FileReader();
    reader.onload = (e) => setPdfBase64(e.target.result.split(",")[1]);
    reader.readAsDataURL(f);
  }

  function handleDrop(e) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }

  // ── EXTRACT PO ─────────────────────────────────────────────
  async function extractPO() {
    if (inputMode === "document" && !pdfBase64) return;
    if (inputMode === "text" && !pasteText.trim()) return;
    setStage("extracting"); setError("");

    try {
      const body = inputMode === "document"
        ? { messages: [{ role: "user", content: "Extract all fields from this purchase order." }], pdfBase64, fileName: file?.name || "po.pdf" }
        : { messages: [{ role: "user", content: pasteText.trim() }] };

      const resp = await fetch("/api/extract-po", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await resp.json();
      if (!resp.ok) { setError(data.error || "Extraction failed"); setStage("upload"); return; }

      const text = data.content?.[0]?.text;
      if (!text) { setError("No extraction result"); setStage("upload"); return; }

      const parsed = JSON.parse(text);
      // Auto-correct UOMs from customer abbreviations (PT→PKT, TU→UNIT, etc.)
      if (parsed.items) parsed.items = parsed.items.map(i => ({ ...i, uom: normalizeUOM(i.uom) }));
      // Remove any error/warning messages the AI may have included in its response
      if (parsed.error) delete parsed.error;
      if (parsed.warning) delete parsed.warning;
      setExtraction(parsed);
      setError(""); // Clear any previous error
      setMeta({ model: data.model, attempt: data.attempt, validation: data.validation, soContext: data.soContext });

      // Fetch customer outlets/branches if customer was identified
      if (parsed.customerName) {
        try {
          const outletRes = await fetch(`/api/prospects?type=customer_outlets&name=${encodeURIComponent(parsed.customerName)}`);
          const outletData = await outletRes.json();
          if (outletData.outlets?.length > 1) {
            setOutlets(outletData.outlets);
            // If extraction already matched a code, pre-select it
            if (parsed.customerCode) {
              setSelectedOutlet(parsed.customerCode);
            }
          } else {
            setOutlets([]);
          }
        } catch { setOutlets([]); }
      }

      // Re-extract with customer code hint for SO pricing context
      if (parsed.customerCode && !data.soContext) {
        const resp2 = await fetch("/api/extract-po", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, customerCodeHint: parsed.customerCode }) });
        const data2 = await resp2.json();
        if (resp2.ok && data2.content?.[0]?.text) {
          const parsed2 = JSON.parse(data2.content[0].text);
          if (parsed2.items) parsed2.items = parsed2.items.map(i => ({ ...i, uom: normalizeUOM(i.uom) }));
          if (parsed2.error) delete parsed2.error;
          if (parsed2.warning) delete parsed2.warning;
          setExtraction(parsed2);
          setError(""); // Clear any error from first pass
          setMeta({ model: data2.model, attempt: data2.attempt, validation: data2.validation, soContext: data2.soContext });
        }
      }
      setStage("review");
    } catch (e) { setError(e.message); setStage("upload"); }
  }

  // ── SUBMIT SO to SQL Account ───────────────────────────────
  async function submitSO() {
    if (!extraction?.customerCode) { setError("Customer code not matched — please select a customer before submitting."); return; }

    const items = extraction.items || [];
    const itemsWithCode = items.filter(i => i.itemcode);
    if (itemsWithCode.length === 0) { setError("No items with stock codes — match at least one item before submitting."); return; }

    const zeroPrice = itemsWithCode.filter(i => !i.unitprice || Number(i.unitprice) === 0);
    if (zeroPrice.length > 0) { setError(`${zeroPrice.length} item(s) have no price. Please enter prices before submitting.`); return; }

    // Fix #2: If any items are unmatched, they will be silently dropped from the SO.
    // Show a confirmation modal listing them so the team can't miss it.
    const droppedItems = items.filter(i => !i.itemcode);
    if (droppedItems.length > 0) {
      setConfirmDrop({
        droppedItems: droppedItems.map(i => ({
          description: i.description || "(no description)",
          qty: i.qty ?? "—",
          uom: i.uom || "—",
        })),
        onProceed: () => {
          setConfirmDrop(null);
          doSubmit(itemsWithCode);
        },
        onCancel: () => setConfirmDrop(null),
      });
      return;
    }

    // No items being dropped — submit straight away.
    doSubmit(itemsWithCode);
  }

  // The actual submit work, invoked either directly or after the confirm modal.
  async function doSubmit(itemsWithCode) {
    setStage("submitting"); setError("");

    try {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

      // Fix #6: who submitted this — pulled from auth context, falls back to a generic label.
      const submittedBy = user?.name || user?.email || "OCC User";

      const soPayload = {
        code: extraction.customerCode,
        docdate: todayStr,
        description: "Sales Order via PO Intake",
        docref1: extraction.poNumber || "",
        docref2: extraction.deliveryDate ? "DD: " + extraction.deliveryDate.split("-").reverse().join("/") : "",
        note: extraction.notes || "",
        sdsdocdetail: itemsWithCode.map((item, idx) => ({
          itemcode: item.itemcode,
          description: item.itemdescription || item.description,
          qty: Number(item.qty || 0),
          uom: normalizeUOM(item.uom),
          unitprice: Number(item.unitprice || 0),
          amount: Number(item.amount || 0),
          deliverydate: extraction.deliveryDate || todayStr,
          // Fix #11: use tenant config instead of hardcoded 'SW'.
          location: config.defaultLocation || "SW",
          seq: (idx + 1) * 1000,
        })),
      };

      const totalAmount = itemsWithCode.reduce((s, i) => s + (Number(i.amount) || 0), 0);

      const poMeta = {
        customerName: extraction.customerName,
        customerCode: extraction.customerCode,
        poNumber: extraction.poNumber,
        totalAmount,
        submittedBy,
        submittedAt: new Date().toISOString(),
        items: itemsWithCode,
      };

      const resp = await fetch("/api/create-doc?type=so", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soPayload, poMeta }),
      });

      const result = await resp.json();

      if (result.duplicate) {
        setError(`Duplicate: ${result.error}`);
        setStage("review");
        return;
      }

      if (result.error) {
        setError(result.error);
        setStage("review");
        return;
      }

      setSoResult(result);
      setStage("done");

      // Save to PO memory for future learning
      try {
        await fetch("/api/po-memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_code: extraction.customerCode,
            po_number: extraction.poNumber,
            extracted: extraction,
            // Fix #6: same source as submittedBy above.
            confirmed_by: submittedBy,
          }),
        });
      } catch {} // non-critical

    } catch (e) {
      setError(e.message);
      setStage("review");
    }
  }

  function updateItem(idx, field, value) {
    setExtraction(prev => {
      const items = [...prev.items];
      items[idx] = { ...items[idx], [field]: value };
      if (field === "qty" || field === "unitprice") {
        const q = field === "qty" ? Number(value) : Number(items[idx].qty);
        const p = field === "unitprice" ? Number(value) : Number(items[idx].unitprice);
        items[idx].amount = (q && p) ? q * p : null;
      }
      if (field === "itemcode") {
        const match = stockItems.find(s => s.code === value);
        if (match) items[idx].itemdescription = match.description;
      }
      return { ...prev, items };
    });
  }

  function removeItem(idx) {
    setExtraction(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }));
  }

  function addItem() {
    setExtraction(prev => ({
      ...prev,
      items: [...(prev.items || []), { description: "", itemcode: "", itemdescription: "", qty: 1, uom: "KG", unitprice: 0, amount: 0, unitprice_source: "not_found" }],
    }));
  }

  function reset() {
    setStage("upload"); setFile(null); setPdfBase64(null); setPasteText("");
    setExtraction(null); setMeta(null); setError(""); setSoResult(null);
  }

  // PR (B): Customer picker callback. Called when team picks an existing
  // customer or finishes creating a new one. Updates extraction.customerCode
  // and clears the outlet selector since the picked code is canonical.
  function onCustomerPicked({ code, name }) {
    setExtraction(prev => ({
      ...prev,
      customerCode: code,
      customerName: name || prev.customerName,
      customerName_confidence: 100, // user-confirmed = max confidence
    }));
    setOutlets([]);
    setSelectedOutlet(code);
    setCustomerPickerOpen(false);
    setError("");
  }

  // PR (B): Stock item picker callback. Updates the specific row that triggered
  // the picker. If a brand-new item was created, it's added to the in-memory
  // stockItems list so subsequent dropdowns include it without a refetch.
  function onStockItemPicked({ code, description, defuom_st }) {
    if (stockPickerForRow == null) return;
    const rowIdx = stockPickerForRow;

    // Add to local stockItems if it's not already there (newly created case)
    setStockItems(prev => {
      if (prev.some(s => s.code === code)) return prev;
      return [...prev, { code, description: description || "", uom_code: defuom_st || "" }];
    });

    setExtraction(prev => {
      const items = [...prev.items];
      items[rowIdx] = {
        ...items[rowIdx],
        itemcode:       code,
        itemdescription: description || items[rowIdx].itemdescription || "",
        // Use the new item's default UOM if the row doesn't have one set
        uom: items[rowIdx].uom || defuom_st || "UNIT",
      };
      return { ...prev, items };
    });

    setStockPickerForRow(null);
  }

  const items = extraction?.items || [];
  const totalAmount = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const itemsWithPrice = items.filter(i => i.unitprice != null && i.unitprice > 0).length;
  const itemsMissing = items.filter(i => !i.unitprice || Number(i.unitprice) === 0).length;
  const itemsUnmatched = items.filter(i => !i.itemcode).length;
  const canExtract = inputMode === "document" ? !!pdfBase64 : pasteText.trim().length > 10;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* ── PR (B): Customer Picker Modal ────────────────────── */}
      {customerPickerOpen && (
        <CustomerPickerModal
          prefilledName={extraction?.customerName}
          prefilledAddress={extraction?.customerAddress || null}
          onPick={onCustomerPicked}
          onClose={() => setCustomerPickerOpen(false)}
        />
      )}

      {/* ── PR (B): Stock Item Picker Modal ──────────────────── */}
      {stockPickerForRow != null && (
        <StockItemPickerModal
          stockItems={stockItems}
          prefilledDescription={extraction?.items?.[stockPickerForRow]?.description || ""}
          onPick={onStockItemPicked}
          onClose={() => setStockPickerForRow(null)}
        />
      )}

      {/* ── CONFIRMATION MODAL: items being dropped (Fix #2) ─── */}
      {confirmDrop && (
        <div
          onClick={confirmDrop.onCancel}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(15, 23, 42, 0.45)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: COLORS.surface, borderRadius: RADIUS.xl,
              maxWidth: 560, width: "100%",
              boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${COLORS.borderFaint}`, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: COLORS.warningBg, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Ic name="alert" size={20} color={COLORS.warningDark} />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>
                  {confirmDrop.droppedItems.length} item{confirmDrop.droppedItems.length === 1 ? "" : "s"} will be excluded
                </div>
                <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>
                  These items have no stock code matched and won't be on the Sales Order.
                </div>
              </div>
            </div>

            {/* Dropped items list */}
            <div style={{ padding: "16px 24px", maxHeight: 320, overflowY: "auto" }}>
              {confirmDrop.droppedItems.map((d, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 14px",
                    background: `${COLORS.dangerBg}66`,
                    borderRadius: RADIUS.md,
                    marginBottom: 8,
                    borderLeft: `3px solid ${COLORS.danger}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, flex: 1 }}>
                    {d.description}
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: FONT.mono, whiteSpace: "nowrap" }}>
                    {d.qty} {d.uom}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer note + actions */}
            <div style={{ padding: "16px 24px", background: COLORS.surfaceAlt, borderTop: `1px solid ${COLORS.borderFaint}` }}>
              <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
                If the customer asked for these, go back and click the red "Click to match" pill on each row to pick the correct stock code. If we genuinely don't sell them, you can proceed without them.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={confirmDrop.onCancel} style={btnSec}>
                  Go back &amp; fix
                </button>
                <button
                  onClick={confirmDrop.onProceed}
                  style={{ ...btnPrimary, background: COLORS.warningDark }}
                >
                  Proceed without {confirmDrop.droppedItems.length} item{confirmDrop.droppedItems.length === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
          <Ic name="sparkle" size={12} color={BRAND.accent} /> AI-Powered Extraction
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {stage !== "upload" && stage !== "done" && (
            <button onClick={reset} style={btnSec}>← New PO</button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: "12px 18px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`, color: COLORS.dangerDark, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <Ic name="x" size={14} color={COLORS.danger} />
          {error}
        </div>
      )}

      {/* ── UPLOAD ────────────────────────────────────────── */}
      {stage === "upload" && (
        <Card title="Submit Purchase Order" subtitle="Upload a document or paste text from WhatsApp / email">
          <div style={{ padding: 24 }}>
            {/* Mode tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, background: COLORS.surfaceAlt, borderRadius: RADIUS.lg, padding: 4, width: "fit-content" }}>
              {[["document", "Upload Document"], ["text", "Paste Text"]].map(([k, l]) => (
                <button key={k} onClick={() => setInputMode(k)} style={{
                  padding: "9px 20px", borderRadius: RADIUS.md, border: "none", cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  background: inputMode === k ? COLORS.surface : "transparent",
                  color: inputMode === k ? BRAND.accent : COLORS.textMuted,
                  boxShadow: inputMode === k ? SHADOWS.card : "none",
                }}>{l}</button>
              ))}
            </div>

            {inputMode === "document" && (
              <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop} onClick={() => fileRef.current?.click()}
                style={{ border: `2px dashed ${dragOver ? BRAND.accent : COLORS.borderStrong}`, borderRadius: RADIUS.xl, padding: "48px 24px", textAlign: "center", cursor: "pointer", background: dragOver ? BRAND.accentGlow : COLORS.surfaceAlt }}>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" style={{ display: "none" }} onChange={e => handleFile(e.target.files?.[0])} />
                <div style={{ width: 56, height: 56, borderRadius: 16, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                  <Ic name="download" size={24} color={BRAND.accent} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, marginBottom: 6 }}>{file ? file.name : "Drop your PO here"}</div>
                <div style={{ fontSize: 12, color: COLORS.textFaint }}>PDF, PNG, or JPG — up to 10MB</div>
              </div>
            )}

            {inputMode === "text" && (
              <div>
                <textarea value={pasteText} onChange={e => setPasteText(e.target.value)}
                  placeholder={"Paste the PO content here…\n\nExample:\nHi, please prepare the following order:\n1. Chilli Powder 100kg\n2. Turmeric Powder 50kg\n3. Black Pepper 25kg\nDelivery by 25 April.\nThank you,\nIndia Gate Centre Kitchen"}
                  style={{ width: "100%", minHeight: 200, padding: 16, borderRadius: RADIUS.lg, border: `1.5px solid ${pasteText.trim() ? BRAND.accent : COLORS.borderStrong}`, fontSize: 13, lineHeight: 1.7, color: COLORS.text, resize: "vertical", outline: "none", fontFamily: "inherit", background: COLORS.surfaceAlt }} />
                <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 6 }}>Paste a WhatsApp message, email body, or any text containing order details</div>
              </div>
            )}

            {canExtract && (
              <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
                <button onClick={extractPO} style={btnPrimary}><Ic name="sparkle" size={16} color="#fff" /> Extract with AI</button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── EXTRACTING ────────────────────────────────────── */}
      {stage === "extracting" && (
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: BRAND.accentGlow, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", animation: "pulse 2s infinite" }}>
              <Ic name="sparkle" size={24} color={BRAND.accent} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>{config.tenantName} is reading your PO…</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>Extracting customer details, matching products to stock codes, and pulling pricing from recent sales orders.</div>
            <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
          </div>
        </Card>
      )}

      {/* ── SUBMITTING ────────────────────────────────────── */}
      {stage === "submitting" && (
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: COLORS.successBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", animation: "pulse 2s infinite" }}>
              <Ic name="send" size={24} color={COLORS.success} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>Creating Sales Order in SQL Account…</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted }}>This usually takes 3-5 seconds.</div>
          </div>
        </Card>
      )}

      {/* ── REVIEW ────────────────────────────────────────── */}
      {stage === "review" && extraction && (
        <div>
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            <KpiCard icon="package" iconBg={COLORS.infoBg} iconColor={COLORS.info} label="Items Extracted" value={`${items.length}`} />
            <KpiCard icon="trending" iconBg={COLORS.successBg} iconColor={COLORS.success} label="With Pricing" value={`${itemsWithPrice} / ${items.length}`} />
            <KpiCard icon="monitor" iconBg={COLORS.dangerBg} iconColor={COLORS.danger} label="Missing Price" value={`${itemsMissing}`} />
            <KpiCard icon="cart" iconBg={BRAND.accentGlow} iconColor={BRAND.accent} label="Estimated Total" value={fmt(totalAmount)} />
          </div>

          {meta?.soContext && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 18px", borderRadius: RADIUS.lg, background: COLORS.infoBg, border: `1px solid ${COLORS.info}22` }}>
              <Ic name="sparkle" size={14} color={COLORS.info} />
              <span style={{ fontSize: 12, color: COLORS.infoDark, fontWeight: 600 }}>Pricing pulled from {meta.soContext.latestSO} ({new Date(meta.soContext.latestDate).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })})</span>
              <span style={{ fontSize: 11, color: COLORS.textFaint }}>· {meta.soContext.ordersUsed} recent orders used as context</span>
            </div>
          )}

          <Card
            title="Customer & PO Details"
            style={{ marginBottom: 16 }}
            action={
              <button
                onClick={() => setCustomerPickerOpen(true)}
                style={{
                  padding: "6px 12px", borderRadius: RADIUS.md,
                  border: `1px solid ${COLORS.borderStrong}`,
                  background: COLORS.surface, color: COLORS.textMuted,
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <Ic name="userPlus" size={12} color={COLORS.textMuted} />
                Find or create customer
              </button>
            }
          >
            {/* Prominent prompt when customer didn't match — biggest UX gap fixed by PR (B) */}
            {!extraction.customerCode && (
              <div style={{
                margin: "0 24px", marginTop: 16, padding: "14px 18px",
                borderRadius: RADIUS.lg, background: COLORS.warningBg,
                border: `1.5px solid ${COLORS.warning}`,
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.warningDark }}>
                    Customer not in SQL Account yet
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.warningDark, marginTop: 3, opacity: 0.85 }}>
                    AI extracted "{extraction.customerName || 'unknown'}" but couldn't find a matching record. Search existing customers or create a new one.
                  </div>
                </div>
                <button
                  onClick={() => setCustomerPickerOpen(true)}
                  style={{
                    padding: "10px 18px", borderRadius: RADIUS.md,
                    background: COLORS.warningDark, color: "#fff",
                    fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                    whiteSpace: "nowrap",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <Ic name="userPlus" size={14} color="#fff" />
                  Find or create customer
                </button>
              </div>
            )}
            <div style={{ padding: "16px 24px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
              <FieldBlock label="Customer" value={extraction.customerName} confidence={extraction.customerName_confidence} sub={extraction.customerCode ? `Code: ${extraction.customerCode}` : "Not matched — cannot submit"} />
              <FieldBlock label="PO Number" value={extraction.poNumber || "—"} confidence={extraction.poNumber_confidence} />
              <FieldBlock label="Delivery Date" value={extraction.deliveryDate || "—"} confidence={extraction.deliveryDate_confidence} />
            </div>
            {outlets.length > 1 && (
              <div style={{ padding: "0 24px 16px", borderTop: `1px solid ${COLORS.borderFaint}`, marginTop: 4, paddingTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                  Select Outlet / Branch
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {outlets.map(o => (
                    <button key={o.code} onClick={() => {
                      setSelectedOutlet(o.code);
                      setExtraction(prev => ({ ...prev, customerCode: o.code, customerName: o.name + (o.outlet ? ` ${o.outlet}` : '') }));
                    }} style={{
                      padding: "10px 16px", borderRadius: RADIUS.lg, cursor: "pointer",
                      border: selectedOutlet === o.code ? `2px solid ${BRAND.accent}` : `1px solid ${COLORS.borderStrong}`,
                      background: selectedOutlet === o.code ? BRAND.accentGlow : COLORS.surface,
                      transition: "all 0.15s",
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: selectedOutlet === o.code ? BRAND.accent : COLORS.text }}>{o.name}</div>
                      {o.outlet && <div style={{ fontSize: 11, color: selectedOutlet === o.code ? BRAND.accent : COLORS.textMuted, marginTop: 2 }}>{o.outlet}</div>}
                      <div style={{ fontSize: 10, fontFamily: FONT.mono, color: COLORS.textFaint, marginTop: 2 }}>{o.code}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card title="Line Items" subtitle={`${items.length} items · click any cell to edit`}
            action={
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={addItem} style={{ ...btnSec, fontSize: 11, padding: "6px 12px" }}>+ Add item</button>
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
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <ItemRow
                      key={i}
                      item={item}
                      index={i}
                      onUpdate={updateItem}
                      onRemove={removeItem}
                      stockItems={stockItems}
                      onOpenStockPicker={(rowIdx) => setStockPickerForRow(rowIdx)}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${COLORS.borderStrong}` }}>
                    <td colSpan={7} style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: COLORS.text, textAlign: "right" }}>Total</td>
                    <td style={{ padding: "14px 20px", fontSize: 14, fontWeight: 700, color: BRAND.accent, textAlign: "right" }}>{fmt(totalAmount)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {/* Validation warnings */}
          {(!extraction.customerCode || itemsMissing > 0 || itemsUnmatched > 0) && (
            <div style={{ marginTop: 16, padding: "12px 18px", borderRadius: RADIUS.lg, background: COLORS.warningBg, border: `1px solid ${COLORS.warning}22`, fontSize: 12, color: COLORS.warningDark }}>
              {!extraction.customerCode && <div>⚠ Customer not matched — select a customer code to submit.</div>}
              {itemsMissing > 0 && <div>⚠ {itemsMissing} item(s) missing price — all items need prices before submitting.</div>}
              {itemsUnmatched > 0 && <div>⚠ {itemsUnmatched} item(s) not matched to stock codes — these will be excluded from the SO.</div>}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
            <button onClick={reset} style={btnSec}>Cancel</button>
            <button onClick={submitSO} disabled={!extraction.customerCode || itemsMissing > 0}
              style={{
                ...btnPrimary,
                opacity: (!extraction.customerCode || itemsMissing > 0) ? 0.5 : 1,
                cursor: (!extraction.customerCode || itemsMissing > 0) ? "not-allowed" : "pointer",
              }}>
              <Ic name="send" size={14} color="#fff" />
              Create Sales Order ({items.filter(i => i.itemcode).length} items · {fmt(totalAmount)})
            </button>
          </div>
        </div>
      )}

      {/* ── DONE ──────────────────────────────────────────── */}
      {stage === "done" && soResult && (
        <Card>
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: COLORS.successBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <Ic name="shield" size={24} color={COLORS.success} />
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Sales Order Created</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: BRAND.accent, marginBottom: 12, fontFamily: FONT.mono }}>{soResult.docno}</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 4 }}>{soResult.customerName}</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 24 }}>{soResult.itemCount} items · {fmt(soResult.totalAmount)}</div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button onClick={reset} style={btnPrimary}>Process Another PO</button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── ITEM ROW ─────────────────────────────────────────────────
function ItemRow({ item, index, onUpdate, onRemove, stockItems, onOpenStockPicker }) {
  const [editing, setEditing] = useState(null);
  const [stockSearch, setStockSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const ps = priceSourceStyle(item.unitprice_source);

  const filtered = stockSearch.trim()
    ? stockItems.filter(s => s.code?.toLowerCase().includes(stockSearch.toLowerCase()) || s.description?.toLowerCase().includes(stockSearch.toLowerCase())).slice(0, 10)
    : stockItems.slice(0, 10);

  function selectStock(s) { onUpdate(index, "itemcode", s.code); setShowDropdown(false); setStockSearch(""); setEditing(null); }

  // PR (B): Open the full stock picker modal — used when no good match in the
  // inline dropdown and the team needs to either search more thoroughly or
  // create a new stock item entirely.
  function openPicker() {
    setShowDropdown(false);
    setEditing(null);
    if (onOpenStockPicker) onOpenStockPicker(index, item.description || "");
  }

  return (
    <tr style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, background: (!item.unitprice || Number(item.unitprice) === 0) ? `${COLORS.dangerBg}44` : "transparent" }}>
      <td style={td}><span style={{ fontSize: 12, color: COLORS.textFaint, fontWeight: 600 }}>{index + 1}</span></td>

      {/* PO Description */}
      <td style={td}><div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{item.description || "—"}</div></td>

      {/* Stock Item — searchable dropdown */}
      <td style={{ ...td, position: "relative" }}>
        {editing === "itemcode" ? (
          <div>
            <input autoFocus value={stockSearch} onChange={e => { setStockSearch(e.target.value); setShowDropdown(true); }}
              onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => { setShowDropdown(false); setEditing(null); }, 200)}
              placeholder="Search code or name…" style={{ ...editWide, textAlign: "left" }} />
            {showDropdown && (
              <div style={{ position: "absolute", top: "100%", left: 12, right: 12, zIndex: 50, background: COLORS.surface, borderRadius: RADIUS.lg, border: `1px solid ${COLORS.borderStrong}`, boxShadow: SHADOWS.dropdown, maxHeight: 280, overflowY: "auto" }}>
                {filtered.map(s => (
                  <div key={s.code} onMouseDown={() => selectStock(s)} style={{ padding: "8px 14px", cursor: "pointer", borderBottom: `1px solid ${COLORS.borderFaint}`, fontSize: 12 }}>
                    <span style={{ fontFamily: FONT.mono, fontWeight: 600, color: "#1E3A5F" }}>{s.code}</span>
                    <span style={{ color: COLORS.textMuted, marginLeft: 8 }}>{s.description}</span>
                  </div>
                ))}
                {filtered.length === 0 && stockSearch.trim() && (
                  <div style={{ padding: "10px 14px", fontSize: 11, color: COLORS.textMuted, fontStyle: "italic" }}>
                    No matches for "{stockSearch}"
                  </div>
                )}
                {/* PR (B): Always offer "Create new" as the last option */}
                <div
                  onMouseDown={openPicker}
                  style={{
                    padding: "10px 14px", cursor: "pointer", fontSize: 12,
                    background: COLORS.surfaceAlt, color: BRAND.accent, fontWeight: 700,
                    display: "flex", alignItems: "center", gap: 6,
                    borderTop: `1px solid ${COLORS.borderStrong}`,
                  }}
                >
                  <Ic name="plusCircle" size={12} color={BRAND.accent} />
                  Find more or create new stock item…
                </div>
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

      {/* Qty */}
      <td style={{ ...td, textAlign: "right" }}>
        {editing === "qty" ? (
          <input type="number" defaultValue={item.qty} autoFocus onBlur={e => { onUpdate(index, "qty", e.target.value); setEditing(null); }}
            onKeyDown={e => e.key === "Enter" && e.target.blur()} style={editSm} />
        ) : (
          <span onClick={() => setEditing("qty")} style={clickable}>{item.qty ?? "—"}</span>
        )}
      </td>

      {/* UOM */}
      <td style={td}>
        {editing === "uom" ? (
          <select autoFocus value={item.uom || "KG"} onChange={e => { onUpdate(index, "uom", e.target.value); setEditing(null); }} onBlur={() => setEditing(null)}
            style={{ padding: "6px 8px", borderRadius: RADIUS.sm, border: `1.5px solid ${BRAND.accent}`, fontSize: 12, fontWeight: 600, outline: "none", color: COLORS.text, background: COLORS.surface }}>
            {UOM_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        ) : (
          <span onClick={() => setEditing("uom")} style={{ ...clickable, color: COLORS.textMuted }}>{item.uom || "KG"}</span>
        )}
      </td>

      {/* Unit Price */}
      <td style={{ ...td, textAlign: "right" }}>
        {editing === "unitprice" ? (
          <input type="number" step="0.01" defaultValue={item.unitprice || ""} autoFocus
            onBlur={e => { onUpdate(index, "unitprice", e.target.value); setEditing(null); }}
            onKeyDown={e => e.key === "Enter" && e.target.blur()} style={editSm} />
        ) : (
          <span onClick={() => setEditing("unitprice")} style={{ ...clickable, color: item.unitprice ? COLORS.text : COLORS.danger }}>
            {item.unitprice ? fmt(item.unitprice) : "Enter price"}
          </span>
        )}
      </td>

      {/* Source */}
      <td style={td}>
        <Pill color={ps.text} bg={ps.bg} size="sm">{ps.label}</Pill>
        {item.unitprice_so_ref && <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 3 }}>{item.unitprice_so_ref}</div>}
      </td>

      {/* Amount */}
      <td style={{ ...td, textAlign: "right", fontSize: 13, fontWeight: 700, color: item.amount ? COLORS.text : COLORS.textFaint }}>{item.amount ? fmt(item.amount) : "—"}</td>

      {/* Remove */}
      <td style={td}>
        <button onClick={() => onRemove(index)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 4 }} title="Remove item">
          <Ic name="x" size={12} color={COLORS.textFaint} />
        </button>
      </td>
    </tr>
  );
}

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
const thStyle = { padding: "12px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}`, whiteSpace: "nowrap" };
const td = { padding: "12px 16px", verticalAlign: "middle" };
const editSm = { width: 90, padding: "6px 10px", borderRadius: RADIUS.sm, border: `1.5px solid ${BRAND.accent}`, fontSize: 13, fontWeight: 600, textAlign: "right", outline: "none", color: COLORS.text };
const editWide = { width: "100%", padding: "7px 12px", borderRadius: RADIUS.sm, border: `1.5px solid ${BRAND.accent}`, fontSize: 12, fontWeight: 500, outline: "none", color: COLORS.text };
const clickable = { fontSize: 13, fontWeight: 600, color: COLORS.text, cursor: "pointer", padding: "4px 8px", borderRadius: RADIUS.xs };
const btnPrimary = { padding: "12px 32px", borderRadius: RADIUS.lg, background: BRAND.accentGradient, color: "#fff", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer", boxShadow: SHADOWS.glow, display: "flex", alignItems: "center", gap: 8 };
const btnSec = { padding: "8px 16px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, background: COLORS.surface, color: COLORS.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" };
