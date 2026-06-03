// Vercel Serverless Function: Verify faces using Groq Llama 3.2 Vision API
export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35000); // 35 seconds timeout

  try {
    const { profilePhoto, webcamPhoto, clientApiKey } = req.body;

    if (!profilePhoto || !webcamPhoto) {
      clearTimeout(timeoutId);
      return res.status(400).json({ error: { message: 'Both profilePhoto and webcamPhoto are required.' } });
    }

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
          message: 'Groq API Key is missing. Please configure the GROQ_API_KEY in server environment or client settings.'
        }
      });
    }

    const url = 'https://api.groq.com/openai/v1/chat/completions';

    // Construct the payload for active Llama 4 Scout Vision model
    const payload = {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are an advanced biometric security system. Perform a highly critical, strict verification comparing the face in Image 1 (registered profile photo) with the face in Image 2 (recent webcam capture) to see if they represent the EXACT SAME person. To prevent unauthorized access or false matches (e.g. from friends, family, or look-alikes): 1) Carefully analyze detailed anatomical landmarks: eye spacing, eyebrow shape/thickness, nose bridge and nostril structure, jawline shape, cheekbones, lips, ear placement, and facial hairline. 2) Do NOT be fooled by general demographic similarities, skin tone, gender, or similar haircuts. Look closely at structural variations. 3) Be highly critical: if there are noticeable differences or any uncertainty, you must report a mismatch ("match": false) with a lower confidence score. 4) Account for differences in lighting, camera angle, and glasses, but do not let them excuse structural discrepancies in facial bone structure. Return a JSON object with: 1) "match" (boolean), 2) "confidence" (number 0-100), and 3) "reason" (brief explanation detailing matching or differing features). Example: {"match": false, "confidence": 20, "reason": "While demographics match, Image 2 has a significantly wider jawline and different nostril structure compared to Image 1."}'
            },
            {
              type: 'image_url',
              image_url: {
                url: profilePhoto
              }
            },
            {
              type: 'image_url',
              image_url: {
                url: webcamPhoto
              }
            }
          ]
        }
      ],
      response_format: {
        type: 'json_object'
      },
      temperature: 0.1
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
    
    // Extract JSON from response
    try {
      const content = result.choices[0].message.content;
      const parsed = JSON.parse(content);
      return res.status(200).json(parsed);
    } catch (parseErr) {
      console.error('Error parsing response content from Groq:', result, parseErr);
      return res.status(500).json({
        error: { message: 'Failed to parse JSON response from Groq Vision API.' },
        raw: result
      });
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[Vercel Verify Face Function Error]:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
