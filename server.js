import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

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


const KV_URL = 'https://jsonbin-zeta.vercel.app/api/bins/ObbyLGlpHZ';
const TEACHERS_FILE = path.join(__dirname, 'data', 'teachers.json');

// Ensure data folder exists locally
if (!fs.existsSync(path.dirname(TEACHERS_FILE))) {
  fs.mkdirSync(path.dirname(TEACHERS_FILE), { recursive: true });
}
if (!fs.existsSync(TEACHERS_FILE)) {
  fs.writeFileSync(TEACHERS_FILE, '[]', 'utf8');
}

async function getBackendTeachers() {
  if (process.env.VERCEL) {
    try {
      const res = await fetch(KV_URL);
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : [];
      }
    } catch (err) {
      console.error('KV Read Error:', err);
    }
    return [];
  } else {
    try {
      const data = fs.readFileSync(TEACHERS_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      return [];
    }
  }
}

async function saveBackendTeachers(teachers) {
  if (process.env.VERCEL) {
    try {
      await fetch(KV_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(teachers)
      });
    } catch (err) {
      console.error('KV Write Error:', err);
    }
  } else {
    fs.writeFileSync(TEACHERS_FILE, JSON.stringify(teachers, null, 2), 'utf8');
  }
}

// Get teacher profiles list
app.get('/api/teachers', async (req, res) => {
  try {
    const teachers = await getBackendTeachers();
    res.json(teachers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save or update a teacher profile
app.post('/api/teachers', async (req, res) => {
  try {
    const teacher = req.body;
    const teachers = await getBackendTeachers();
    const idx = teachers.findIndex(t => t.id === teacher.id);
    if (idx !== -1) {
      teachers[idx] = teacher;
    } else {
      teachers.push(teacher);
    }
    await saveBackendTeachers(teachers);
    res.json(teacher);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a teacher profile
app.delete('/api/teachers/:id?', async (req, res) => {
  try {
    const id = req.params.id || req.query.id;
    if (!id) {
      return res.status(400).json({ error: 'Missing teacher ID' });
    }
    let teachers = await getBackendTeachers();
    teachers = teachers.filter(t => t.id !== id);
    await saveBackendTeachers(teachers);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
