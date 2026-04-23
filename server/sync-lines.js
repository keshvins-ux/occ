#!/usr/bin/env node
// ============================================================
// SYNC LINES — SO lines, DO lines, Invoice lines
// Runs on DO server via crontab alongside sync-all.js
//
// Strategy:
//   1. Find header records (SOs/DOs/INVs) that have NO lines in Postgres
//   2. Call SQL Account API /salesorder/{dockey} to get detail lines
//   3. Insert lines into sql_so_lines / sql_do_lines / sql_inv_lines
//   4. Also refreshes lines for recently modified headers (offsetqty changes)
//
// Usage:
//   node sync-lines.js              → sync all 3 line tables
//   node sync-lines.js so_lines     → sync SO lines only
//   node sync-lines.js do_lines     → sync DO lines only
//   node sync-lines.js inv_lines    → sync Invoice lines only
//   node sync-lines.js status       → show counts
//
// Crontab: run every 10 minutes, offset from sync-all.js
//   */10 * * * * cd /opt/occ && /usr/bin/node sync-lines.js >> /var/log/occ-sync-lines.log 2>&1
// ============================================================

const { Pool } = require('pg');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://occ_user:OCCseri2026!rawang@localhost:5432/occ_erp';
const SQL_HOST = process.env.SQL_HOST;
const SQL_ACCESS_KEY = process.env.SQL_ACCESS_KEY;
const SQL_SECRET_KEY = process.env.SQL_SECRET_KEY;
const SQL_REGION = process.env.SQL_REGION || 'ap-southeast-5';
const SQL_SERVICE = process.env.SQL_SERVICE || 'sqlaccount';

if (!SQL_ACCESS_KEY || !SQL_SECRET_KEY || !SQL_HOST) {
  console.error('ERROR: SQL_ACCESS_KEY, SQL_SECRET_KEY, and SQL_HOST must be set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
async function q(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

// ── AWS4 SIGNING (exact copy from sync-all.js) ────────────────
function sign(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function getSignatureKey(key, d, r, s) { return sign(sign(sign(sign(Buffer.from('AWS4'+key), d), r), s), 'aws4_request'); }

function buildHeaders(path) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const host = SQL_HOST.replace('https://', '');
  const payloadHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  // Detail endpoint has no query string
  const canonicalRequest = ['GET', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${SQL_REGION}/${SQL_SERVICE}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, credScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
  const sig = crypto.createHmac('sha256',
    getSignatureKey(SQL_SECRET_KEY, dateStamp, SQL_REGION, SQL_SERVICE)).update(sts).digest('hex');
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${SQL_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date': amzDate, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0',
  };
}

// Fetch single document detail from SQL Account API
async function fetchDetail(endpoint, dockey) {
  const path = `${endpoint}/${dockey}`;
  try {
    const res = await fetch(`${SQL_HOST}${path}`, { headers: buildHeaders(path) });
    const text = await res.text();
    if (text.trim().startsWith('<')) return null;
    const data = JSON.parse(text);
    return data.data?.[0] || data;
  } catch (e) {
    return null;
  }
}

function safe(v) { return v == null ? null : String(v); }
function safeDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0,10); }
function safeInt(v) { if (v == null) return null; const n = parseInt(v); return isNaN(n) ? null : n; }

// ── SYNC SO LINES ─────────────────────────────────────────────
async function syncSOLines() {
  const started = Date.now();

  // Find SOs that have NO lines in Postgres
  const missingRes = await q(`
    SELECT so.dockey FROM sql_salesorders so
    LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey
    WHERE sol.dockey IS NULL
    AND so.docdate >= CURRENT_DATE - INTERVAL '6 months'
  `);

  // Also find recently synced SOs (last 24h) to refresh offsetqty
  const recentRes = await q(`
    SELECT DISTINCT so.dockey FROM sql_salesorders so
    WHERE so.occ_synced_at >= NOW() - INTERVAL '24 hours'
    AND so.docdate >= CURRENT_DATE - INTERVAL '2 months'
    AND EXISTS (SELECT 1 FROM sql_so_lines sol WHERE sol.dockey = so.dockey)
  `);

  const missingKeys = missingRes.rows.map(r => r.dockey);
  const recentKeys = recentRes.rows.map(r => r.dockey);
  const allKeys = [...new Set([...missingKeys, ...recentKeys])];

  console.log(`  [so_lines] Missing: ${missingKeys.length}, Refresh: ${recentKeys.length}, Total to process: ${allKeys.length}`);

  let synced = 0, errors = 0;
  for (const dockey of allKeys) {
    try {
      const detail = await fetchDetail('/salesorder', dockey);
      if (!detail || !detail.sdsdocdetail) continue;

      // Delete existing lines for this dockey (refresh)
      await q('DELETE FROM sql_so_lines WHERE dockey = $1', [dockey]);

      for (const line of detail.sdsdocdetail) {
        await q(`
          INSERT INTO sql_so_lines (
            dtlkey, dockey, seq, itemcode, description, description2,
            qty, uom, unitprice, amount, deliverydate,
            offsetqty, fromdockey, fromdtlkey
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (dtlkey) DO UPDATE SET
            qty=EXCLUDED.qty, unitprice=EXCLUDED.unitprice, amount=EXCLUDED.amount,
            offsetqty=EXCLUDED.offsetqty, fromdockey=EXCLUDED.fromdockey, fromdtlkey=EXCLUDED.fromdtlkey
        `, [
          safeInt(line.dtlkey), dockey, safeInt(line.seq),
          safe(line.itemcode), safe(line.description), safe(line.description2),
          safe(line.qty), safe(line.uom), safe(line.unitprice),
          safe(line.amount), safeDate(line.deliverydate),
          safe(line.offsetqty), safeInt(line.fromdockey), safeInt(line.fromdtlkey),
        ]);
      }
      synced++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [so_lines] ERR dockey=${dockey}: ${e.message.slice(0, 80)}`);
    }
    // Rate limit — don't hammer the API
    if (synced % 20 === 0) await sleep(500);
  }

  const after = await q('SELECT COUNT(*)::int AS c FROM sql_so_lines');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  [so_lines] ${secs}s | Processed: ${allKeys.length} | Synced: ${synced} | Errors: ${errors} | Total lines: ${after.rows[0].c}`);
}

// ── SYNC DO LINES ─────────────────────────────────────────────
async function syncDOLines() {
  const started = Date.now();

  const missingRes = await q(`
    SELECT d.dockey FROM sql_deliveryorders d
    LEFT JOIN sql_do_lines dl ON dl.dockey = d.dockey
    WHERE dl.dockey IS NULL
    AND d.docdate >= CURRENT_DATE - INTERVAL '6 months'
  `);

  const missingKeys = missingRes.rows.map(r => r.dockey);
  console.log(`  [do_lines] Missing: ${missingKeys.length}`);

  let synced = 0, errors = 0;
  for (const dockey of missingKeys) {
    try {
      const detail = await fetchDetail('/deliveryorder', dockey);
      if (!detail || !detail.sdsdocdetail) continue;

      for (const line of detail.sdsdocdetail) {
        await q(`
          INSERT INTO sql_do_lines (
            dtlkey, dockey, seq, itemcode, description, description2,
            qty, uom, unitprice, amount,
            fromdockey, fromdtlkey
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (dtlkey) DO UPDATE SET
            qty=EXCLUDED.qty, unitprice=EXCLUDED.unitprice, amount=EXCLUDED.amount,
            fromdockey=EXCLUDED.fromdockey, fromdtlkey=EXCLUDED.fromdtlkey
        `, [
          safeInt(line.dtlkey), dockey, safeInt(line.seq),
          safe(line.itemcode), safe(line.description), safe(line.description2),
          safe(line.qty), safe(line.uom), safe(line.unitprice), safe(line.amount),
          safeInt(line.fromdockey), safeInt(line.fromdtlkey),
        ]);
      }
      synced++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [do_lines] ERR dockey=${dockey}: ${e.message.slice(0, 80)}`);
    }
    if (synced % 20 === 0) await sleep(500);
  }

  const after = await q('SELECT COUNT(*)::int AS c FROM sql_do_lines');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  [do_lines] ${secs}s | Processed: ${missingKeys.length} | Synced: ${synced} | Errors: ${errors} | Total lines: ${after.rows[0].c}`);
}

// ── SYNC INVOICE LINES ────────────────────────────────────────
async function syncInvLines() {
  const started = Date.now();

  const missingRes = await q(`
    SELECT i.dockey FROM sql_salesinvoices i
    LEFT JOIN sql_inv_lines il ON il.dockey = i.dockey
    WHERE il.dockey IS NULL
    AND i.docdate >= CURRENT_DATE - INTERVAL '6 months'
  `);

  const missingKeys = missingRes.rows.map(r => r.dockey);
  console.log(`  [inv_lines] Missing: ${missingKeys.length}`);

  let synced = 0, errors = 0;
  for (const dockey of missingKeys) {
    try {
      const detail = await fetchDetail('/salesinvoice', dockey);
      if (!detail || !detail.sdsdocdetail) continue;

      for (const line of detail.sdsdocdetail) {
        await q(`
          INSERT INTO sql_inv_lines (
            dtlkey, dockey, seq, itemcode, description, description2,
            qty, uom, unitprice, amount,
            fromdockey, fromdtlkey
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (dtlkey) DO UPDATE SET
            qty=EXCLUDED.qty, unitprice=EXCLUDED.unitprice, amount=EXCLUDED.amount,
            fromdockey=EXCLUDED.fromdockey, fromdtlkey=EXCLUDED.fromdtlkey
        `, [
          safeInt(line.dtlkey), dockey, safeInt(line.seq),
          safe(line.itemcode), safe(line.description), safe(line.description2),
          safe(line.qty), safe(line.uom), safe(line.unitprice), safe(line.amount),
          safeInt(line.fromdockey), safeInt(line.fromdtlkey),
        ]);
      }
      synced++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`  [inv_lines] ERR dockey=${dockey}: ${e.message.slice(0, 80)}`);
    }
    if (synced % 20 === 0) await sleep(500);
  }

  const after = await q('SELECT COUNT(*)::int AS c FROM sql_inv_lines');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  [inv_lines] ${secs}s | Processed: ${missingKeys.length} | Synced: ${synced} | Errors: ${errors} | Total lines: ${after.rows[0].c}`);
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  console.log(`\n--- OCC LINE SYNC ${new Date().toISOString().slice(0,19)} ---`);

  try {
    if (arg === 'status') {
      const soLines = await q('SELECT COUNT(*)::int AS c FROM sql_so_lines');
      const doLines = await q('SELECT COUNT(*)::int AS c FROM sql_do_lines');
      const invLines = await q('SELECT COUNT(*)::int AS c FROM sql_inv_lines');
      const soMissing = await q(`SELECT COUNT(*)::int AS c FROM sql_salesorders so LEFT JOIN sql_so_lines sol ON sol.dockey = so.dockey WHERE sol.dockey IS NULL AND so.docdate >= CURRENT_DATE - INTERVAL '6 months'`);
      const doMissing = await q(`SELECT COUNT(*)::int AS c FROM sql_deliveryorders d LEFT JOIN sql_do_lines dl ON dl.dockey = d.dockey WHERE dl.dockey IS NULL AND d.docdate >= CURRENT_DATE - INTERVAL '6 months'`);
      const invMissing = await q(`SELECT COUNT(*)::int AS c FROM sql_salesinvoices i LEFT JOIN sql_inv_lines il ON il.dockey = i.dockey WHERE il.dockey IS NULL AND i.docdate >= CURRENT_DATE - INTERVAL '6 months'`);

      console.log(`  so_lines:  ${soLines.rows[0].c} lines (${soMissing.rows[0].c} SOs missing lines)`);
      console.log(`  do_lines:  ${doLines.rows[0].c} lines (${doMissing.rows[0].c} DOs missing lines)`);
      console.log(`  inv_lines: ${invLines.rows[0].c} lines (${invMissing.rows[0].c} INVs missing lines)`);
    } else if (arg === 'so_lines') {
      await syncSOLines();
    } else if (arg === 'do_lines') {
      await syncDOLines();
    } else if (arg === 'inv_lines') {
      await syncInvLines();
    } else if (!arg) {
      await syncSOLines();
      await syncDOLines();
      await syncInvLines();
    } else {
      console.log(`Usage: node sync-lines.js [so_lines|do_lines|inv_lines|status]`);
    }
  } catch (e) {
    console.error('LINE SYNC FAILED:', e.message);
  } finally {
    await pool.end();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main();
