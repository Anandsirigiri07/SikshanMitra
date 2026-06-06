// Vercel Serverless Function: CRUD for teacher profiles
const KV_URL = 'https://extendsclass.com/api/json-storage/bin/fdcbadb';

async function getBackendTeachers() {
  const res = await fetch(KV_URL);
  if (!res.ok) {
    throw new Error(`Failed to read from JSON store: ${res.statusText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function saveBackendTeachers(teachers) {
  const res = await fetch(KV_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(teachers)
  });
  if (!res.ok) {
    throw new Error(`Failed to update JSON store: ${res.statusText}`);
  }
}

export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const teachers = await getBackendTeachers();
      return res.status(200).json(teachers);
    } 
    
    if (req.method === 'POST') {
      const teacher = req.body;
      const teachers = await getBackendTeachers();
      const idx = teachers.findIndex(t => t.id === teacher.id);
      if (idx !== -1) {
        teachers[idx] = teacher;
      } else {
        teachers.push(teacher);
      }
      await saveBackendTeachers(teachers);
      return res.status(200).json(teacher);
    } 
    
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) {
        return res.status(400).json({ error: 'Missing teacher ID' });
      }
      let teachers = await getBackendTeachers();
      teachers = teachers.filter(t => t.id !== id);
      await saveBackendTeachers(teachers);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  } catch (err) {
    console.error('[Vercel Teachers Function Error]:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
}
