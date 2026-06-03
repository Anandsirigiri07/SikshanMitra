/**
 * Data Storage & Models Layer
 * IndexedDB-backed database for full mobile & PWA support.
 * Falls back to localStorage for settings/simple keys.
 */

const DB_NAME = 'TeacherAssistantDB';
const DB_VERSION = 4;

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
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    let timeoutId = setTimeout(() => {
      timeoutId = null;
      console.warn('IndexedDB connection request timed out.');
      reject(new Error('IndexedDB open connection timeout'));
    }, 5000);

    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Object stores
        if (!db.objectStoreNames.contains('students')) {
          db.createObjectStore('students', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('attendance')) {
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
        if (!db.objectStoreNames.contains('teachers')) {
          db.createObjectStore('teachers', { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        if (!timeoutId) return; // already timed out
        clearTimeout(timeoutId);
        _db = e.target.result;

        // Handle database version changes (e.g. from another tab upgrading)
        _db.onversionchange = () => {
          _db.close();
          _db = null;
          console.warn('Database version changed in another context. Connection closed.');
        };

        resolve(_db);
      };

      req.onblocked = (e) => {
        if (!timeoutId) return; // already timed out
        clearTimeout(timeoutId);
        console.warn('IndexedDB database upgrade blocked by another connection.', e);
        reject(new Error('IndexedDB upgrade blocked'));
      };

      req.onerror = (e) => {
        if (!timeoutId) return; // already timed out
        clearTimeout(timeoutId);
        console.error('IndexedDB open error:', e.target.error);
        reject(e.target.error);
      };
    } catch (err) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(err);
    }
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
// 1b. Sections (localStorage)
// ─────────────────────────────────────────────
export async function getSections() {
  try {
    return JSON.parse(localStorage.getItem('sections') || '[]');
  } catch (e) {
    return [];
  }
}

export async function saveSection(section) {
  const sections = await getSections();
  if (!section.id) {
    section.id = 'sec_' + generateUUID();
  }
  const idx = sections.findIndex(s => s.id === section.id);
  if (idx !== -1) {
    sections[idx] = section;
  } else {
    sections.push(section);
  }
  localStorage.setItem('sections', JSON.stringify(sections));
  return section;
}

export async function deleteSection(sectionId) {
  let sections = await getSections();
  sections = sections.filter(s => s.id !== sectionId);
  localStorage.setItem('sections', JSON.stringify(sections));

  // Cascade delete students
  let students = await getStudents();
  const studentsInSec = students.filter(s => s.sectionId === sectionId);
  students = students.filter(s => s.sectionId !== sectionId);
  localStorage.setItem('students', JSON.stringify(students));

  // Cascade delete attendance
  let attendance = JSON.parse(localStorage.getItem('attendance') || '[]');
  attendance = attendance.filter(a => a.sectionId !== sectionId);
  localStorage.setItem('attendance', JSON.stringify(attendance));

  // Cascade delete grades
  let grades = JSON.parse(localStorage.getItem('grades') || '[]');
  grades = grades.filter(g => g.sectionId !== sectionId);
  localStorage.setItem('grades', JSON.stringify(grades));

  // Delete students' corresponding incidents/messages/reports from IndexedDB
  for (const student of studentsInSec) {
    await deleteStudentIndexedDBRefs(student.id);
  }
  
  return true;
}

async function deleteStudentIndexedDBRefs(studentId) {
  // Purge incidents
  try {
    const incidents = await txGetAll('incidents');
    const filtered = incidents.filter(i => i.studentId !== studentId);
    await txClear('incidents');
    for (const inc of filtered) await txPut('incidents', inc);
  } catch (e) {
    console.error('Error clearing student incidents refs:', e);
  }

  // Purge messages
  try {
    const messages = await txGetAll('messages');
    const filteredMsgs = messages.filter(m => m.studentId !== studentId);
    await txClear('messages');
    for (const msg of filteredMsgs) await txPut('messages', msg);
  } catch (e) {
    console.error('Error clearing student messages refs:', e);
  }

  // Purge reports
  try {
    const reports = await txGetAll('reports');
    const filteredRpts = reports.filter(r => r.studentId !== studentId);
    await txClear('reports');
    for (const rpt of filteredRpts) await txPut('reports', rpt);
  } catch (e) {
    console.error('Error clearing student reports refs:', e);
  }
}

// ─────────────────────────────────────────────
// 2. Students (localStorage)
// ─────────────────────────────────────────────
export async function getStudents() {
  try {
    return JSON.parse(localStorage.getItem('students') || '[]');
  } catch (e) {
    return [];
  }
}

export async function saveStudent(studentData) {
  if (!studentData.id) {
    studentData.id = 'stu_' + generateUUID();
  }
  const students = await getStudents();
  const idx = students.findIndex(s => s.id === studentData.id);
  if (idx !== -1) {
    students[idx] = studentData;
  } else {
    students.push(studentData);
  }
  localStorage.setItem('students', JSON.stringify(students));
  return studentData;
}

export async function deleteStudent(studentId) {
  let students = await getStudents();
  students = students.filter(s => s.id !== studentId);
  localStorage.setItem('students', JSON.stringify(students));

  // Purge grades references in localStorage
  try {
    let gradesList = JSON.parse(localStorage.getItem('grades') || '[]');
    gradesList.forEach(grade => {
      if (grade.scores && grade.scores[studentId]) {
        delete grade.scores[studentId];
      }
    });
    localStorage.setItem('grades', JSON.stringify(gradesList));
  } catch (e) {
    console.error('Error purging student grades in localStorage:', e);
  }

  // Clean IndexedDB incidents, messages, reports
  await deleteStudentIndexedDBRefs(studentId);
  return true;
}

// ─────────────────────────────────────────────
// 2b. Teachers (IndexedDB with Backend Sync)
// ─────────────────────────────────────────────
export async function getTeachers() {
  if (typeof window !== 'undefined' && navigator.onLine) {
    try {
      const res = await fetch('/api/teachers');
      if (res.ok) {
        const backendTeachers = await res.json();
        
        // Filter out non-teacher metadata objects (like { test: true }) from the list
        const validTeachers = Array.isArray(backendTeachers) 
          ? backendTeachers.filter(t => t && t.id && t.name) 
          : [];

        // Update local IndexedDB cache
        await txClear('teachers');
        for (const teacher of validTeachers) {
          await txPut('teachers', teacher);
        }
        return validTeachers;
      }
    } catch (e) {
      console.warn('Failed to fetch teachers from backend, falling back to IndexedDB cache:', e);
    }
  }

  try {
    return await txGetAll('teachers');
  } catch (e) {
    console.error('Error fetching teachers from IndexedDB:', e);
    return [];
  }
}

export async function saveTeacher(teacherData) {
  if (!teacherData.id) {
    teacherData.id = 'tch_' + generateUUID();
  }
  
  // Try syncing to backend first if online, to prevent saving locally if the backend rejects it (e.g. payload too large)
  if (typeof window !== 'undefined' && navigator.onLine) {
    try {
      const res = await fetch('/api/teachers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(teacherData)
      });
      if (!res.ok) {
        let errMsg = `Server sync failed with status ${res.status}`;
        try {
          const errPayload = await res.json();
          if (errPayload.error && errPayload.error.message) {
            errMsg = errPayload.error.message;
          }
        } catch (_) {}
        throw new Error(errMsg);
      }
    } catch (e) {
      console.error('Failed to sync saved teacher to backend:', e);
      throw e; // Bubble error up to prevent silent data loss/UI mismatch
    }
  }

  // Save locally in IndexedDB only if server sync succeeds or client is offline
  await txPut('teachers', teacherData);
  return teacherData;
}

export async function deleteTeacher(teacherId) {
  // Delete locally
  await txDelete('teachers', teacherId);
  
  // Clean up teacher attendance references
  try {
    const attendance = JSON.parse(localStorage.getItem('teacher_attendance') || '[]');
    attendance.forEach(record => {
      if (record.records && record.records[teacherId]) {
        delete record.records[teacherId];
      }
    });
    localStorage.setItem('teacher_attendance', JSON.stringify(attendance));
  } catch (e) {
    console.error('Error cleaning teacher attendance refs:', e);
  }

  // Delete from backend if online
  if (typeof window !== 'undefined' && navigator.onLine) {
    try {
      await fetch(`/api/teachers?id=${teacherId}`, {
        method: 'DELETE'
      });
    } catch (e) {
      console.warn('Failed to sync teacher deletion to backend:', e);
    }
  }
  return true;
}

export async function migrateTeachersToIndexedDb() {
  try {
    const localTeachersStr = localStorage.getItem('teachers');
    if (localTeachersStr) {
      const localTeachers = JSON.parse(localTeachersStr);
      if (Array.isArray(localTeachers) && localTeachers.length > 0) {
        console.log('Migrating teachers from localStorage to IndexedDB...');
        for (const teacher of localTeachers) {
          await txPut('teachers', teacher);
        }
      }
      localStorage.removeItem('teachers');
    }
  } catch (e) {
    console.error('Error migrating teachers to IndexedDB:', e);
  }
}

// ─────────────────────────────────────────────
// 3b. Teacher Attendance (localStorage)
// ─────────────────────────────────────────────
export async function getTeacherAttendance(dateStr) {
  try {
    const attendance = JSON.parse(localStorage.getItem('teacher_attendance') || '[]');
    const record = attendance.find(a => a.date === dateStr);
    return record ? record.records : {};
  } catch (e) {
    return {};
  }
}

export async function saveTeacherAttendance(dateStr, recordsMap) {
  try {
    const attendance = JSON.parse(localStorage.getItem('teacher_attendance') || '[]');
    const index = attendance.findIndex(a => a.date === dateStr);
    const newRecord = {
      id: index !== -1 ? attendance[index].id : 'tatt_' + generateUUID(),
      date: dateStr,
      records: recordsMap,
      savedAt: new Date().toISOString()
    };
    if (index !== -1) {
      attendance[index] = newRecord;
    } else {
      attendance.push(newRecord);
    }
    localStorage.setItem('teacher_attendance', JSON.stringify(attendance));
    return true;
  } catch (e) {
    throw new Error('Storage quota exceeded saving teacher attendance.');
  }
}

export async function getAllTeacherAttendanceHistory() {
  try {
    const attendance = JSON.parse(localStorage.getItem('teacher_attendance') || '[]');
    const formatted = attendance.map(a => ({
      date: a.date,
      marks: a.records,
      savedAt: a.savedAt
    }));
    return formatted.sort((a, b) => (b.date > a.date ? 1 : -1));
  } catch (e) {
    return [];
  }
}

export async function deleteTeacherAttendanceRecord(dateStr) {
  try {
    let attendance = JSON.parse(localStorage.getItem('teacher_attendance') || '[]');
    attendance = attendance.filter(a => a.date !== dateStr);
    localStorage.setItem('teacher_attendance', JSON.stringify(attendance));
    return true;
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────
// 3. Attendance (localStorage)
// ─────────────────────────────────────────────
export async function getAttendance(dateStr, sectionId) {
  try {
    const attendance = JSON.parse(localStorage.getItem('attendance') || '[]');
    const record = attendance.find(a => a.date === dateStr && a.sectionId === sectionId);
    return record ? record.records : {};
  } catch (e) {
    return {};
  }
}

export async function saveAttendance(dateStr, sectionId, recordsMap) {
  try {
    const attendance = JSON.parse(localStorage.getItem('attendance') || '[]');
    const index = attendance.findIndex(a => a.date === dateStr && a.sectionId === sectionId);
    const newRecord = {
      id: index !== -1 ? attendance[index].id : 'att_' + generateUUID(),
      date: dateStr,
      sectionId,
      records: recordsMap,
      savedAt: new Date().toISOString()
    };
    if (index !== -1) {
      attendance[index] = newRecord;
    } else {
      attendance.push(newRecord);
    }
    localStorage.setItem('attendance', JSON.stringify(attendance));
    return true;
  } catch (e) {
    throw new Error('Storage quota exceeded saving attendance.');
  }
}

export async function getAllAttendanceHistory() {
  try {
    const attendance = JSON.parse(localStorage.getItem('attendance') || '[]');
    const formatted = attendance.map(a => ({
      date: a.date,
      sectionId: a.sectionId,
      marks: a.records,
      savedAt: a.savedAt
    }));
    return formatted.sort((a, b) => (b.date > a.date ? 1 : -1));
  } catch (e) {
    return [];
  }
}

export async function deleteAttendanceRecord(dateStr, sectionId) {
  try {
    let attendance = JSON.parse(localStorage.getItem('attendance') || '[]');
    attendance = attendance.filter(a => !(a.date === dateStr && a.sectionId === sectionId));
    localStorage.setItem('attendance', JSON.stringify(attendance));
    return true;
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────
// 4. Grades (localStorage)
// ─────────────────────────────────────────────
export async function getGradesForSubject(subName, sectionId) {
  try {
    const gradesList = JSON.parse(localStorage.getItem('grades') || '[]');
    const record = gradesList.find(g => g.subject === subName && g.sectionId === sectionId);
    if (!record) {
      return {
        id: 'grd_' + generateUUID(),
        sectionId,
        subject: subName,
        assignments: [],
        scores: {}
      };
    }
    return record;
  } catch (e) {
    return {
      id: 'grd_' + generateUUID(),
      sectionId,
      subject: subName,
      assignments: [],
      scores: {}
    };
  }
}

export async function saveGradesForSubject(subName, gradeData) {
  try {
    const gradesList = JSON.parse(localStorage.getItem('grades') || '[]');
    const index = gradesList.findIndex(g => g.id === gradeData.id || (g.subject === subName && g.sectionId === gradeData.sectionId));
    if (index !== -1) {
      gradesList[index] = gradeData;
    } else {
      if (!gradeData.id) gradeData.id = 'grd_' + generateUUID();
      gradeData.subject = subName;
      gradesList.push(gradeData);
    }
    localStorage.setItem('grades', JSON.stringify(gradesList));
    return true;
  } catch (e) {
    throw new Error('Storage quota exceeded saving grades.');
  }
}

// ─────────────────────────────────────────────
// 4b. IndexedDB to localStorage Migration on Startup
// ─────────────────────────────────────────────
export async function migrateIndexedDbToLocalStorage() {
  const sections = JSON.parse(localStorage.getItem('sections') || '[]');
  if (sections.length > 0) return; // already migrated or setup

  try {
    const idbStudents = await txGetAll('students');
    if (idbStudents.length === 0) return; // empty database

    console.log('Migrating existing IndexedDB database to relational localStorage...');

    const defaultSection = { id: 'sec_default', name: 'General Class' };
    localStorage.setItem('sections', JSON.stringify([defaultSection]));

    const migratedStudents = idbStudents.map(s => ({
      id: s.id,
      sectionId: 'sec_default',
      name: s.name,
      roll: s.roll,
      parentContact: s.parentContact,
      isIEP: s.isIEP || false,
      notes: s.notes || ''
    }));
    localStorage.setItem('students', JSON.stringify(migratedStudents));

    const idbAttendance = await txGetAll('attendance');
    const migratedAttendance = idbAttendance.map(a => ({
      id: 'att_' + generateUUID(),
      date: a.date,
      sectionId: 'sec_default',
      records: a.marks || {},
      savedAt: a.savedAt || new Date().toISOString()
    }));
    localStorage.setItem('attendance', JSON.stringify(migratedAttendance));

    const idbGrades = await txGetAll('grades');
    const migratedGrades = idbGrades.map(g => {
      const assignments = (g.assignments || []).map((name, i) => ({
        id: `a_${i}_` + generateUUID(),
        name,
        max: 100
      }));

      const scores = {};
      if (g.scores) {
        Object.entries(g.scores).forEach(([stuId, subjectScores]) => {
          scores[stuId] = {};
          if (subjectScores) {
            Object.entries(subjectScores).forEach(([assignName, val]) => {
              const matchingAssign = assignments.find(a => a.name === assignName);
              if (matchingAssign) {
                scores[stuId][matchingAssign.id] = val;
              }
            });
          }
        });
      }

      const subjectName = g.subject ? g.subject.replace(/_/g, ' ') : 'Subject';

      return {
        id: 'grd_' + generateUUID(),
        sectionId: 'sec_default',
        subject: subjectName,
        assignments,
        scores
      };
    });
    localStorage.setItem('grades', JSON.stringify(migratedGrades));

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Error during IndexedDB to localStorage migration:', err);
  }
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
