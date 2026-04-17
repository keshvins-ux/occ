# OCC v2 — Operations Command Centre

Full UI/UX redesign of OCC (Operations Command Centre) for Seri Rasa / Vertical Target Services Sdn. Bhd.

Runs in parallel to v1 (mazza-outreach). Same database, same Redis, same SQL Account. Only the UI and some API endpoints have been rebuilt.

---

## What's in Session 1

### Foundation

- Left sidebar navigation with hover glow
- Sticky global date range filter (7/30/90/180/365 days, persisted to localStorage)
- Design system (`src/theme.js`, `src/components/`)
- Shared session with v1 — users logged into v1 are automatically logged in here

### Sections built

| Section | Sub-section | Status |
|---|---|---|
| Sales | Overview (KPIs, trend, top customers, recent SOs, Comparison card) | ✅ Done |
| Sales | Pipeline (Cold/Warm/Hot/Won board) | ✅ Done |
| Sales | Analytics (agent performance, product mix) | ✅ Done |
| Management | AR Overview (real AR from sql_customers, aging, overdue) | ✅ Done |
| Management | Customers (sortable table, CSV export) | ✅ Done |
| Management | SO Lifecycle (active SOs, delivery countdown) | ✅ Done |
| PO Intake | Submit PO + Document Tracker | ⏳ Session 2 |
| Production | Order Queue + Gap + Purchase + Capacity + Floor | ⏳ Session 2 |
| Procurement | Supplier POs + GRN + Stock + Suppliers | ⏳ Session 2 |
| Compliance | Halal dashboard | ⏳ Phase 5 |

### AI Assistant

Claude-powered drawer on every page. Read-only. Tools:

- `top_customers` — top customers by revenue
- `overdue_invoices` — customers with overdue AR
- `sos_at_risk` — SOs at risk of missing delivery
- `stock_below_reorder` — low stock items
- `product_trends` — growing/declining products
- `customer_purchase_history` — named customer lookup
- `gross_margin_by_product` — revenue by product (margin pending BOM cost data)
- `recent_activity` — unified activity feed

### Features on every table

- Sortable columns (click any header)
- Date-descending default
- "What changed" widget at top showing period deltas
- Scoped to global date range filter

---

## Deployment

### 1. Push to GitHub `occ` repo

```bash
cd occ-v2
git init
git add .
git commit -m "OCC v2 — Session 1: foundation + Sales + Management"
git remote add origin https://github.com/keshvins-ux/occ.git
git branch -M main
git push -u origin main
```

### 2. Connect to Vercel

- Go to Vercel → New Project → Import `keshvins-ux/occ`
- Framework preset: **Create React App** (auto-detected)
- Build command: `react-scripts build` (default)
- Output directory: `build` (default)

### 3. Copy env vars from v1

From the existing `mazza-outreach` project → Settings → Environment Variables, copy these to the new `occ` project:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Same — both v1 and v2 read/write same Postgres |
| `REDIS_URL` | Same — shared sessions with v1 |
| `ANTHROPIC_API_KEY` | Same — used by PO extraction + AI Assistant |
| `SQL_ACCESS_KEY` | SQL Account API |
| `SQL_SECRET_KEY` | SQL Account API |
| `SQL_HOST` | `https://api.sql.my` |
| `SQL_REGION` | `ap-southeast-5` |
| `SQL_SERVICE` | `sqlaccount` |

### 4. Deploy

Vercel will auto-deploy on push. You'll get a URL like `occ-xxx.vercel.app`.

---

## Architecture

### Data flow

```
SQL Account API ──(crons on v1)──> Postgres (sql_customers, sql_salesinvoices, etc.)
                                         ▲
                                         │
                                    v1 & v2 read
                                         │
                                         ▼
                                    Team (browser)
```

### Why v2 has no crons

v1 is still running all sync crons (customer sync every 5 min, invoice sync every 20 min, etc.). Data lands in Postgres. v2 just reads. This prevents duplicate writes.

Once the team is fully on v2, we'll flip the crons over and deprecate v1.

### Tech stack (same as v1)

- React 18
- Vercel serverless API functions
- PostgreSQL on DigitalOcean (146.190.92.175)
- Redis for sessions + OCC-native data (prospects, BOM, PO intake submissions)
- Anthropic Claude for PO extraction + AI Assistant

---

## Session 2 roadmap

- **Production** — Order Queue by customer (team feedback), Gap Analysis, Purchase List, Capacity, Floor Display
- **PO Intake** — Submit PO (AI extraction, confidence scoring), Document Tracker (fromdockey chain)
- **Procurement** — Supplier POs, GRN, Stock, Suppliers (all Postgres, replacing Redis reads)
- **Compliance** — Deferred to Phase 5 (halal schema already designed)

Estimated: 1-2 more sessions.
