// Vercel Serverless Function: Proxy for Gemini API requests
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const { prompt, clientApiKey } = req.body;

    // Use client-provided key if available, otherwise fall back to environment key
    let apiKey = (clientApiKey && clientApiKey.trim() !== '' && clientApiKey.trim() !== 'MY_GEMINI_API_KEY') 
      ? clientApiKey.trim() 
      : (process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '');

    // Strip surrounding quotes if present
    if (apiKey.startsWith('"') && apiKey.endsWith('"')) {
      apiKey = apiKey.slice(1, -1);
    }
    if (apiKey.startsWith("'") && apiKey.endsWith("'")) {
      apiKey = apiKey.slice(1, -1);
    }

    if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GEMINI_API_KEY') {
      clearTimeout(timeoutId);
      return res.status(400).json({
        error: {
          message: 'Gemini API Key is blank. Please configure the GEMINI_API_KEY environment variable in Vercel settings.'
        }
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const payload = {
      contents: [{
        parts: [{ text: prompt }]
      }]
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      return res.status(429).json({ error: "Rate limit exceeded", status: 429, retryAfter: 60 });
    }

    if (!response.ok) {
      let errMsg = `Server returned status ${response.status}`;
      try {
        const errPayload = await response.json();
        if (errPayload.error && errPayload.error.message) {
          errMsg = errPayload.error.message;
        }
      } catch (_) {}
      return res.status(response.status).json({ error: { message: errMsg } });
    }

    const result = await response.json();
    return res.status(200).json(result);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[Vercel Gemini Function Error]:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
