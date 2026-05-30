// Vercel Serverless Function: Proxy for Groq API requests
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
    let apiKey = (clientApiKey && clientApiKey.trim() !== '' && clientApiKey.trim() !== 'MY_GROQ_API_KEY') 
      ? clientApiKey.trim() 
      : (process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.trim() : '');

    // Strip surrounding quotes if present
    if (apiKey.startsWith('"') && apiKey.endsWith('"')) {
      apiKey = apiKey.slice(1, -1);
    }
    if (apiKey.startsWith("'") && apiKey.endsWith("'")) {
      apiKey = apiKey.slice(1, -1);
    }

    if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GROQ_API_KEY') {
      clearTimeout(timeoutId);
      return res.status(400).json({
        error: {
          message: 'Groq API Key is blank. Please configure the GROQ_API_KEY environment variable in Vercel settings.'
        }
      });
    }

    const url = 'https://api.groq.com/openai/v1/chat/completions';

    const payload = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'user', content: prompt }
      ]
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
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
    console.error('[Vercel Groq Function Error]:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
