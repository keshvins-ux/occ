// ============================================================
// PRODUCTION — Order Queue
// Shows active SOs grouped by customer, sorted by delivery urgency
// Answers: "What do we need to make and for whom?"
// ============================================================

import { useState, useEffect, useMemo } from "react";
import Card from "../components/Card";
import KpiCard from "../components/KpiCard";
import Pill from "../components/Pill";
import Avatar from "../components/Avatar";
import Ic from "../components/Ic";
import { BRAND, COLORS, RADIUS, FONT } from "../theme";
import { fmt, fmt0, fmtD, fetchJson } from "../utils";

export default function ProductionQueue() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchJson("/api/prospects?type=production_queue")
      .then(resp => setData(resp))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const customers = data?.customers || [];
  const stats = data?.stats || {};
  const itemSummary = data?.itemSummary || [];

  const filtered = useMemo(() => {
    if (!search) return customers;
    const s = search.toLowerCase();
    return customers.filter(c =>
      c.name?.toLowerCase().includes(s) ||
      c.orders?.some(o => o.docno?.toLowerCase().includes(s) ||
        o.items?.some(i => i.itemcode?.toLowerCase().includes(s) || i.description?.toLowerCase().includes(s)))
    );
  }, [customers, search]);

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: COLORS.textMuted }}>Loading order queue…</div>;
  if (error) return <div style={{ padding: 16, background: COLORS.dangerBg, color: COLORS.dangerDark, borderRadius: RADIUS.lg }}>{error}</div>;

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <KpiCard icon="user" iconBg={BRAND.accentGlow} iconColor={BRAND.accent} label="Customers" value={fmt0(stats.totalCustomers || 0)} />
        <KpiCard icon="package" iconBg={COLORS.infoBg} iconColor={COLORS.info} label="Active Orders" value={fmt0(stats.totalOrders || 0)} />
        <KpiCard icon="chart" iconBg={COLORS.warningBg} iconColor={COLORS.warningDark} label="Products to Make" value={fmt0(stats.totalItems || 0)} />
        <KpiCard icon="trending" iconBg={COLORS.successBg} iconColor={COLORS.success} label="Order Value" value={fmt(stats.totalValue || 0)} />
      </div>

      {/* Search */}
      <Card>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search customer, SO, product…"
            style={{ width: "100%", padding: "10px 14px", borderRadius: RADIUS.md, border: `1px solid ${COLORS.borderStrong}`, fontSize: 12, outline: "none", background: COLORS.surfaceAlt, color: COLORS.text }} />
        </div>

        {/* Customer rows */}
        <div style={{ maxHeight: 600, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: COLORS.textFaint }}>No active orders found</div>
          ) : filtered.map(c => (
            <CustomerRow key={c.code} customer={c} expanded={expanded === c.code}
              onToggle={() => setExpanded(expanded === c.code ? null : c.code)} />
          ))}
        </div>
      </Card>

      {/* Item Summary */}
      {itemSummary.length > 0 && (
        <Card title="Product Summary" subtitle="Total pending quantities across all orders" style={{ marginTop: 20 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Item Code</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>Pending Qty</th>
                <th style={th}>UOM</th>
                <th style={{ ...th, textAlign: "right" }}>Orders</th>
              </tr>
            </thead>
            <tbody>
              {itemSummary.slice(0, 20).map(item => (
                <tr key={item.itemcode} style={{ borderBottom: `1px solid ${COLORS.borderFaint}` }}>
                  <td style={{ padding: "10px 16px", fontFamily: FONT.mono, fontSize: 12, fontWeight: 600, color: "#1E3A5F" }}>{item.itemcode}</td>
                  <td style={{ padding: "10px 16px", fontSize: 12, color: COLORS.text }}>{item.description}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt0(item.totalPending)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 11, color: COLORS.textMuted }}>{item.uom}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right", fontSize: 12, color: COLORS.textMuted }}>{item.orderCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function CustomerRow({ customer, expanded, onToggle }) {
  const c = customer;
  return (
    <>
      <div onClick={onToggle} style={{
        padding: "14px 24px", borderBottom: `1px solid ${COLORS.borderFaint}`, cursor: "pointer",
        display: "flex", alignItems: "center", gap: 16, background: expanded ? `${BRAND.accent}08` : "transparent",
      }}>
        <Ic name={expanded ? "chevronDown" : "chevron"} size={12} color={expanded ? BRAND.accent : COLORS.textFaint} />
        <Avatar name={c.name} size={36} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.text }}>{c.name}</div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{c.orders.length} order{c.orders.length > 1 ? 's' : ''}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{fmt(c.totalAmount)}</div>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "0 24px 16px 60px", background: COLORS.surfaceAlt }}>
          {c.orders.map(so => (
            <div key={so.docno} style={{ padding: "12px 0", borderBottom: `1px solid ${COLORS.borderFaint}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div>
                  <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 700, color: "#1E3A5F" }}>{so.docno}</span>
                  <span style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 12 }}>{fmtD(so.date)}</span>
                  {so.poRef && <span style={{ fontSize: 11, color: COLORS.textFaint, marginLeft: 12 }}>PO: {so.poRef}</span>}
                </div>
                {so.deliveryInfo && <Pill color={COLORS.warningDark} bg={COLORS.warningBg} size="sm">{so.deliveryInfo}</Pill>}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thSm}>Item</th>
                    <th style={thSm}>Description</th>
                    <th style={{ ...thSm, textAlign: "right" }}>Ordered</th>
                    <th style={{ ...thSm, textAlign: "right" }}>Delivered</th>
                    <th style={{ ...thSm, textAlign: "right" }}>Pending</th>
                    <th style={thSm}>UOM</th>
                  </tr>
                </thead>
                <tbody>
                  {so.items.map((item, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${COLORS.borderFaint}22` }}>
                      <td style={{ padding: "6px 8px", fontFamily: FONT.mono, fontSize: 11, color: "#1E3A5F" }}>{item.itemcode}</td>
                      <td style={{ padding: "6px 8px", fontSize: 11, color: COLORS.text }}>{item.description}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 11, color: COLORS.textMuted }}>{fmt0(item.qty)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 11, color: COLORS.success }}>{fmt0(item.delivered)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: COLORS.dangerDark }}>{fmt0(item.pending)}</td>
                      <td style={{ padding: "6px 8px", fontSize: 10, color: COLORS.textFaint }}>{item.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const th = { padding: "10px 16px", textAlign: "left", fontSize: 10, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}` };
const thSm = { padding: "6px 8px", textAlign: "left", fontSize: 9, color: COLORS.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${COLORS.borderFaint}22` };
