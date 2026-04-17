export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { messages, pdfBase64, fileName } = req.body;
    if (!messages || !messages.length) return res.status(400).json({ error: "No messages provided" });

    const textPrompt = typeof messages[0].content === 'string'
      ? messages[0].content
      : messages[0].content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey    = process.env.OPENAI_API_KEY;

    let responseText;

    if (pdfBase64) {
      // -- PDF: use Claude (reads PDFs natively) --
      if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel environment variables." });

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: textPrompt }
            ]
          }]
        })
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) return res.status(400).json({ error: claudeData.error.message || JSON.stringify(claudeData.error) });
      responseText = claudeData.content?.[0]?.text || '{}';

    } else {
      // -- Images / plain text --
      // Build Claude-format content blocks from the message
      const contentBlocks = [];
      for (const block of (messages[0]?.content || [])) {
        if (typeof block === 'string') {
          contentBlocks.push({ type: 'text', text: block });
        } else if (block.type === 'text') {
          contentBlocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'image_url' && block.image_url?.url) {
          // Convert image_url format to Claude's native image format
          const dataUrl = block.image_url.url;
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          }
        } else if (block.type === 'image' && block.source) {
          contentBlocks.push(block); // already Claude format
        }
      }

      const hasImage = contentBlocks.some(b => b.type === 'image');

      // Try Claude first (works for both images and text)
      if (anthropicKey) {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            messages: [{ role: 'user', content: contentBlocks }]
          })
        });
        const claudeData = await claudeRes.json();
        if (!claudeData.error) {
          responseText = claudeData.content?.[0]?.text || '{}';
        } else {
          console.error('Claude error for image/text:', JSON.stringify(claudeData.error));
          // Fall through to GPT-4o
        }
      }

      // Fall back to GPT-4o if Claude failed or not configured
      if (!responseText && openaiKey) {
        const openaiMessages = messages.map(m => {
          if (typeof m.content === 'string') return { role: m.role, content: m.content };
          const parts = [];
          for (const block of m.content) {
            if (block.type === 'text') parts.push({ type: 'text', text: block.text });
            else if (block.type === 'image_url') parts.push(block);
            else if (block.type === 'image' && block.source)
              parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
          }
          return { role: m.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts };
        });

        const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify({ model: 'gpt-4o', max_tokens: 2000, messages: openaiMessages, response_format: { type: 'json_object' } }),
        });
        const gptData = await gptRes.json();
        if (gptData.error) return res.status(400).json({ error: gptData.error.message });
        responseText = gptData.choices?.[0]?.message?.content || '{}';
      }

      if (!responseText) {
        return res.status(500).json({
          error: 'No AI API keys configured or all requests failed. Please check ANTHROPIC_API_KEY in Vercel environment variables.'
        });
      }
    }

    // Strip markdown fences and return
    const clean = responseText.replace(/```json|```/g, '').trim();
    return res.status(200).json({ content: [{ type: 'text', text: clean }] });

  } catch (err) {
    console.error('Extract PO error:', err);
    return res.status(500).json({ error: err.message });
  }
}
