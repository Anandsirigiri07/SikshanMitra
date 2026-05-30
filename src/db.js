/**
 * Data Storage & Models Layer
 * IndexedDB-backed database for full mobile & PWA support.
 * Falls back to localStorage for settings/simple keys.
 */

const DB_NAME = 'TeacherAssistantDB';
const DB_VERSION = 3;

const DEFAULT_SUBJECTS = ['Mathematics', 'Science', 'English Language Arts', 'Social Studies', 'Creative Arts'];

// Helper for unique ID generation
export function generateUUID() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ─────────────────────────────────────────────
// IndexedDB Bootstrap
// ─────────────────────────────────────────────
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Object stores
      if (!db.objectStoreNames.contains('students')) {
        db.createObjectStore('students', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('attendance')) {
        // keyPath = dateStr  e.g. "2024-05-30"
        db.createObjectStore('attendance', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('grades')) {
        db.createObjectStore('grades', { keyPath: 'subject' });
      }
      if (!db.objectStoreNames.contains('lessons')) {
        db.createObjectStore('lessons', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('incidents')) {
        db.createObjectStore('incidents', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('reports')) {
        db.createObjectStore('reports', { keyPath: 'id' });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = (e) => {
      console.error('IndexedDB open error:', e.target.error);
      reject(e.target.error);
    };
  });
}

function txGet(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function txGetAll(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function txPut(storeName, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function txDelete(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  }));
}

function txClear(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  }));
}

// ─────────────────────────────────────────────
// 1. Settings (localStorage – tiny data, sync OK)
// ─────────────────────────────────────────────
export function getSettings() {
  try {
    const data = localStorage.getItem('teacher_settings');
    if (!data) return { name: '', className: '', school: '', subjects: DEFAULT_SUBJECTS, apiKey: '', language: 'en', aiProvider: 'groq', groqApiKey: '' };
    const parsed = JSON.parse(data);
    if (!parsed.subjects || parsed.subjects.length === 0) parsed.subjects = DEFAULT_SUBJECTS;
    if (!parsed.language) parsed.language = 'en';
    if (!parsed.aiProvider) parsed.aiProvider = 'groq';
    if (!parsed.groqApiKey) parsed.groqApiKey = '';
    return parsed;
  } catch (e) {
    return { name: '', className: '', school: '', subjects: DEFAULT_SUBJECTS, apiKey: '', language: 'en', aiProvider: 'groq', groqApiKey: '' };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem('teacher_settings', JSON.stringify(settings));
    return true;
  } catch (e) {
    throw new Error('Storage quota exceeded saving settings.');
  }
}

// ─────────────────────────────────────────────
// 2. Students (IndexedDB)
// ─────────────────────────────────────────────
export function getStudents() {
  return txGetAll('students').catch(() => []);
}

export async function saveStudent(studentData) {
  if (!studentData.id) {
    studentData.id = generateUUID();
  }
  await txPut('students', studentData);
  return studentData;
}

export async function deleteStudent(studentId) {
  await txDelete('students', studentId);
  // Purge grades references
  const settings = getSettings();
  for (const sub of settings.subjects) {
    const key = sub.replace(/\s+/g, '_');
    const grade = await txGet('grades', key);
    if (grade && grade.scores && grade.scores[studentId]) {
      delete grade.scores[studentId];
      await txPut('grades', grade);
    }
  }
  // Purge incidents
  const incidents = await txGetAll('incidents');
  const filtered = incidents.filter(i => i.studentId !== studentId);
  await txClear('incidents');
  for (const inc of filtered) await txPut('incidents', inc);
  return true;
}

// ─────────────────────────────────────────────
// 3. Attendance (IndexedDB) – FULL HISTORY SUPPORT
// ─────────────────────────────────────────────
/**
 * Get attendance record for a specific date.
 * Returns an object: { [studentId]: 'present' | 'absent' | 'late' }
 */
export async function getAttendance(dateStr) {
  const record = await txGet('attendance', dateStr);
  return record ? record.marks : {};
}

/**
 * Save attendance for a date.
 * @param {string} dateStr   – ISO date string e.g. "2024-05-30"
 * @param {object} marksMap  – { [studentId]: 'present'|'absent'|'late' }
 */
export async function saveAttendance(dateStr, marksMap) {
  await txPut('attendance', { date: dateStr, marks: marksMap, savedAt: new Date().toISOString() });
  return true;
}

/**
 * Get all attendance records sorted newest-first.
 * Returns array of { date, marks, savedAt }
 */
export async function getAllAttendanceHistory() {
  const all = await txGetAll('attendance');
  return all.sort((a, b) => (b.date > a.date ? 1 : -1));
}

/**
 * Delete a specific day's attendance record
 */
export async function deleteAttendanceRecord(dateStr) {
  await txDelete('attendance', dateStr);
  return true;
}

// ─────────────────────────────────────────────
// 4. Grades (IndexedDB)
// ─────────────────────────────────────────────
export async function getGradesForSubject(subName) {
  const key = subName.replace(/\s+/g, '_');
  const record = await txGet('grades', key);
  if (!record) return { subject: key, assignments: ['Exam 1', 'Homework 1'], scores: {} };
  return record;
}

export async function saveGradesForSubject(subName, gradeData) {
  const key = subName.replace(/\s+/g, '_');
  gradeData.subject = key;
  await txPut('grades', gradeData);
  return true;
}

// ─────────────────────────────────────────────
// 5. Lessons (IndexedDB)
// ─────────────────────────────────────────────
export async function getLessons() {
  return txGetAll('lessons').catch(() => []);
}

export async function saveLesson(lesson) {
  if (!lesson.id) lesson.id = generateUUID();
  await txPut('lessons', lesson);
  return lesson;
}

export async function deleteLesson(id) {
  await txDelete('lessons', id);
  return true;
}

// ─────────────────────────────────────────────
// 6. Incidents (IndexedDB)
// ─────────────────────────────────────────────
export async function getIncidents() {
  return txGetAll('incidents').catch(() => []);
}

export async function saveIncident(incident) {
  if (!incident.id) incident.id = generateUUID();
  await txPut('incidents', incident);
  return incident;
}

export async function deleteIncident(id) {
  await txDelete('incidents', id);
  return true;
}

// ─────────────────────────────────────────────
// 7. Messages Drafts (IndexedDB)
// ─────────────────────────────────────────────
export async function getMessageDrafts() {
  return txGetAll('messages').catch(() => []);
}

export async function saveMessageDraft(draft) {
  if (!draft.id) draft.id = generateUUID();
  await txPut('messages', draft);
  return draft;
}

export async function deleteMessageDraft(id) {
  await txDelete('messages', id);
  return true;
}

// ─────────────────────────────────────────────
// 8. Progress Reports Drafts (IndexedDB)
// ─────────────────────────────────────────────
export async function getReportDrafts() {
  return txGetAll('reports').catch(() => []);
}

export async function saveReportDraft(draft) {
  if (!draft.id) draft.id = generateUUID();
  await txPut('reports', draft);
  return draft;
}

export async function deleteReportDraft(id) {
  await txDelete('reports', id);
  return true;
}

// ─────────────────────────────────────────────
// 9. Global wipe
// ─────────────────────────────────────────────
export async function wipeAllDatabase() {
  localStorage.clear();
  await txClear('students');
  await txClear('attendance');
  await txClear('grades');
  await txClear('lessons');
  await txClear('incidents');
  await txClear('messages');
  await txClear('reports');
  return true;
}
