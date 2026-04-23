// ============================================================
// DOCUMENT TRACKER — SO → DO → Invoice lifecycle tracking
// Shows every SO with its linked DOs and Invoices (via fromdockey)
// Filters: All, Pending Invoice, Pending DO, Pending Both, Complete
// ============================================================

import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, SHADOWS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";

const CHAIN_LABELS = {
  complete: { label: "Complete", color: COLORS.successDark, bg: COLORS.successBg },
  pending_invoice: { label: "Pending Invoice", color: COLORS.warningDark, bg: COLORS.warningBg },
  pending_do: { label: "Pending DO", color: COLORS.infoDark, bg: COLORS.infoBg },
  pending_both: { label: "Pending DO & Invoice", color: COLORS.dangerDark, bg: COLORS.dangerBg },
};

export default function DocumentTracker() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("active");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchJson("/api/prospects?type=document_tracker")
      .then(resp => { setData(resp); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const entries = data?.entries || [];
  const stats = data?.stats || {};

  const filtered = useMemo(() => {
    return entries.filter(e => {
      const matchSearch = !search ||
        e.soNo?.toLowerCase().includes(search.toLowerCase()) ||
        e.customer?.toLowerCase().includes(search.toLowerCase()) ||
        e.poRef?.toLowerCase().includes(search.toLowerCase()) ||
        e.dos?.some(d => d.docno?.toLowerCase().includes(search.toLowerCase())) ||
        e.invoices?.some(i => i.docno?.toLowerCase().includes(search.toLowerCase()));

      if (filter === "pending_invoice") return matchSearch && e.chain === "pending_invoice";
      if (filter === "pending_do") return matchSearch && (e.chain === "pending_do" || e.chain === "pending_both");
      if (filter === "pending_both") return matchSearch && e.chain === "pending_both";
      if (filter === "complete") return matchSearch && e.chain === "complete";
      if (filter === "active") return matchSearch && e.chain !== "complete";
      return matchSearch;
    });
  }, [entries, search, filter]);

  if (loading) return (
    <div style={{ padding: 60, textAlign: "center" }}>
      <div style={{ fontSize: 14, color: COLORS.textMuted }}>Loading document chain…</div>
    </div>
  );

  if (error) return (
    <div style={{ padding: "12px 16px", borderRadius: RADIUS.lg, background: COLORS.dangerBg, color: COLORS.dangerDark, fontSize: 13 }}>{error}</div>
  );

  return (
    <div>
      {/* KPI Strip */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <KpiCard icon="package" iconBg={COLORS.infoBg} iconColor={COLORS.info}
          label="Active SOs" value={fmt0(stats.active || 0)} trend={`${fmt0(stats.total || 0)} total (incl. completed)`} />
        <KpiCard icon="shield" iconBg={COLORS.successBg} iconColor={COLORS.success}
          label="Complete (SO→DO→INV)" value={fmt0(stats.complete || 0)} />
        <KpiCard icon="package" iconBg={BRAND.accentGlow} iconColor={BRAND.accent}
          label="Active SOs" value={fmt0(stats.active || 0)}
          trend={stats.outstanding > 0 ? `${fmt(stats.outstanding)} outstanding` : undefined} />
        <KpiCard icon="alert" iconBg={COLORS.warningBg} iconColor={COLORS.warningDark}
          label="Pending Invoice" value={fmt0(stats.pendingInvoice || 0)} />
        <KpiCard icon="alert" iconBg={COLORS.dangerBg} iconColor={COLORS.danger}
          label="Pending DO & Invoice" value={fmt0(stats.pendingBoth || 0)} />
      </div>

      {/* Filters + Search */}
      <Card>
        <div style={{ padding: "16px 24px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
          {/* Search */}
          <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
            <Ic name="search" size={14} color={COLORS.textFaint} style={{ position: "absolute", left: 12, top: 10 }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SO, customer, DO, invoice…"
              style={{
                width: "100%", padding: "9px 12px 9px 34px", borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, color: COLORS.text,
                outline: "none", background: COLORS.surfaceAlt,
              }}
            />
          </div>

          {/* Filter pills */}
          <div style={{ display: "flex", gap: 4 }}>
            {[
              ["all", `All (${entries.length})`],
              ["active", `Active (${entries.filter(e => e.chain !== "complete").length})`],
              ["pending_both", `Pending Both (${stats.pendingBoth || 0})`],
              ["pending_invoice", `Pending INV (${stats.pendingInvoice || 0})`],
              ["complete", `Complete (${stats.complete || 0})`],
            ].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} style={{
                padding: "7px 14px", borderRadius: RADIUS.pill, border: "none", cursor: "pointer",
                fontSize: 11, fontWeight: 600,
                background: filter === k ? BRAND.accent : COLORS.surfaceAlt,
                color: filter === k ? "#fff" : COLORS.textMuted,
                transition: "all 0.15s",
              }}>{l}</button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div style={{ maxHeight: 600, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ position: "sticky", top: 0, background: COLORS.surface, zIndex: 1 }}>
              <tr>
                <th style={th}>▾</th>
                <th style={th}>SO #</th>
                <th style={th}>Customer</th>
                <th style={th}>PO Ref</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th>
                <th style={th}>DO</th>
                <th style={th}>Invoice</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} style={{ padding: 40, textAlign: "center", color: COLORS.textFaint, fontSize: 13 }}>No matching documents</td></tr>
              ) : filtered.map(e => (
                <DocRow key={e.soDockey} entry={e} expanded={expanded === e.soDockey}
                  onToggle={() => setExpanded(expanded === e.soDockey ? null : e.soDockey)} />
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 24px", borderTop: `1px solid ${COLORS.borderFaint}`, background: COLORS.surfaceAlt, fontSize: 11, color: COLORS.textFaint }}>
          Showing {filtered.length} of {entries.length} documents · Linked via fromdockey chain (SO→DO→Invoice)
        </div>
      </Card>
    </div>
  );
}

// ── DOC ROW ──────────────────────────────────────────────────
function DocRow({ entry, expanded, onToggle }) {
  const e = entry;
  const chain = CHAIN_LABELS[e.chain] || CHAIN_LABELS.pending_both;
  const doCount = e.dos?.length || 0;
  const invCount = e.invoices?.length || 0;

  return (
    <>
      <tr onClick={onToggle} style={{
        borderBottom: `1px solid ${COLORS.borderFaint}`, cursor: "pointer",
        background: expanded ? `rgba(79, 124, 247, 0.04)` : "transparent",
      }}>
        {/* Chevron */}
        <td style={{ padding: "12px 12px 12px 20px", width: 24 }}>
          <Ic name={expanded ? "chevronDown" : "chevron"} size={12} color={expanded ? BRAND.accent : COLORS.textFaint} />
        </td>

        {/* SO # */}
        <td style={{ padding: "12px 16px" }}>
          <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#1E3A5F" }}>{e.soNo}</span>
          <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 2 }}>{fmtD(e.date)}</div>
        </td>

        {/* Customer */}
        <td style={{ padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Avatar name={e.customer} size={28} />
            <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.text, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.customer}</div>
          </div>
        </td>

        {/* PO Ref */}
        <td style={{ padding: "12px 16px", fontSize: 12, color: COLORS.textMuted }}>{e.poRef || "—"}</td>

        {/* Amount */}
        <td style={{ padding: "12px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt(e.amount)}</td>

        {/* DO */}
        <td style={{ padding: "12px 16px" }}>
          {doCount > 0 ? (
            <Pill color={COLORS.successDark} bg={COLORS.successBg} size="sm" dot>
              {doCount === 1 ? e.dos[0].docno : `${doCount} DOs`}
            </Pill>
          ) : (
            <Pill color={COLORS.dangerDark} bg={COLORS.dangerBg} size="sm">Missing</Pill>
          )}
        </td>

        {/* Invoice */}
        <td style={{ padding: "12px 16px" }}>
          {invCount > 0 ? (
            <Pill color={COLORS.successDark} bg={COLORS.successBg} size="sm" dot>
              {invCount === 1 ? e.invoices[0].docno : `${invCount} INVs`}
            </Pill>
          ) : (
            <Pill color={COLORS.dangerDark} bg={COLORS.dangerBg} size="sm">Missing</Pill>
          )}
        </td>

        {/* Status */}
        <td style={{ padding: "12px 16px" }}>
          <Pill color={chain.color} bg={chain.bg} size="sm">{chain.label}</Pill>
        </td>
      </tr>

      {/* Expanded detail */}
      {expanded && (
        <tr>
          <td colSpan={8} style={{ padding: 0 }}>
            <ExpandedDetail entry={e} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── EXPANDED DETAIL ──────────────────────────────────────────
function ExpandedDetail({ entry }) {
  return (
    <div style={{ padding: "16px 24px 20px 60px", background: COLORS.surfaceAlt, borderTop: `1px solid ${COLORS.borderFaint}` }}>
      {/* Chain visualization */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <ChainNode label="SO" docno={entry.soNo} date={entry.date} amount={entry.amount} active />
        <ChainArrow filled={entry.dos?.length > 0} />
        {entry.dos?.length > 0 ? (
          entry.dos.map((d, i) => (
            <span key={d.docno} style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <ChainNode label="DO" docno={d.docno} date={d.date} amount={d.amount} active />
              {i === entry.dos.length - 1 && <ChainArrow filled={entry.invoices?.length > 0} />}
            </span>
          ))
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <ChainNode label="DO" empty />
            <ChainArrow />
          </span>
        )}
        {entry.invoices?.length > 0 ? (
          entry.invoices.map(inv => (
            <ChainNode key={inv.docno} label="INV" docno={inv.docno} date={inv.date} amount={inv.amount} active />
          ))
        ) : (
          <ChainNode label="INV" empty />
        )}
      </div>

      {/* Customer + PO info + Ref fields */}
      <div style={{ fontSize: 12, color: COLORS.textMuted, display: "flex", flexWrap: "wrap", gap: 16 }}>
        <span><span style={{ fontWeight: 600, color: COLORS.text }}>{entry.customer}</span>
        {entry.customerCode && <span style={{ marginLeft: 8, fontFamily: FONT.mono, color: COLORS.textFaint }}>{entry.customerCode}</span>}</span>
        {entry.poRef && <span>PO: <strong>{entry.poRef}</strong></span>}
        {entry.deliveryInfo && <span>Delivery: <strong>{entry.deliveryInfo}</strong></span>}
        {entry.statusNote && <span>Status: <strong>{entry.statusNote}</strong></span>}
        {entry.invoiceNote && <span style={{ color: COLORS.infoDark }}>Invoice: <strong>{entry.invoiceNote}</strong></span>}
      </div>
    </div>
  );
}

function ChainNode({ label, docno, date, amount, active, empty }) {
  return (
    <div style={{
      padding: "10px 16px", borderRadius: RADIUS.lg, minWidth: 120, textAlign: "center",
      background: empty ? COLORS.neutralBg : active ? COLORS.surface : COLORS.surfaceAlt,
      border: empty ? `2px dashed ${COLORS.borderStrong}` : `1px solid ${active ? BRAND.accent + '44' : COLORS.borderStrong}`,
      boxShadow: active ? SHADOWS.card : "none",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: empty ? COLORS.textFaint : BRAND.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      {empty ? (
        <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 4 }}>Not created</div>
      ) : (
        <>
          <div style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 700, color: "#1E3A5F", marginTop: 4 }}>{docno}</div>
          {date && <div style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 2 }}>{fmtD(date)}</div>}
          {amount != null && <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.text, marginTop: 2 }}>{fmt(amount)}</div>}
        </>
      )}
    </div>
  );
}

function ChainArrow({ filled }) {
  return (
    <div style={{ display: "flex", alignItems: "center", color: filled ? COLORS.success : COLORS.textFaint }}>
      <div style={{ width: 24, height: 2, background: filled ? COLORS.success : COLORS.borderStrong }} />
      <span style={{ fontSize: 14 }}>→</span>
    </div>
  );
}

// ── STYLES ───────────────────────────────────────────────────
const th = {
  padding: "12px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint,
  fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
  borderBottom: `1px solid ${COLORS.borderFaint}`, whiteSpace: "nowrap",
};
