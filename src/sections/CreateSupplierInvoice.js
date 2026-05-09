// ============================================================
// CREATE SUPPLIER INVOICE — Placeholder (Day 7)
//
// Will become the supplier invoice (AP bill) creation flow:
//   - Pick a closed/partially-received GRN
//   - Match qty + price against PO
//   - Auto-flag variances (price > 5% over PO, qty mismatches)
//   - Submit to SQL Account
//
// IMPORTANT: This is the AP bill, separate from the operational
// PI ingestion (sql_pi_v2_*) we built in Day 6. AP bills land in
// sql_purchaseinvoices. The two are deliberately distinct flows.
// ============================================================

import { ComingSoonCard } from "./CreateSupplierGRN";

export default function CreateSupplierInvoice() {
  return <ComingSoonCard
    icon="fileText"
    title="Create Supplier Invoice"
    subtitle="AP bill / supplier invoice creation"
    bullets={[
      "Pick a received GRN to invoice",
      "Auto-match against PO prices",
      "Flag variance > 5% for review",
      "Submit to SQL Account /purchaseinvoice",
    ]}
  />;
}
