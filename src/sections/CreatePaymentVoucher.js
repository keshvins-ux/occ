// ============================================================
// CREATE PAYMENT VOUCHER — Placeholder (Day 7)
//
// Will become the supplier payment flow:
//   - Pick supplier
//   - Show outstanding invoices (sql_purchaseinvoices - paid)
//   - Allocate payment amount across invoices
//   - Pick payment method (cheque / transfer / cash)
//   - Submit to SQL Account /supplierpayment
// ============================================================

import { ComingSoonCard } from "./CreateSupplierGRN";

export default function CreatePaymentVoucher() {
  return <ComingSoonCard
    icon="dollar"
    title="Create Payment Voucher"
    subtitle="Pay supplier invoices"
    bullets={[
      "Pick supplier",
      "View outstanding invoices",
      "Allocate payment across multiple invoices",
      "Submit to SQL Account /supplierpayment",
    ]}
  />;
}
