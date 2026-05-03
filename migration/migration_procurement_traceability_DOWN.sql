-- ============================================================
-- OCC Procurement + Traceability — ROLLBACK
-- File: migration_procurement_traceability_DOWN.sql
-- Purpose: undo migration_procurement_traceability.sql
--
-- WARNING: This drops ALL data in OCC procurement + compliance tables.
-- Only run if you're certain you want to revert.
--
-- Safe order: drop in reverse dependency order.
-- Functions and views first (no dependents), then tables.
-- ============================================================

BEGIN;

-- Functions (depend on view)
DROP FUNCTION IF EXISTS fn_supplier_safe_to_use(VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS fn_get_supplier_warning_level(VARCHAR, VARCHAR);

-- Views (depend on tables)
DROP VIEW IF EXISTS v_recall_trace;
DROP VIEW IF EXISTS v_supplier_halal_status;

-- Tables in reverse FK dependency order
-- (children before parents)
DROP TABLE IF EXISTS occ_production_batch_outputs;
DROP TABLE IF EXISTS occ_production_batch_materials;
DROP TABLE IF EXISTS occ_production_batches;
DROP TABLE IF EXISTS occ_supplier_cert_snapshots;
DROP TABLE IF EXISTS occ_goods_receipt_lots;
DROP TABLE IF EXISTS occ_goods_receipts;
DROP TABLE IF EXISTS occ_compliance_overrides;
DROP TABLE IF EXISTS occ_supplier_halal_cert_items;
DROP TABLE IF EXISTS occ_supplier_halal_certs;

COMMIT;

-- Verify nothing left
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'occ_supplier_halal%' OR table_name LIKE 'occ_goods_%' OR table_name LIKE 'occ_production_batch%' OR table_name LIKE 'occ_compliance_%';
