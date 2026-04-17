// api/po-memory.js
// Stores and retrieves confirmed PO extractions per customer (self-learning)
// Also handles duplicate detection by file hash
import { Pool } from 'pg';

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS occ_po_memory (
        id            SERIAL PRIMARY KEY,
        customer_code VARCHAR(20) NOT NULL,
        file_hash     VARCHAR(64),
        po_number     VARCHAR(100),
        extracted     JSONB NOT NULL,
        confirmed_by  VARCHAR(50),
        confirmed_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_po_memory_customer ON occ_po_memory(customer_code);
      CREATE INDEX IF NOT EXISTS idx_po_memory_hash    ON occ_po_memory(file_hash);
    `);

    if (req.method === 'GET') {
      const { customer_code, file_hash } = req.query;

      // Duplicate check by file hash
      if (file_hash) {
        const dup = await client.query(
          `SELECT id, customer_code, po_number, confirmed_at,
                  extracted->>'customerName' AS customer_name
           FROM occ_po_memory WHERE file_hash = $1 LIMIT 1`,
          [file_hash]
        );
        return res.status(200).json({
          duplicate: dup.rows.length > 0,
          existing:  dup.rows[0] || null,
        });
      }

      // Fetch last 3 confirmed examples for this customer
      if (customer_code) {
        const mem = await client.query(
          `SELECT extracted FROM occ_po_memory
           WHERE customer_code = $1
           ORDER BY confirmed_at DESC LIMIT 3`,
          [customer_code]
        );
        return res.status(200).json({ examples: mem.rows.map(r => r.extracted) });
      }

      return res.status(400).json({ error: 'Provide customer_code or file_hash' });
    }

    if (req.method === 'POST') {
      const { customer_code, file_hash, po_number, extracted, confirmed_by } = req.body;
      if (!customer_code || !extracted) {
        return res.status(400).json({ error: 'customer_code and extracted are required' });
      }
      await client.query(
        `INSERT INTO occ_po_memory (customer_code, file_hash, po_number, extracted, confirmed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [customer_code, file_hash || null, po_number || null, JSON.stringify(extracted), confirmed_by || null]
      );
      return res.status(200).json({ success: true });
    }

  } catch (err) {
    console.error('po-memory error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}
