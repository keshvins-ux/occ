// ============================================================
// CREATE DO — Delivery Order creation from active SOs
// Flow: Pick SO → review line items → adjust qty → create DO
// ============================================================

import { useState, useEffect } from "react";
import Card from "../components/Card";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";

export default function CreateDO() {
  const [stage, setStage] = useState("select"); // select | review | submitting | done
  const [sos, setSos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedSO, setSelectedSO] = useState(null);
  const [items, setItems] = useState([]);
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => { loadSOs(); }, []);

  async function loadSOs() {
    setLoading(true);
    try {
      const data = await fetchJson("/api/prospects?type=so_lifecycle&days=180");
      const active = (data.sos || []).filter(s => s.status === "active" || s.status === "partial");
      setSos(active);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function selectSO(so) {
    setSelectedSO(so);
    setError("");
    setItems([]); // clear any previous items
    setStage("review"); // show review immediately with loading state
    // Load SO line items with balances from SQL Account API
    try {
      const balRes = await fetchJson(`/api/create-doc?type=so_balance&docno=${so.docno}`);
      if (balRes.error) {
        setError(`SO balance error: ${balRes.error}`);
        return;
      }
      const rawItems = balRes.items || [];
      if (rawItems.length === 0) {
        setError(`No line items found for ${so.docno}. The SO may not have detail lines in SQL Account.`);
        return;
      }
      const lines = rawItems.filter(l => l.balanceQty > 0).map(l => ({
        itemcode: l.itemcode,
        description: l.description,
        uom: l.uom || "UNIT",
        maxQty: l.balanceQty,
        qty: l.balanceQty,
        unitprice: l.unitprice || 0,
        dtlkey: l.dtlkey,
        selected: true,
      }));
      if (lines.length === 0) {
        setError(`All items in ${so.docno} are fully delivered (balance = 0). No remaining items for DO.`);
        return;
      }
      setItems(lines);
    } catch (e) {
      setError(`Failed to load SO lines: ${e.message}. The SQL Account API may be slow — try again.`);
    }
  }

  function updateQty(idx, val) {
    setItems(prev => {
      const next = [...prev];
      const num = Math.min(Number(val) || 0, next[idx].maxQty);
      next[idx] = { ...next[idx], qty: num };
      return next;
    });
  }

  function toggleItem(idx) {
    setItems(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], selected: !next[idx].selected };
      return next;
    });
  }

  async function submitDO() {
    const selected = items.filter(i => i.selected && i.qty > 0);
    if (selected.length === 0) { setError("No items selected"); return; }

    setStage("submitting");
    setError("");

    try {
      const resp = await fetch("/api/create-doc?type=do", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soDocno: selectedSO.docno,
          soDockey: selectedSO.dockey,
          customerCode: selectedSO.customerCode,
          customerName: selectedSO.customer,
          deliveryDate,
          isPartial: selected.length < items.length || selected.some(i => i.qty < i.maxQty),
          items: selected.map(i => ({
            itemcode: i.itemcode,
            description: i.description,
            qty: i.qty,
            uom: i.uom,
            unitprice: i.unitprice,
            dtlkey: i.dtlkey,
          })),
        }),
      });

      const data = await resp.json();
      if (data.error) { setError(data.error); setStage("review"); return; }
      if (data.duplicate) { setError(data.error || "Duplicate DO"); setStage("review"); return; }

      setResult(data);
      setStage("done");
    } catch (e) {
      setError(e.message);
      setStage("review");
    }
  }

  function reset() {
    setStage("select"); setSelectedSO(null); setItems([]); setError(""); setResult(null);
  }

  const filtered = sos.filter(s =>
    !search ||
    s.docno?.toLowerCase().includes(search.toLowerCase()) ||
    s.customer?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
          <Ic name="package" size={12} color={BRAND.accent} /> Create Delivery Order
        </div>
        {stage !== "select" && <button onClick={reset} style={btnSec}>← Back to SOs</button>}
      </div>

      {error && (
        <div style={{ padding: "12px 18px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, border: `1px solid ${COLORS.danger}22`, color: COLORS.dangerDark, fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {/* ── SELECT SO ──────────────────────────────────────── */}
      {stage === "select" && (
        <Card title="Select Sales Order" subtitle="Pick an active SO to create a delivery order">
          <div style={{ padding: "16px 24px", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SO or customer…"
              style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, outline: "none", background: COLORS.surfaceAlt, color: COLORS.text }} />
          </div>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {loading ? (
              <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>Loading active SOs…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>No active SOs found</div>
            ) : filtered.map(so => (
              <div key={so.docno} onClick={() => selectSO(so)} style={{
                padding: "14px 24px", borderBottom: `1px solid ${COLORS.borderFaint}`, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 16,
                background: "transparent", transition: "background 0.1s",
              }}
                onMouseEnter={e => e.currentTarget.style.background = COLORS.surfaceAlt}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <Avatar name={so.customer} size={36} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#1E3A5F" }}>{so.docno}</span>
                    <Pill color={so.status === "partial" ? COLORS.warningDark : COLORS.infoDark} bg={so.status === "partial" ? COLORS.warningBg : COLORS.infoBg} size="sm">{so.status}</Pill>
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{so.customer}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt(so.amount)}</div>
                  <div style={{ fontSize: 10, color: COLORS.textFaint }}>{fmtD(so.date)}</div>
                </div>
                <Ic name="chevron" size={14} color={COLORS.textFaint} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── REVIEW ITEMS ───────────────────────────────────── */}
      {stage === "review" && selectedSO && (
        <div>
          <Card title={`DO for ${selectedSO.docno}`} subtitle={selectedSO.customer} style={{ marginBottom: 16 }}>
            <div style={{ padding: "16px 24px", display: "flex", gap: 16, alignItems: "center", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
              <div>
                <div style={{ fontSize: 11, color: COLORS.textFaint, fontWeight: 600, textTransform: "uppercase" }}>Delivery Date</div>
                <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: RADIUS.sm, border: `1px solid ${COLORS.borderStrong}`, fontSize: 13, color: COLORS.text, marginTop: 4 }} />
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <div style={{ fontSize: 11, color: COLORS.textFaint }}>Selected items</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: BRAND.accent }}>{items.filter(i => i.selected).length} / {items.length}</div>
              </div>
            </div>
          </Card>

          <Card title="Line Items" subtitle="Toggle items and adjust quantities for this delivery">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thS}>✓</th>
                  <th style={thS}>Item Code</th>
                  <th style={thS}>Description</th>
                  <th style={{ ...thS, textAlign: "right" }}>SO Qty</th>
                  <th style={{ ...thS, textAlign: "right" }}>Deliver Qty</th>
                  <th style={thS}>UOM</th>
                  <th style={{ ...thS, textAlign: "right" }}>Unit Price</th>
                  <th style={{ ...thS, textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item.itemcode + i} style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, opacity: item.selected ? 1 : 0.4 }}>
                    <td style={{ padding: "10px 16px" }}>
                      <input type="checkbox" checked={item.selected} onChange={() => toggleItem(i)} />
                    </td>
                    <td style={{ padding: "10px 16px", fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{item.itemcode}</td>
                    <td style={{ padding: "10px 16px", fontSize: 12, color: COLORS.text }}>{item.description}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt0(item.maxQty)}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                      <input type="number" value={item.qty} min={0} max={item.maxQty}
                        onChange={e => updateQty(i, e.target.value)}
                        style={{ width: 70, padding: "6px 8px", borderRadius: RADIUS.sm, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, fontWeight: 600, textAlign: "right", color: COLORS.text }} />
                    </td>
                    <td style={{ padding: "10px 16px", fontSize: 11, color: COLORS.textMuted }}>{item.uom}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{fmt(item.unitprice)}</td>
                    <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, fontWeight: 700, color: COLORS.text }}>{fmt(item.qty * item.unitprice)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${COLORS.borderStrong}` }}>
                  <td colSpan={7} style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14 }}>Total</td>
                  <td style={{ padding: "14px 16px", textAlign: "right", fontWeight: 700, fontSize: 14, color: BRAND.accent }}>
                    {fmt(items.filter(i => i.selected).reduce((s, i) => s + (i.qty * i.unitprice), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
            <button onClick={reset} style={btnSec}>Cancel</button>
            <button onClick={submitDO} style={{
              padding: "12px 32px", borderRadius: RADIUS.lg, background: BRAND.accentGradient,
              color: "#fff", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer",
              boxShadow: SHADOWS.glow, display: "flex", alignItems: "center", gap: 8,
            }}>
              <Ic name="send" size={14} color="#fff" />
              Create Delivery Order
            </button>
          </div>
        </div>
      )}

      {/* ── SUBMITTING ─────────────────────────────────────── */}
      {stage === "submitting" && (
        <Card>
          <div style={{ padding: "60px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 8 }}>Creating Delivery Order…</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted }}>Submitting to SQL Account</div>
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
            <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Delivery Order Created</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: BRAND.accent, marginBottom: 12, fontFamily: FONT.mono }}>{result.docno}</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 24 }}>{selectedSO?.customer} · {selectedSO?.docno}</div>
            <button onClick={reset} style={{
              padding: "12px 28px", borderRadius: RADIUS.lg, background: BRAND.accentGradient,
              color: "#fff", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer", boxShadow: SHADOWS.glow,
            }}>Create Another DO</button>
          </div>
        </Card>
      )}
    </div>
  );
}

const btnSec = { padding: "8px 16px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, background: COLORS.surface, color: COLORS.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" };
const thS = { padding: "10px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };
