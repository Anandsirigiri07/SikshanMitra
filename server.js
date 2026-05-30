import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env or .env.local
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());

// API Endpoint to proxy Gemini requests securely
app.post('/api/gemini', async (req, res) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const { prompt, clientApiKey } = req.body;

    // Use client-provided key if available, otherwise fall back to server key
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
          message: 'Gemini API Key is blank. Please configure the GEMINI_API_KEY environment variable or a local .env file on the server.'
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
    res.json(result);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[API Proxy Error]:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// API Endpoint to proxy Groq requests securely
app.post('/api/groq', async (req, res) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const { prompt, clientApiKey } = req.body;

    // Use client-provided key if available, otherwise fall back to server key
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
          message: 'Groq API Key is blank. Please configure the GROQ_API_KEY environment variable or a local .env file on the server.'
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
    res.json(result);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[API Proxy Error (Groq)]:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});


// Serve static built files from dist directory in production
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback all routes to index.html for SPA support
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Express secure proxy listening on port ${PORT}`);
});
