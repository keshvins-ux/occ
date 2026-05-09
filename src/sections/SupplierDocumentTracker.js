// ============================================================
// SUPPLIER DOCUMENT TRACKER — Placeholder (Day 7)
//
// Procurement-side mirror of the existing Document Tracker.
// Will show supplier-side document flow: PO → GRN → Invoice → Payment
// with status, outstanding amount, days-since-event for each chain.
//
// Uses the same fromdockey-based linking pattern documented from
// Day 7 morning (sql_pi_v2_lines.fromdockey → po dockey, etc).
// ============================================================

import { ComingSoonCard } from "./CreateSupplierGRN";

export default function SupplierDocumentTracker() {
  return <ComingSoonCard
    icon="package"
    title="Supplier Document Tracker"
    subtitle="PO → GRN → Invoice → Payment chains"
    bullets={[
      "Live status of every supplier document chain",
      "Outstanding amount + ageing per supplier",
      "Linked via fromdockey traceability",
      "Mirror of the customer-side Document Tracker",
    ]}
  />;
}
