// ============================================================
// CREATE INVOICE — Invoice creation from completed DOs
// Flow: Pick DO (linked to SO) → review items → create Invoice
// ============================================================

import { useState, useEffect } from "react";
import Card from "../components/Card";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";

export default function CreateInvoice() {
  const [stage, setStage] = useState("select"); // select | review | submitting | done
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => { loadEntries(); }, []);

  async function loadEntries() {
    setLoading(true);
    try {
      // Load document tracker to find DOs without invoices
      const data = await fetchJson("/api/prospects?type=document_tracker");
      const pendingInv = (data.entries || []).filter(e =>
        e.chain === "pending_invoice" && e.dos.length > 0
      );
      setEntries(pendingInv);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function selectEntry(entry) {
    setSelectedEntry(entry);
    setError("");
    setItems([]);
    setStage("review"); // show review with loading state

    try {
      const balRes = await fetchJson(`/api/create-doc?type=so_balance&docno=${entry.soNo}`);
      if (balRes.error) {
        setError(`Could not load SO lines: ${balRes.error}`);
        return;
      }
      const rawItems = balRes.items || [];
      if (rawItems.length === 0) {
        setError(`No line items found for ${entry.soNo}. Cannot create invoice without line items.`);
        return;
      }
      const lines = rawItems.map(l => ({
        itemcode: l.itemcode,
        description: l.description,
        uom: l.uom || "UNIT",
        qty: Number(l.originalQty || l.qty || 0),
        unitprice: Number(l.unitprice || 0),
      })).filter(l => l.qty > 0);

      if (lines.length === 0) {
        setError(`All items in ${entry.soNo} have zero quantity. Cannot create invoice.`);
        return;
      }
      setItems(lines);
    } catch (e) {
      setError(`Failed to load SO lines for invoice: ${e.message}. SQL Account API may be slow — try again.`);
    }
  }

  function updateItem(idx, field, value) {
    setItems(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: Number(value) || 0 };
      return next;
    });
  }

  async function submitInvoice() {
    if (items.length === 0) { setError("No items"); return; }

    setStage("submitting");
    setError("");

    try {
      const resp = await fetch("/api/create-doc?type=invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soDocno: selectedEntry.soNo,
          customerCode: selectedEntry.customerCode,
          customerName: selectedEntry.customer,
          poNumber: selectedEntry.poRef,
          items: items.map(i => ({
            itemcode: i.itemcode,
            description: i.description,
            qty: i.qty,
            uom: i.uom,
            unitprice: i.unitprice,
          })),
        }),
      });

      const data = await resp.json();
      if (data.error) { setError(data.error); setStage("review"); return; }
      if (data.duplicate) { setError(data.error || "Invoice already exists"); setStage("review"); return; }

      setResult(data);
      setStage("done");
    } catch (e) {
      setError(e.message);
      setStage("review");
    }
  }

  function reset() {
    setStage("select"); setSelectedEntry(null); setItems([]); setError(""); setResult(null);
    loadEntries(); // refresh the list
  }

  const totalAmount = items.reduce((s, i) => s + (i.qty * i.unitprice), 0);

  const filtered = entries.filter(e =>
    !search ||
    e.soNo?.toLowerCase().includes(search.toLowerCase()) ||
    e.customer?.toLowerCase().includes(search.toLowerCase()) ||
    e.dos?.some(d => d.docno?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
          <Ic name="monitor" size={12} color={BRAND.accent} /> Create Invoice
        </div>
        {stage !== "select" && <button onClick={reset} style={btnSec}>← Back</button>}
      </div>

      {error && (
        <div style={{ padding: "12px 18px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`, color: COLORS.dangerDark, fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {/* ── SELECT ENTRY ───────────────────────────────────── */}
      {stage === "select" && (
        <Card title="Select Delivered Order" subtitle="Pick a DO that's ready to be invoiced (has DO, no invoice yet)">
          <div style={{ padding: "16px 24px", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SO, customer, or DO…"
              style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, outline: "none", background: COLORS.surfaceAlt, color: COLORS.text }} />
          </div>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>No DOs pending invoice</div>
            ) : filtered.map(e => (
              <div key={e.soDockey} onClick={() => selectEntry(e)} style={{
                padding: "14px 24px", borderBottom: `1px solid ${COLORS.borderFaint}`, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 16,
              }}
                onMouseEnter={ev => ev.currentTarget.style.background = COLORS.surfaceAlt}
                onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>
                <Avatar name={e.customer} size={36} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#1E3A5F" }}>{e.soNo}</span>
                    <Pill color={COLORS.successDark} bg={COLORS.successBg} size="sm" dot>
                      DO: {e.dos.map(d => d.docno).join(", ")}
                    </Pill>
                    <Pill color={COLORS.dangerDark} bg={COLORS.dangerBg} size="sm">No Invoice</Pill>
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{e.customer}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt(e.amount)}</div>
                  <div style={{ fontSize: 10, color: COLORS.textFaint }}>{fmtD(e.date)}</div>
                </div>
                <Ic name="chevron" size={14} color={COLORS.textFaint} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── REVIEW ITEMS ───────────────────────────────────── */}
      {stage === "review" && selectedEntry && (
        <div>
          <Card title={`Invoice for ${selectedEntry.soNo}`} subtitle={`${selectedEntry.customer} · DO: ${selectedEntry.dos.map(d => d.docno).join(", ")}`} style={{ marginBottom: 16 }} />

          <Card title="Line Items">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thS}>Item Code</th>
                  <th style={thS}>Description</th>
                  <th style={{ ...thS, textAlign: "right" }}>Qty</th>
                  <th style={thS}>UOM</th>
                  <th style={{ ...thS, textAlign: "right" }}>Unit Price</th>
                  <th style={{ ...thS, textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item.itemcode + i} style={{ borderBottom: `1px solid ${COLORS.borderFaint}` }}>
                    <td style={{ padding: "10px 16px", fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{item.itemcode}</td>
                    <td style={{ padding: "10px 16px", fontSize: 12, color: COLORS.text }}>{item.description}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                      <input type="number" value={item.qty} min={0}
                        onChange={e => updateItem(i, "qty", e.target.value)}
                        style={{ width: 70, padding: "6px 8px", borderRadius: RADIUS.sm, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, fontWeight: 600, textAlign: "right", color: COLORS.text }} />
                    </td>
                    <td style={{ padding: "10px 16px", fontSize: 11, color: COLORS.textMuted }}>{item.uom}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                      <input type="number" step="0.01" value={item.unitprice} min={0}
                        onChange={e => updateItem(i, "unitprice", e.target.value)}
                        style={{ width: 90, padding: "6px 8px", borderRadius: RADIUS.sm, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, fontWeight: 600, textAlign: "right", color: COLORS.text }} />
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, fontWeight: 700, color: COLORS.text }}>{fmt(item.qty * item.unitprice)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${COLORS.borderStrong}` }}>
                  <td colSpan={5} style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14 }}>Total</td>
                  <td style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14, color: BRAND.accent }}>{fmt(totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </Card>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
            <button onClick={reset} style={btnSec}>Cancel</button>
            <button onClick={submitInvoice} style={{
              padding: "12px 32px", borderRadius: RADIUS.lg, background: BRAND.accentGradient,
              color: "#fff", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer",
              boxShadow: SHADOWS.glow, display: "flex", alignItems: "center", gap: 8,
            }}>
              <Ic name="send" size={14} color="#fff" />
              Create Invoice
            </button>
          </div>
        </div>
      )}

      {/* ── SUBMITTING ─────────────────────────────────────── */}
      {stage === "submitting" && (
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>Creating Invoice…</div>
          </div>
        </Card>
      )}

      {/* ── DONE ───────────────────────────────────────────── */}
      {stage === "done" && result && (
        <Card>
          <div style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: COLORS.successBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <Ic name="shield" size={24} color={COLORS.success} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Invoice Created</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: BRAND.accent, marginBottom: 12, fontFamily: FONT.mono }}>{result.docno}</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 24 }}>
              {selectedEntry?.customer} · {selectedEntry?.soNo}
              {result.alreadyExisted && <span style={{ color: COLORS.warningDark }}> (already existed — linked)</span>}
            </div>
            <button onClick={reset} style={{
              padding: "12px 28px", borderRadius: RADIUS.lg, background: BRAND.accentGradient,
              color: "#fff", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer", boxShadow: SHADOWS.glow,
            }}>Create Another Invoice</button>
          </div>
        </Card>
      )}
    </div>
  );
}

const btnSec = { padding: "8px 16px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, background: COLORS.surface, color: COLORS.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" };
const thS = { padding: "10px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };
