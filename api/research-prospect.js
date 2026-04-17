export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { company, industry, stockContext } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `You are a B2B sales intelligence analyst for Seri Rasa, a Malaysian Halal OEM spice and condiment manufacturer in Rawang, Selangor.

Search the web for accurate, verified information about this company and return a structured intelligence card.

Company: ${company}
Industry hint: ${industry || "Food & Beverage / Manufacturing"}
Location: Malaysia

IMPORTANT: Use web search to find REAL, VERIFIED information. Do not guess or hallucinate. If you cannot find something, return null for that field.

Search for:
1. Company official website and address
2. LinkedIn company page for employee/contact info
3. Recent news or announcements
4. Their products and what ingredients/spices they use

Our stock items for matching:
${stockContext || ""}

STRICT RULES — these are non-negotiable:
1. ONLY include data you actually found via web search. If you cannot find it, return null.
2. Do NOT guess, estimate, or fabricate ANY field — address, phone, email, contact name, revenue, headcount.
3. If web search returns no results for a field, that field = null.
4. Contacts: only include real people you found on LinkedIn or the company website. No guesses.
5. Email: only include if explicitly found. Never construct an email from a name.
6. Phone: only include if found on official website or directory.
7. Address: only include if found on official website, SSM, or Google Maps.
8. confidenceScore = "high" only if you found the company website AND at least one real contact. "medium" if you found website only. "low" if limited or no results.

Return ONLY valid JSON (no markdown):
{
  "companyName": "official company name from web search",
  "summary": "2-3 sentences from actual web sources — what they make and their scale",
  "companySize": "only if found on LinkedIn or website, else null",
  "estimatedRevenue": "only if found from credible source, else null",
  "website": "actual URL found via search, or null",
  "companyPhone": "only if found on official website, else null",
  "companyAddress": "only if found on official website or SSM, else null",
  "industry": "industry based on what they actually do",
  "contacts": [
    {
      "name": "real person name ONLY if found on LinkedIn/website — null if not found",
      "title": "actual job title from source",
      "email": "ONLY if explicitly found — null otherwise, never construct one",
      "linkedin": "actual LinkedIn URL if found, else null",
      "phone": "direct number ONLY if found, else null"
    }
  ],
  "recentTrigger": "real news/event found via search, or null",
  "ingredientNeeds": "based on products they actually make",
  "suggestedProducts": ["top 3 matching stock items from our list"],
  "pitchAngle": "based on actual research findings",
  "approachTiming": "based on real trigger if found, else general seasonality",
  "language": "bm or en",
  "confidenceScore": "high/medium/low per rules above",
  "sources": ["actual URLs found during search"]
}`
        }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) });

    // Extract text from response (may include tool use blocks)
    const textBlock = data.content?.find(b => b.type === "text");
    const text = textBlock?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    
    try {
      const result = JSON.parse(clean);
      return res.status(200).json({ result });
    } catch(e) {
      return res.status(200).json({ result: { 
        companyName: company, 
        summary: text.substring(0, 300),
        confidenceScore: "low",
        contacts: []
      }});
    }

  } catch (err) {
    console.error("Research error:", err);
    return res.status(500).json({ error: err.message });
  }
}
