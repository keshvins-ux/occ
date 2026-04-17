import { createClient } from 'redis';

async function getClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getClient();
  try {
    const [rmRaw, custRaw, ordersRaw, totalsRaw, metaRaw] = await Promise.all([
      client.get('purchase:raw_materials'),
      client.get('purchase:customer_summary'),
      client.get('purchase:orders'),
      client.get('purchase:totals'),
      client.get('purchase:meta'),
    ]);

    if (!rmRaw) {
      return res.status(200).json({ empty: true, message: 'No purchase plan data. Please seed from Excel.' });
    }

    const rawMaterials    = JSON.parse(rmRaw);
    const customerSummary = JSON.parse(custRaw || '[]');
    const orders          = JSON.parse(ordersRaw || '[]');
    const totals          = JSON.parse(totalsRaw || '{}');
    const meta            = JSON.parse(metaRaw || '{}');

    return res.status(200).json({ rawMaterials, customerSummary, orders, totals, meta });

  } catch (err) {
    console.error('purchase-plan error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
