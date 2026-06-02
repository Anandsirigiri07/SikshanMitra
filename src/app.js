/**
 * K-12 Teacher Assistant - SPA Controller
 */
import * as db from './db.js';
import * as ai from './ai.js';
import { TRANSLATIONS } from './translations.js';

// ----------------------------------------------------
// Global State & Session Configurations
// ----------------------------------------------------
const state = {
  activeModule: 'dashboard',
  isOffline: !navigator.onLine,
  settings: {},
  students: [],
  teachers: [],
  sections: [],
  activeSectionId: '',
  selectedSubject: '',
  selectedStudentId: null,
  activeDate: new Date().toISOString().split('T')[0],
  attendanceType: 'student',
  scannerMode: 'register',
  activeStream: null
};

// ----------------------------------------------------
// Toast Notification Engine
// ----------------------------------------------------
export function showToast(message, type = 'success') {
  const container = document.getElementById('global-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${message}</span>
    <div class="toast-progress"></div>
  `;
  container.appendChild(toast);

  // Trigger entering animation transition, and set auto-dismiss
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.offsetHeight; // force reflow
    toast.style.animation = 'slideIn var(--transition-speed) reverse forwards';
    setTimeout(() => {
      toast.remove();
    }, 250);
  }, 2750);
}

// Helper to get active AI provider and key config
function getAiConfig() {
  const provider = state.settings.aiProvider || 'gemini';
  const apiKey = provider === 'groq' ? (state.settings.groqApiKey || '') : (state.settings.apiKey || '');
  return { apiKey, provider };
}

// ----------------------------------------------------
// PWA Installation Installer Engine
// ----------------------------------------------------
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent Chrome 67 and earlier from automatically showing the prompt
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  
  // Show install buttons
  const btnInstallMobile = document.getElementById('btn-install-mobile');
  const btnInstallSidebar = document.getElementById('btn-install-sidebar');
  if (btnInstallMobile) btnInstallMobile.classList.remove('hidden');
  if (btnInstallSidebar) btnInstallSidebar.classList.remove('hidden');
});

// Setup click event handlers for install buttons
const handleInstallClick = async () => {
  if (!deferredPrompt) return;
  // Show the prompt
  deferredPrompt.prompt();
  // Wait for the user to respond to the prompt
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User response to the install prompt: ${outcome}`);
  // We've used the prompt, and can't use it again, discard it
  deferredPrompt = null;
  
  // Hide install buttons
  const btnInstallMobile = document.getElementById('btn-install-mobile');
  const btnInstallSidebar = document.getElementById('btn-install-sidebar');
  if (btnInstallMobile) btnInstallMobile.classList.add('hidden');
  if (btnInstallSidebar) btnInstallSidebar.classList.add('hidden');
};

window.addEventListener('appinstalled', (evt) => {
  console.log('SikshanMitra was installed.');
  showToast('SikshanMitra installed successfully!', 'success');
});

// Mobile navigation drawer toggle controller
function setupMobileDrawer() {
  const toggleBtn = document.getElementById('mobile-menu-toggle');
  const sidebar = document.getElementById('global-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  
  const openDrawer = () => {
    sidebar?.classList.add('open');
    backdrop?.classList.remove('hidden');
  };
  
  const closeDrawer = () => {
    sidebar?.classList.remove('open');
    backdrop?.classList.add('hidden');
  };
  
  toggleBtn?.addEventListener('click', openDrawer);
  backdrop?.addEventListener('click', closeDrawer);
  
  // Close drawer automatically when selecting any navigation link
  const menuItems = document.querySelectorAll('.sidebar-menu .menu-item');
  menuItems.forEach(item => {
    item.addEventListener('click', closeDrawer);
  });
}

// ----------------------------------------------------

// Application Bootstrap & Lifecycle Router
// ----------------------------------------------------


document.addEventListener('DOMContentLoaded', () => {
  // Try register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('[PWA SW] Registered successfully:', reg.scope))
        .catch(err => console.warn('[PWA SW] Registration failed:', err));
    });
  }

  initApp();
});

async function initApp() {
  setupMobileDrawer();

  // Sync IndexedDB migration to localStorage if needed
  try {
    await db.migrateIndexedDbToLocalStorage();
    await db.migrateTeachersToIndexedDb();
  } catch (e) {
    console.warn('[initApp] Database migrations failed, continuing:', e);
  }

  // Sync state data from local storage/indexedDB
  state.settings = db.getSettings();
  try {
    state.sections = await db.getSections();
    // Auto-create a default section using the onboarding class name if none exists
    if (state.sections.length === 0 && state.settings.className) {
      const defaultSec = await db.saveSection({ name: state.settings.className });
      state.sections = [defaultSec];
      state.activeSectionId = defaultSec.id;
      localStorage.setItem('activeSectionId', state.activeSectionId);
    } else if (state.sections.length > 0) {
      const storedSec = localStorage.getItem('activeSectionId');
      if (storedSec && state.sections.some(s => s.id === storedSec)) {
        state.activeSectionId = storedSec;
      } else {
        state.activeSectionId = state.sections[0].id;
      }
    } else {
      state.activeSectionId = '';
    }
  } catch (err) {
    console.error('Error getting sections roster:', err);
    state.sections = [];
    state.activeSectionId = '';
  }

  try {
    state.students = await db.getStudents();
  } catch (err) {
    console.error('Error getting student roster:', err);
    state.students = [];
  }

  try {
    state.teachers = await db.getTeachers();
  } catch (err) {
    console.error('Error getting teacher roster:', err);
    state.teachers = [];
  }
  
  // Set default subject if settings has subjects list
  if (state.settings.subjects && state.settings.subjects.length > 0) {
    state.selectedSubject = state.settings.subjects[0];
  }

  // 1. Initial Launch Evaluation: Force onboarding if name or class is missing
  if (!state.settings.name || !state.settings.className) {
    document.getElementById('first-load-overlay').classList.remove('hidden');
  }

  // 2. Offline Listeners
  window.addEventListener('online', async () => {
    updateConnectivityStatus();
    await processAiQueue();
  });
  window.addEventListener('offline', updateConnectivityStatus);
  updateConnectivityStatus(); // run initial check

  // 3. Setup Navigation SPA Handlers
  setupNavigation();

  // Initialize and select active language in global selector
  const globalLangSel = document.getElementById('global-language-selector');
  if (globalLangSel) {
    globalLangSel.value = state.settings.language || 'en';
    globalLangSel.addEventListener('change', async (e) => {
      const newLang = e.target.value;
      state.settings.language = newLang;
      db.saveSettings(state.settings);
      
      const settingsLang = document.getElementById('settings-language');
      if (settingsLang) settingsLang.value = newLang;

      translatePage();
      await renderActiveModule();
      updateSidebarIdentity();
    });
  }

  const settingsLangSel = document.getElementById('settings-language');
  if (settingsLangSel) {
    settingsLangSel.value = state.settings.language || 'en';
    settingsLangSel.addEventListener('change', async (e) => {
      const newLang = e.target.value;
      state.settings.language = newLang;
      db.saveSettings(state.settings);
      
      const globalLang = document.getElementById('global-language-selector');
      if (globalLang) globalLang.value = newLang;

      translatePage();
      await renderActiveModule();
      updateSidebarIdentity();
    });
  }

  // 4. Setup Dynamic Form Forms and Elements Handlers
  setupEventBindings();

  // 5. Initialize the Active Section (Dashboard by default)
  await renderActiveModule();
  
  // Initial draw of sidebar labels
  updateSidebarIdentity();

  // Process any queued items on startup
  if (navigator.onLine) {
    await processAiQueue();
    await processAIRetryQueue();
  }

  // Setup interval to process retry queue every 60s
  setInterval(processAIRetryQueue, 60000);

  // 6. Bind PWA Install triggers
  document.getElementById('btn-install-mobile')?.addEventListener('click', handleInstallClick);
  document.getElementById('btn-install-sidebar')?.addEventListener('click', handleInstallClick);
}


function updateConnectivityStatus() {
  state.isOffline = !navigator.onLine;
  const offlineBanner = document.getElementById('offline-indicator');
  const mobileBanner = document.getElementById('mobile-offline-badge');
  const aiButtons = [
    document.getElementById('btn-generate-ai-lesson'),
    document.getElementById('btn-generate-ai-message'),
    document.getElementById('btn-generate-ai-report')
  ];

  const lang = state.settings.language || 'en';
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;

  if (state.isOffline) {
    if (offlineBanner) offlineBanner.classList.remove('hidden');
    if (mobileBanner) mobileBanner.classList.remove('hidden');
    
    // Do NOT disable AI buttons; we allow offline queueing
    aiButtons.forEach(btn => {
      if (btn) {
        btn.disabled = false;
        const textSpan = btn.querySelector('span');
        if (textSpan) {
          if (btn.id === 'btn-generate-ai-lesson') textSpan.innerText = dict['Queue Lesson Plan (Offline)'] || 'Queue Lesson Plan (Offline)';
          if (btn.id === 'btn-generate-ai-message') textSpan.innerText = dict['Queue Message Draft (Offline)'] || 'Queue Message Draft (Offline)';
          if (btn.id === 'btn-generate-ai-report') textSpan.innerText = dict['Queue Progress Report (Offline)'] || 'Queue Progress Report (Offline)';
        }
      }
    });
    showToast(dict['Outside cellular coverage. Switched to offline local database mode.'] || 'Outside cellular coverage. Switched to offline local database mode.', 'error');
  } else {
    if (offlineBanner) offlineBanner.classList.add('hidden');
    if (mobileBanner) mobileBanner.classList.add('hidden');
    
    // Reactivate AI configurations
    aiButtons.forEach(btn => {
      if (btn) {
        btn.disabled = false;
        const textSpan = btn.querySelector('span');
        if (textSpan) {
          if (btn.id === 'btn-generate-ai-lesson') textSpan.innerText = dict['Gemini AI Auto-Generate'] || 'Gemini AI Auto-Generate';
          if (btn.id === 'btn-generate-ai-message') textSpan.innerText = dict['Build Empathetic Draft via Gemini'] || 'Build Empathetic Draft via Gemini';
          if (btn.id === 'btn-generate-ai-report') textSpan.innerText = dict['Synthesize Progress Assessment (AI)'] || 'Synthesize Progress Assessment (AI)';
        }
      }
    });
  }
}

function updateSidebarIdentity() {
  const lang = state.settings.language || 'en';
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  const classLabel = dict["Class: "] || "Class: ";

  const footerClassTag = document.getElementById('footer-class-tag');
  if (footerClassTag && state.settings.className) {
    footerClassTag.innerText = `${classLabel}${state.settings.className}`;
  }
  const schoolBadge = document.getElementById('dash-school-badge');
  if (schoolBadge) {
    schoolBadge.innerText = state.settings.school || (dict["Configure School in Settings"] || 'Configure School in Settings');
  }
}

function setupNavigation() {
  const menuButtons = document.querySelectorAll('.sidebar-menu .menu-item');
  menuButtons.forEach(button => {
    button.addEventListener('click', async () => {
      // Toggle button states
      menuButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      // Change target active display module section
      const target = button.getAttribute('data-target');
      state.activeModule = target;
      
      // Update UI Views
      await renderActiveModule();
    });
  });
}

async function renderActiveModule() {
  // Hide all sections first
  document.querySelectorAll('.module-section').forEach(sec => sec.classList.add('hidden'));

  // Show active section
  const activeSectionElem = document.getElementById(`module-${state.activeModule}`);
  if (activeSectionElem) {
    activeSectionElem.classList.remove('hidden');
  }

  // Inject and render the universal section selector if applicable
  const sectionScopedModules = ['dashboard', 'students', 'attendance', 'grades', 'messages', 'reports'];
  if (sectionScopedModules.includes(state.activeModule) && !(state.activeModule === 'attendance' && state.attendanceType === 'teacher')) {
    renderUniversalSectionSelector(state.activeModule);
    if (state.sections.length === 0) {
      translatePage();
      if (window.lucide) window.lucide.createIcons();
      return;
    }
  } else if (state.activeModule === 'attendance' && state.attendanceType === 'teacher') {
    const container = document.querySelector(`#module-attendance .universal-section-selector-container`);
    if (container) container.innerHTML = '';
  }

  // Refresh data indices based on mounted module screen
  switch (state.activeModule) {
    case 'dashboard':
      await renderDashboard();
      break;
    case 'students':
      renderStudents();
      break;
    case 'teachers':
      renderTeachers();
      break;
    case 'attendance':
      {
        const btnFaceScan = document.getElementById('btn-face-attendance-scan');
        if (btnFaceScan) {
          const btnViewDaily = document.getElementById('btn-view-daily-attendance');
          if (state.attendanceType === 'teacher' && btnViewDaily && btnViewDaily.classList.contains('active')) {
            btnFaceScan.classList.remove('hidden');
          } else {
            btnFaceScan.classList.add('hidden');
          }
        }
        await renderAttendance();
      }
      break;
    case 'grades':
      await renderGrades();
      break;
    case 'planner':
      await renderLessonsSchedules();
      break;
    case 'incidents':
      await renderIncidents();
      break;
    case 'messages':
      renderParentMessages();
      break;
    case 'reports':
      await renderProgressReports();
      break;
    case 'settings':
      renderSettings();
      break;
  }

  // Translate all active page text nodes to user's preferred language configuration
  translatePage();

  // Re-generate vector SVG icons in the active page using Lucide SDK
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

async function handleAddSectionSubmit(inputEl, countEl) {
  if (!inputEl) return;
  const prefix = inputEl.value.trim();
  if (!prefix) return;

  const count = countEl ? parseInt(countEl.value) : 1;
  if (isNaN(count) || count < 1) {
    showToast('Please enter a valid number of sections.', 'error');
    return;
  }
  if (count > 26) {
    showToast('Maximum of 26 sections can be generated at once.', 'error');
    return;
  }

  try {
    let createdCount = 0;
    let lastCreatedSec = null;
    let duplicateCount = 0;

    if (count === 1) {
      const name = prefix;
      if (state.sections.some(s => s.name.toLowerCase() === name.toLowerCase())) {
        showToast(`Section "${name}" is already in your database.`, 'error');
        return;
      }
      lastCreatedSec = await db.saveSection({ name });
      createdCount = 1;
    } else {
      for (let i = 0; i < count; i++) {
        const letter = String.fromCharCode(65 + i); // 'A', 'B', 'C', etc.
        const name = `${prefix} - ${letter}`;
        if (state.sections.some(s => s.name.toLowerCase() === name.toLowerCase())) {
          duplicateCount++;
          continue;
        }
        lastCreatedSec = await db.saveSection({ name });
        createdCount++;
      }
    }

    state.sections = await db.getSections();
    
    // If this is the first section, make it active
    if (!state.activeSectionId && lastCreatedSec) {
      state.activeSectionId = lastCreatedSec.id;
      localStorage.setItem('activeSectionId', state.activeSectionId);
    }

    inputEl.value = '';
    if (countEl) countEl.value = '1';
    
    renderSettingsSections();
    renderDashboardSections();
    
    if (createdCount > 0) {
      let msg = `Successfully created ${createdCount} section(s).`;
      if (duplicateCount > 0) {
        msg += ` (Skipped ${duplicateCount} duplicate(s))`;
      }
      showToast(msg, 'success');
    } else if (duplicateCount > 0) {
      showToast('All generated sections already exist in the database.', 'error');
    }
    
    // Refresh active module to clear any warning or update dropdown
    await renderActiveModule();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ----------------------------------------------------
// EVENT BINDINGS (Forms Submissions, Modals, Clicks)
// ----------------------------------------------------
function setupEventBindings() {
  // 1. Onboarding configuration handler
  const onboardingForm = document.getElementById('onboarding-form');
  if (onboardingForm) {
    onboardingForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const teacherName = document.getElementById('onboarding-teacher-name').value;
        const className = document.getElementById('onboarding-class-name').value;
        const schoolName = document.getElementById('onboarding-school-name').value;
        const apiKeyEl = document.getElementById('onboarding-api-key');
        const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';

        const record = {
          name: teacherName,
          className: className,
          school: schoolName,
          apiKey: apiKey,
          subjects: db.getSettings().subjects
        };

        db.saveSettings(record);
        state.settings = record;
        
        // Auto-create a default section using the onboarding class name
        const defaultSec = await db.saveSection({ name: className });
        state.sections = await db.getSections();
        state.activeSectionId = defaultSec.id;
        localStorage.setItem('activeSectionId', state.activeSectionId);
        
        // Hide onboarding modal, trigger renders
        document.getElementById('first-load-overlay').classList.add('hidden');
        updateSidebarIdentity();
        renderActiveModule();
        showToast('Onboarding succeeded! Welcome to your digital Workspace assistant.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // 2. New Student Form Drawer toggle triggers
  const btnShowAddStudent = document.getElementById('btn-show-add-student');
  const studentFormPanel = document.getElementById('student-form-panel');
  if (btnShowAddStudent && studentFormPanel) {
    btnShowAddStudent.addEventListener('click', () => {
      document.getElementById('student-entry-form').reset();
      document.getElementById('student-idx').value = '';
      document.getElementById('student-form-title').innerText = 'Register New Student Profile';
      
      // Populate section options in form and set activeSectionId
      const selectFormSection = document.getElementById('student-section-id');
      if (selectFormSection) {
        selectFormSection.innerHTML = state.sections.map(sec => 
          `<option value="${sec.id}">${sec.name}</option>`
        ).join('');
        selectFormSection.value = state.activeSectionId;
      }
      
      studentFormPanel.classList.remove('hidden');
      studentFormPanel.scrollIntoView({ behavior: 'smooth' });
    });
  }

  const btnCancelStudent = document.getElementById('btn-cancel-student');
  if (btnCancelStudent && studentFormPanel) {
    btnCancelStudent.addEventListener('click', () => {
      studentFormPanel.classList.add('hidden');
    });
  }

  // Save student profile submit trigger
  const studentEntryForm = document.getElementById('student-entry-form');
  if (studentEntryForm) {
    studentEntryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const id = document.getElementById('student-idx').value || null;
        const name = document.getElementById('student-name').value;
        const roll = document.getElementById('student-roll').value;
        const parentContact = document.getElementById('student-parent').value;
        const sectionId = document.getElementById('student-section-id').value;
        const isIEP = document.getElementById('student-iep').checked;
        const notes = document.getElementById('student-notes').value;

        await db.saveStudent({ id, name, roll, parentContact, sectionId, isIEP, notes });
        state.students = await db.getStudents(); // re-sync roster
        
        studentFormPanel.classList.add('hidden');
        renderStudents();
        showToast(`Student profile for "${name}" saved successfully.`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // 3. Live Student filter query search bar
  const studentSearchBar = document.getElementById('student-search-bar');
  if (studentSearchBar) {
    studentSearchBar.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const cards = document.querySelectorAll('#student-roster-grid .card');
      cards.forEach(card => {
        const searchableText = card.innerText.toLowerCase();
        if (searchableText.includes(q)) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });
    });
  }

  // 2b. New Teacher Form Drawer toggle triggers
  const btnShowAddTeacher = document.getElementById('btn-show-add-teacher');
  const teacherFormPanel = document.getElementById('teacher-form-panel');
  if (btnShowAddTeacher && teacherFormPanel) {
    btnShowAddTeacher.addEventListener('click', () => {
      document.getElementById('teacher-entry-form').reset();
      document.getElementById('teacher-idx').value = '';
      
      // Reset photo fields
      const photoInput = document.getElementById('teacher-photo-data');
      if (photoInput) photoInput.value = '';
      const photoImg = document.getElementById('teacher-photo-img');
      if (photoImg) {
        photoImg.src = '';
        photoImg.classList.add('hidden');
      }
      const placeholder = document.getElementById('teacher-photo-placeholder');
      if (placeholder) placeholder.classList.remove('hidden');
      const deleteBtn = document.getElementById('btn-delete-teacher-face');
      if (deleteBtn) deleteBtn.classList.add('hidden');

      document.getElementById('teacher-form-title').innerText = 'Register New Teacher Profile';
      teacherFormPanel.classList.remove('hidden');
      teacherFormPanel.scrollIntoView({ behavior: 'smooth' });
    });
  }

  const btnCancelTeacher = document.getElementById('btn-cancel-teacher');
  if (btnCancelTeacher && teacherFormPanel) {
    btnCancelTeacher.addEventListener('click', () => {
      teacherFormPanel.classList.add('hidden');
    });
  }

  // Save teacher profile submit trigger
  const teacherEntryForm = document.getElementById('teacher-entry-form');
  if (teacherEntryForm) {
    teacherEntryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const id = document.getElementById('teacher-idx').value || null;
        const name = document.getElementById('teacher-name').value;
        const code = document.getElementById('teacher-code').value;
        const contact = document.getElementById('teacher-contact').value;
        const dept = document.getElementById('teacher-dept').value;
        const notes = document.getElementById('teacher-notes').value;
        const photo = document.getElementById('teacher-photo-data').value || null;

        await db.saveTeacher({ id, name, code, contact, dept, notes, photo });
        state.teachers = await db.getTeachers(); // re-sync roster
        
        teacherFormPanel.classList.add('hidden');
        renderTeachers();
        showToast(`Teacher profile for "${name}" saved successfully.`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Hook up registration face scanner buttons
  const btnScanTeacherFace = document.getElementById('btn-scan-teacher-face');
  if (btnScanTeacherFace) {
    btnScanTeacherFace.addEventListener('click', () => {
      startFaceScanner('register');
    });
  }

  const btnDeleteTeacherFace = document.getElementById('btn-delete-teacher-face');
  if (btnDeleteTeacherFace) {
    btnDeleteTeacherFace.addEventListener('click', () => {
      const photoInput = document.getElementById('teacher-photo-data');
      if (photoInput) photoInput.value = '';
      const photoImg = document.getElementById('teacher-photo-img');
      if (photoImg) {
        photoImg.src = '';
        photoImg.classList.add('hidden');
      }
      const placeholder = document.getElementById('teacher-photo-placeholder');
      if (placeholder) placeholder.classList.remove('hidden');
      btnDeleteTeacherFace.classList.add('hidden');
      showToast('Face scan deleted.', 'info');
    });
  }

  // Live Teacher filter query search bar
  const teacherSearchBar = document.getElementById('teacher-search-bar');
  if (teacherSearchBar) {
    teacherSearchBar.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const cards = document.querySelectorAll('#teacher-roster-grid .card');
      cards.forEach(card => {
        const searchableText = card.innerText.toLowerCase();
        if (searchableText.includes(q)) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });
    });
  }

  // Attendance Type Toggle (Student vs Teacher)
  const btnTypeStudent = document.getElementById('btn-attendance-type-student');
  const btnTypeTeacher = document.getElementById('btn-attendance-type-teacher');

  if (btnTypeStudent && btnTypeTeacher) {
    btnTypeStudent.addEventListener('click', async () => {
      state.attendanceType = 'student';
      btnTypeStudent.classList.add('active', 'btn-primary');
      btnTypeStudent.classList.remove('btn-secondary');
      btnTypeTeacher.classList.add('btn-secondary');
      btnTypeTeacher.classList.remove('active', 'btn-primary');

      const btnFaceScan = document.getElementById('btn-face-attendance-scan');
      if (btnFaceScan) btnFaceScan.classList.add('hidden');

      // Re-render universal section selector & active module register
      renderUniversalSectionSelector('attendance');
      
      const btnViewDaily = document.getElementById('btn-view-daily-attendance');
      if (btnViewDaily && btnViewDaily.classList.contains('active')) {
        await renderAttendance();
      } else {
        await renderAttendanceHistory();
      }
    });

    btnTypeTeacher.addEventListener('click', async () => {
      state.attendanceType = 'teacher';
      btnTypeTeacher.classList.add('active', 'btn-primary');
      btnTypeTeacher.classList.remove('btn-secondary');
      btnTypeStudent.classList.add('btn-secondary');
      btnTypeStudent.classList.remove('active', 'btn-primary');

      const btnFaceScan = document.getElementById('btn-face-attendance-scan');
      if (btnFaceScan) {
        const btnViewDaily = document.getElementById('btn-view-daily-attendance');
        if (btnViewDaily && btnViewDaily.classList.contains('active')) {
          btnFaceScan.classList.remove('hidden');
        } else {
          btnFaceScan.classList.add('hidden');
        }
      }

      // Clear section selector since teachers are school-wide
      const container = document.querySelector('#module-attendance .universal-section-selector-container');
      if (container) container.innerHTML = '';

      const btnViewDaily = document.getElementById('btn-view-daily-attendance');
      if (btnViewDaily && btnViewDaily.classList.contains('active')) {
        await renderAttendance();
      } else {
        await renderAttendanceHistory();
      }
    });
  }

  // Attendance Tracker Tab Controls
  const btnViewDaily = document.getElementById('btn-view-daily-attendance');
  const btnViewHistory = document.getElementById('btn-view-attendance-history');
  const attDailyTab = document.getElementById('attendance-daily-tab');
  const attHistoryTab = document.getElementById('attendance-history-tab');

  if (btnViewDaily && btnViewHistory) {
    btnViewDaily.addEventListener('click', async () => {
      btnViewDaily.classList.add('active', 'btn-primary');
      btnViewDaily.classList.remove('btn-secondary');
      btnViewHistory.classList.add('btn-secondary');
      btnViewHistory.classList.remove('active', 'btn-primary');
      
      attDailyTab.classList.remove('hidden');
      attHistoryTab.classList.add('hidden');

      const btnFaceScan = document.getElementById('btn-face-attendance-scan');
      if (btnFaceScan) {
        if (state.attendanceType === 'teacher') {
          btnFaceScan.classList.remove('hidden');
        } else {
          btnFaceScan.classList.add('hidden');
        }
      }

      await renderAttendance();
    });

    btnViewHistory.addEventListener('click', async () => {
      btnViewHistory.classList.add('active', 'btn-primary');
      btnViewHistory.classList.remove('btn-secondary');
      btnViewDaily.classList.add('btn-secondary');
      btnViewDaily.classList.remove('active', 'btn-primary');

      attDailyTab.classList.add('hidden');
      attHistoryTab.classList.remove('hidden');

      const btnFaceScan = document.getElementById('btn-face-attendance-scan');
      if (btnFaceScan) btnFaceScan.classList.add('hidden');

      await renderAttendanceHistory();
    });
  }

  // Hook up attendance face check-in trigger
  const btnFaceAttendanceScan = document.getElementById('btn-face-attendance-scan');
  if (btnFaceAttendanceScan) {
    btnFaceAttendanceScan.addEventListener('click', () => {
      startFaceScanner('attendance');
    });
  }

  // Face scanner modal closing and action buttons
  const btnCloseFaceScanner = document.getElementById('btn-close-face-scanner');
  if (btnCloseFaceScanner) {
    btnCloseFaceScanner.addEventListener('click', () => {
      stopFaceScanner();
    });
  }

  const faceScannerModal = document.getElementById('face-scanner-modal');
  if (faceScannerModal) {
    faceScannerModal.addEventListener('click', (e) => {
      if (e.target === faceScannerModal) {
        stopFaceScanner();
      }
    });
  }

  const btnTriggerFaceScan = document.getElementById('btn-trigger-face-scan');
  if (btnTriggerFaceScan) {
    btnTriggerFaceScan.addEventListener('click', async () => {
      const video = document.getElementById('camera-video');
      const canvas = document.getElementById('camera-canvas');
      const progressOverlay = document.getElementById('scanner-progress-overlay');
      const progressCircle = document.getElementById('progress-circle');
      const progressText = document.getElementById('progress-text');
      const statusOverlay = document.getElementById('scanner-status-overlay');
      const scanLine = document.getElementById('scan-line');
      
      if (!video || !canvas) return;

      btnTriggerFaceScan.disabled = true;
      const textSpan = btnTriggerFaceScan.querySelector('span');
      if (textSpan) textSpan.innerText = 'Scanning...';
      
      // Hide camera error msg if displayed
      const errorMsg = document.getElementById('camera-error-msg');
      if (errorMsg) {
        errorMsg.classList.add('hidden');
        errorMsg.innerText = '';
      }

      statusOverlay.innerText = 'Freezing biometric profile...';

      const size = Math.min(video.videoWidth, video.videoHeight) || 300;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      
      const sx = (video.videoWidth - size) / 2;
      const sy = (video.videoHeight - size) / 2;
      
      // Capture static video frame to off-screen canvas
      const offscreen = document.createElement('canvas');
      offscreen.width = size;
      offscreen.height = size;
      const oCtx = offscreen.getContext('2d');
      oCtx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
      
      // Show canvas and pause/hide video
      canvas.classList.remove('hidden');
      video.classList.add('hidden');
      video.pause();
      if (scanLine) scanLine.classList.add('hidden');

      progressOverlay.classList.remove('hidden');
      
      // Run face detection (landmarks & descriptors) in background
      let landmarks = null;
      let descriptor = null;
      let detectionCompleted = false;
      let detectionError = null;

      async function runDetection() {
        try {
          await loadFaceApiModels();
          const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 });
          const detection = await faceapi.detectSingleFace(offscreen, options)
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (detection) {
            landmarks = detection.landmarks;
            descriptor = detection.descriptor;
          } else {
            detectionError = 'Face not detected';
          }
        } catch (err) {
          console.error('Biometric scan background detection error:', err);
          detectionError = err.message;
        } finally {
          detectionCompleted = true;
        }
      }
      
      runDetection();

      let progress = 0;
      const interval = setInterval(() => {
        progress += 2; // Increments to 100 over 2 seconds (50 iterations)
        
        // Draw static face frame
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(offscreen, 0, 0);
        
        if (landmarks) {
          drawBiometricOverlay(canvas, landmarks, progress);
          statusOverlay.innerText = 'Locking Biometrics...';
        } else if (detectionError) {
          statusOverlay.innerText = 'Analyzing face structure...';
        } else {
          statusOverlay.innerText = 'Detecting facial geometry...';
        }

        if (progress >= 100) {
          clearInterval(interval);
          
          if (detectionError || !landmarks) {
            // Restore camera visibility for retries
            canvas.classList.add('hidden');
            video.classList.remove('hidden');
            video.play();
            if (scanLine) scanLine.classList.remove('hidden');
            progressOverlay.classList.add('hidden');
            
            statusOverlay.innerText = 'Scan Failed';
            
            if (errorMsg) {
              errorMsg.innerText = detectionError === 'Face not detected'
                ? 'Verification Failed. Face not detected in frame. Please align your face in the center and try again.'
                : 'Verification Failed. Error reading biometric landmarks.';
              errorMsg.classList.remove('hidden');
            }
            showToast('Biometric scanning failed. Please try again.', 'error');
            
            btnTriggerFaceScan.disabled = false;
            if (textSpan) {
              textSpan.innerText = state.scannerMode === 'register' ? 'Scan Face' : 'Match & Verify';
            }
            return;
          }

          // Scan succeeded
          const dataUrl = offscreen.toDataURL('image/jpeg', 0.85);
          finishScan(dataUrl, descriptor);
        } else {
          progressText.innerText = `${progress}%`;
          if (progressCircle) {
            progressCircle.setAttribute('stroke-dasharray', `${progress}, 100`);
          }
        }
      }, 40); // 40ms * 50 = 2000ms
    });
  }

  // 4. Attendance tracker Date picker listener
  const attendanceDateChange = document.getElementById('attendance-date-picker');
  if (attendanceDateChange) {
    attendanceDateChange.value = state.activeDate;
    attendanceDateChange.addEventListener('change', async (e) => {
      state.activeDate = e.target.value;
      await renderAttendance();
    });
  }

  // Print Daily Attendance register trigger
  const btnPrintAttendance = document.getElementById('btn-print-attendance');
  if (btnPrintAttendance) {
    btnPrintAttendance.addEventListener('click', async () => {
      if (state.attendanceType === 'teacher') {
        if (state.teachers.length === 0) {
          showToast('No teachers registered to print.', 'error');
          return;
        }

        const marksMap = await db.getTeacherAttendance(state.activeDate);
        const dateObj = new Date(state.activeDate + 'T00:00:00');
        const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        let presentCount = 0, absentCount = 0, lateCount = 0;
        let rowsHtml = '';

        state.teachers.forEach(teacher => {
          const status = marksMap[teacher.id] || '';
          let displayStatus = 'Unmarked';
          let statusClass = '';

          if (status === 'present') {
            presentCount++;
            displayStatus = 'Present';
            statusClass = 'status-present';
          } else if (status === 'absent') {
            absentCount++;
            displayStatus = 'Absent';
            statusClass = 'status-absent';
          } else if (status === 'late') {
            lateCount++;
            displayStatus = 'Late';
            statusClass = 'status-late';
          }

          rowsHtml += `
            <tr>
              <td>${teacher.code || ''}</td>
              <td><strong>${teacher.name}</strong></td>
              <td>${teacher.dept || ''}</td>
              <td class="${statusClass}">${displayStatus}</td>
              <td>${teacher.contact || ''}</td>
              <td style="width: 150px;"></td>
            </tr>
          `;
        });

        const printWindow = window.open('', '_blank', 'width=900,height=700');
        if (!printWindow) {
          showToast('Print popup blocked by browser. Please allow popups for this page.', 'error');
          return;
        }

        printWindow.document.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Teacher Attendance Register</title>
            <style>
              body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #000; padding: 30px; margin: 0; line-height: 1.4; }
              .header { text-align: center; margin-bottom: 25px; border-bottom: 2px double #333; padding-bottom: 15px; }
              .header h1 { margin: 0 0 5px 0; font-size: 22px; text-transform: uppercase; letter-spacing: 0.5px; }
              .header p { margin: 0; font-size: 13px; color: #555; }
              .meta-section { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; font-size: 13px; background: #f8f9fa; padding: 12px 18px; border-radius: 6px; border: 1px solid #ddd; }
              .meta-item { display: flex; gap: 8px; }
              .meta-label { font-weight: bold; color: #444; width: 110px; }
              .stats-bar { display: flex; gap: 15px; margin-bottom: 15px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
              .stat-badge { padding: 3px 8px; border-radius: 4px; border: 1px solid #ccc; }
              .stat-present { background-color: #e2f0d9; border-color: #385723; color: #385723; }
              .stat-absent { background-color: #fce4d6; border-color: #c65911; color: #c65911; }
              .stat-late { background-color: #fff2cc; border-color: #833c0c; color: #833c0c; }
              .roster-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
              .roster-table th, .roster-table td { border: 1px solid #aaa; padding: 6px 10px; text-align: left; font-size: 12px; }
              .roster-table th { background-color: #f1f3f5; font-weight: bold; text-transform: uppercase; font-size: 11px; color: #333; }
              .status-present { font-weight: 600; color: #2e7d32; }
              .status-absent { font-weight: 600; color: #c62828; text-decoration: underline; }
              .status-late { font-weight: 600; color: #ef6c00; }
              .footer { margin-top: 60px; display: flex; justify-content: space-between; font-size: 12px; }
              .signature-box { border-top: 1px dashed #000; width: 220px; text-align: center; padding-top: 6px; }
              @media print {
                body { padding: 0; }
                .meta-section { background: none; border: 1px solid #000; }
                .stat-badge { border: 1px solid #000; background: none; color: #000; }
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>SikshanMitra Teacher Attendance Register</h1>
              <p>Official School Faculty Attendance Ledger</p>
            </div>

            <div class="meta-section">
              <div>
                <div class="meta-item"><span class="meta-label">Register Type:</span><span>Staff Faculty Roster</span></div>
                <div class="meta-item"><span class="meta-label">Authorizer:</span><span>${state.settings.name || 'Not Specified'}</span></div>
              </div>
              <div>
                <div class="meta-item"><span class="meta-label">Date File:</span><span>${formattedDate}</span></div>
                <div class="meta-item"><span class="meta-label">School:</span><span>${state.settings.school || 'Not Specified'}</span></div>
              </div>
            </div>

            <div class="stats-bar">
              <span class="stat-badge">Total Faculty: ${state.teachers.length}</span>
              <span class="stat-badge stat-present">Present: ${presentCount}</span>
              <span class="stat-badge stat-absent">Absent: ${absentCount}</span>
              <span class="stat-badge stat-late">Late: ${lateCount}</span>
            </div>

            <table class="roster-table">
              <thead>
                <tr>
                  <th style="width: 80px;">Teacher Code</th>
                  <th>Teacher Name</th>
                  <th>Department / Subject</th>
                  <th style="width: 100px;">Status</th>
                  <th style="width: 180px;">Contact Info</th>
                  <th>Faculty Signature / Notes</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>

            <div class="footer">
              <div>
                <p style="margin: 0; font-size: 10px; color: #777;">Generated via SikshanMitra PWA Workspace • Local Time: ${new Date().toLocaleString()}</p>
              </div>
              <div class="signature-box" style="margin-top: 20px;">
                <strong>School Principal / Authorizer Signature</strong>
              </div>
            </div>

            <script>
              window.onload = function() {
                window.print();
                setTimeout(function() { window.close(); }, 500);
              };
            </script>
          </body>
          </html>
        `);
        printWindow.document.close();
      } else {
        const sectionStudents = getStudentsBySection(state.activeSectionId);
        if (sectionStudents.length === 0) {
          showToast('No students registered in this section to print.', 'error');
          return;
        }

        const activeSection = state.sections.find(s => s.id === state.activeSectionId);
        const sectionName = activeSection ? activeSection.name : 'Unknown Section';
        const marksMap = await db.getAttendance(state.activeDate, state.activeSectionId);

        const dateObj = new Date(state.activeDate + 'T00:00:00');
        const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        let presentCount = 0, absentCount = 0, lateCount = 0;
        let rowsHtml = '';

        sectionStudents.forEach(student => {
          const status = marksMap[student.id] || '';
          let displayStatus = 'Unmarked';
          let statusClass = '';

          if (status === 'present') {
            presentCount++;
            displayStatus = 'Present';
            statusClass = 'status-present';
          } else if (status === 'absent') {
            absentCount++;
            displayStatus = 'Absent';
            statusClass = 'status-absent';
          } else if (status === 'late') {
            lateCount++;
            displayStatus = 'Late';
            statusClass = 'status-late';
          }

          rowsHtml += `
            <tr>
              <td>${student.roll || ''}</td>
              <td><strong>${student.name}</strong></td>
              <td>${student.isIEP ? 'IEP' : 'General'}</td>
              <td class="${statusClass}">${displayStatus}</td>
              <td>${student.parentContact || ''}</td>
              <td style="width: 150px;"></td>
            </tr>
          `;
        });

        const printWindow = window.open('', '_blank', 'width=900,height=700');
        if (!printWindow) {
          showToast('Print popup blocked by browser. Please allow popups for this page.', 'error');
          return;
        }

        printWindow.document.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Attendance Register - ${sectionName}</title>
            <style>
              body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #000; padding: 30px; margin: 0; line-height: 1.4; }
              .header { text-align: center; margin-bottom: 25px; border-bottom: 2px double #333; padding-bottom: 15px; }
              .header h1 { margin: 0 0 5px 0; font-size: 22px; text-transform: uppercase; letter-spacing: 0.5px; }
              .header p { margin: 0; font-size: 13px; color: #555; }
              .meta-section { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; font-size: 13px; background: #f8f9fa; padding: 12px 18px; border-radius: 6px; border: 1px solid #ddd; }
              .meta-item { display: flex; gap: 8px; }
              .meta-label { font-weight: bold; color: #444; width: 110px; }
              .stats-bar { display: flex; gap: 15px; margin-bottom: 15px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
              .stat-badge { padding: 3px 8px; border-radius: 4px; border: 1px solid #ccc; }
              .stat-present { background-color: #e2f0d9; border-color: #385723; color: #385723; }
              .stat-absent { background-color: #fce4d6; border-color: #c65911; color: #c65911; }
              .stat-late { background-color: #fff2cc; border-color: #833c0c; color: #833c0c; }
              .roster-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
              .roster-table th, .roster-table td { border: 1px solid #aaa; padding: 6px 10px; text-align: left; font-size: 12px; }
              .roster-table th { background-color: #f1f3f5; font-weight: bold; text-transform: uppercase; font-size: 11px; color: #333; }
              .status-present { font-weight: 600; color: #2e7d32; }
              .status-absent { font-weight: 600; color: #c62828; text-decoration: underline; }
              .status-late { font-weight: 600; color: #ef6c00; }
              .footer { margin-top: 60px; display: flex; justify-content: space-between; font-size: 12px; }
              .signature-box { border-top: 1px dashed #000; width: 220px; text-align: center; padding-top: 6px; }
              @media print {
                body { padding: 0; }
                .meta-section { background: none; border: 1px solid #000; }
                .stat-badge { border: 1px solid #000; background: none; color: #000; }
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>SikshanMitra Attendance Register</h1>
              <p>Official Analog Roster Report File & Classroom Verification Ledger</p>
            </div>

            <div class="meta-section">
              <div>
                <div class="meta-item"><span class="meta-label">Class/Section:</span><span>${sectionName}</span></div>
                <div class="meta-item"><span class="meta-label">Teacher:</span><span>${state.settings.name || 'Not Specified'}</span></div>
              </div>
              <div>
                <div class="meta-item"><span class="meta-label">Date File:</span><span>${formattedDate}</span></div>
                <div class="meta-item"><span class="meta-label">School:</span><span>${state.settings.school || 'Not Specified'}</span></div>
              </div>
            </div>

            <div class="stats-bar">
              <span class="stat-badge">Total Roster: ${sectionStudents.length}</span>
              <span class="stat-badge stat-present">Present: ${presentCount}</span>
              <span class="stat-badge stat-absent">Absent: ${absentCount}</span>
              <span class="stat-badge stat-late">Late: ${lateCount}</span>
            </div>

            <table class="roster-table">
              <thead>
                <tr>
                  <th style="width: 80px;">Roll No</th>
                  <th>Student Name</th>
                  <th style="width: 90px;">Category</th>
                  <th style="width: 100px;">Status</th>
                  <th style="width: 130px;">Parent Contact</th>
                  <th>Teacher Notes / Physical Signature</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>

            <div class="footer">
              <div>
                <p style="margin: 0; font-size: 10px; color: #777;">Generated via SikshanMitra PWA Workspace • Local Time: ${new Date().toLocaleString()}</p>
              </div>
              <div class="signature-box" style="margin-top: 20px;">
                <strong>Classroom Instructor Signature</strong>
              </div>
            </div>

            <script>
              window.onload = function() {
                window.print();
                setTimeout(function() { window.close(); }, 500);
              };
            </script>
          </body>
          </html>
        `);
        printWindow.document.close();
      }
    });
  }

  // 5. Grade Subject picker dropdown select triggers
  const gradesSubjectSelect = document.getElementById('grades-subject-select');
  if (gradesSubjectSelect) {
    gradesSubjectSelect.addEventListener('change', async (e) => {
      state.selectedSubject = e.target.value;
      await renderGrades();
    });
  }

  // Grades Add column button
  const gradesAddAssignmentBtn = document.getElementById('grades-add-assignment-btn');
  if (gradesAddAssignmentBtn) {
    gradesAddAssignmentBtn.addEventListener('click', async () => {
      if (!state.selectedSubject) {
        showToast('Please set up an active Subject before adding Assignments.', 'error');
        return;
      }
      const assignName = prompt("Enter a label for the new coursework / exam column:");
      if (!assignName || assignName.trim() === '') return;

      try {
        const gradesSchema = await db.getGradesForSubject(state.selectedSubject, state.activeSectionId);
        if (gradesSchema.assignments.some(a => a.name.toLowerCase() === assignName.trim().toLowerCase())) {
          showToast('An assignment with that exact name already exists in this ledger.', 'error');
          return;
        }
        const newAssignId = 'assign_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        gradesSchema.assignments.push({ id: newAssignId, name: assignName.trim(), max: 100 });
        await db.saveGradesForSubject(state.selectedSubject, gradesSchema);
        await renderGrades();
        showToast(`Coursework column "${assignName}" added to ${state.selectedSubject}.`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Grades Export CSV Button
  const gradesExportCsvBtn = document.getElementById('grades-export-csv-btn');
  if (gradesExportCsvBtn) {
    gradesExportCsvBtn.addEventListener('click', async () => {
      if (!state.selectedSubject) return;
      await exportTableToCSV(state.selectedSubject);
    });
  }

  // 6. Lesson Planner Tab Controls
  const btnViewSaved = document.getElementById('btn-view-saved-lessons');
  const btnViewEditor = document.getElementById('btn-view-lesson-editor');
  const plannerSavedTab = document.getElementById('planner-saved-plans-tab');
  const plannerEditorTab = document.getElementById('planner-editor-tab');

  if (btnViewSaved && btnViewEditor) {
    btnViewSaved.addEventListener('click', async () => {
      btnViewSaved.classList.add('active', 'btn-primary');
      btnViewSaved.classList.remove('btn-secondary');
      btnViewEditor.classList.add('btn-secondary');
      btnViewEditor.classList.remove('active', 'btn-primary');
      
      plannerSavedTab.classList.remove('hidden');
      plannerEditorTab.classList.add('hidden');
      await renderLessonsSchedules();
    });

    btnViewEditor.addEventListener('click', () => {
      btnViewEditor.classList.add('active', 'btn-primary');
      btnViewEditor.classList.remove('btn-secondary');
      btnViewSaved.classList.add('btn-secondary');
      btnViewSaved.classList.remove('active', 'btn-primary');

      plannerSavedTab.classList.add('hidden');
      plannerEditorTab.classList.remove('hidden');
      
      // Load current form structures
      populateLessonFormSubjects();
    });
  }

  // Add Subject inside Lesson Planner trigger
  const btnPlannerAddSubject = document.getElementById('btn-planner-add-subject');
  if (btnPlannerAddSubject) {
    btnPlannerAddSubject.addEventListener('click', () => {
      const val = prompt('Enter name of the new Subject:');
      if (val === null) return;
      const trimmed = val.trim();
      if (!trimmed) {
        showToast('Subject name cannot be empty.', 'error');
        return;
      }

      if (state.settings.subjects.includes(trimmed)) {
        showToast('This course subject label is already in your database.', 'error');
        return;
      }

      try {
        state.settings.subjects.push(trimmed);
        db.saveSettings(state.settings);
        populateLessonFormSubjects();
        const select = document.getElementById('lesson-subject');
        if (select) {
          select.value = trimmed;
        }
        showToast(`Subject "${trimmed}" added and selected.`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Save manual lesson logic
  const btnSaveManualLesson = document.getElementById('btn-save-manual-lesson');
  if (btnSaveManualLesson) {
    btnSaveManualLesson.addEventListener('click', async () => {
      const subject = document.getElementById('lesson-subject').value;
      const topic = document.getElementById('lesson-topic').value;
      const date = document.getElementById('lesson-date').value;
      const id = document.getElementById('lesson-id-holder').value || null;
      const content = document.getElementById('lesson-editable-editor').innerText;

      if (!subject || !topic) {
        showToast('Please specify an active Subject and Topic before saving.', 'error');
        return;
      }

      try {
        await db.saveLesson({ id, subject, topic, date, content });
        showToast(`Lesson Guide for "${topic}" holds updated!`, 'success');
        document.getElementById('lesson-id-holder').value = '';
        document.getElementById('lesson-specification-form').reset();
        document.getElementById('lesson-editable-editor').innerText = 'Start scribbling...';
        btnViewSaved.click();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // AI Automatic Lesson Planner Generation action trigger
  const btnGenerateAiLesson = document.getElementById('btn-generate-ai-lesson');
  if (btnGenerateAiLesson) {
    btnGenerateAiLesson.addEventListener('click', async () => {

      const subject = document.getElementById('lesson-subject').value;
      const topic = document.getElementById('lesson-topic').value;
      const grade = document.getElementById('lesson-grade').value;
      const duration = document.getElementById('lesson-duration').value;

      if (!subject || !topic) {
        showToast('Please specify a Subject and a Topic for Gemini AI synthesis.', 'error');
        return;
      }

      if (!navigator.onLine) {
        queueLessonPlan({ subject, topic, grade, duration });
        return;
      }

      setButtonLoading(btnGenerateAiLesson, true);
      const editor = document.getElementById('lesson-editable-editor');
      editor.innerHTML = `<div class="spinner-container"><div class="spinner"></div><span>Teaching specialist drafting structured plan frameworks...</span></div>`;

      try {
        const resultText = await ai.generateLessonPlan({
          ...getAiConfig(),
          subject,
          topic,
          grade,
          duration
        });

        editor.innerText = resultText;
        showToast('AI successfully completed structured curriculum blueprint.', 'success');
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          queueRetryItem({
            moduleType: 'lesson',
            promptPayload: {
              subject,
              topic,
              grade,
              duration,
              date: document.getElementById('lesson-date').value || ''
            }
          });
        } else if (err.message.includes('fetch') || err.message.includes('Network') || err.message.includes('Failed to fetch')) {
          queueLessonPlan({ subject, topic, grade, duration });
        } else {
          showToast(err.message, 'error');
          editor.innerText = 'Failed generating. Try filling manual items or verify your API configuration.';
        }
      } finally {
        setButtonLoading(btnGenerateAiLesson, false);
      }
    });
  }

  // Copy Clean Lesson Text button
  const btnCopyLesson = document.getElementById('btn-copy-lesson');
  if (btnCopyLesson) {
    btnCopyLesson.addEventListener('click', () => {
      const text = document.getElementById('lesson-editable-editor').innerText;
      copyTextToClipboard(text, 'Lesson Guide textual blueprint copied to clipboard!');
    });
  }

  // 7. Incidents Logger Form submission bindings
  const incidentSubmissionForm = document.getElementById('incident-submission-form');
  if (incidentSubmissionForm) {
    incidentSubmissionForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const studentId = document.getElementById('incident-student').value;
        const date = document.getElementById('incident-date').value;
        const type = document.getElementById('incident-type').value;
        const description = document.getElementById('incident-desc').value;
        const action = document.getElementById('incident-action').value;

        await db.saveIncident({ studentId, date, type, description, action });
        incidentSubmissionForm.reset();
        
        // Dynamic re-render list
        await renderIncidents();
        showToast('Chronicled incident dossier saved.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // 8. Parent Email Message Composer bindings
  const btnGenerateAiMessage = document.getElementById('btn-generate-ai-message');
  if (btnGenerateAiMessage) {
    btnGenerateAiMessage.addEventListener('click', async () => {

      const studentId = document.getElementById('message-student').value;
      const type = document.getElementById('message-category').value;
      const context = document.getElementById('message-context').value;

      if (!studentId) {
        showToast('Please select a student target first.', 'error');
        return;
      }

      const matchStudent = state.students.find(s => s.id === studentId);
      if (!matchStudent) return;

      if (!navigator.onLine) {
        queueParentMessage({ studentId, studentName: matchStudent.name, tone: type, context });
        return;
      }

      setButtonLoading(btnGenerateAiMessage, true);
      const editorOutput = document.getElementById('message-editable-output');
      editorOutput.value = 'AI communication core composing polite and thoughtful draft...';

      try {
        const draftedText = await ai.generateParentMessage({
          ...getAiConfig(),
          studentName: matchStudent.name,
          messageType: type,
          context: context
        });

        editorOutput.value = draftedText;
        showToast('Succeeded drafting an empathetic communication message.', 'success');
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          queueRetryItem({
            moduleType: 'message',
            promptPayload: {
              studentName: matchStudent.name,
              tone: type,
              context
            },
            targetStudentId: studentId
          });
        } else if (err.message.includes('fetch') || err.message.includes('Network') || err.message.includes('Failed to fetch')) {
          queueParentMessage({ studentId, studentName: matchStudent.name, tone: type, context });
        } else {
          showToast(err.message, 'error');
          editorOutput.value = 'Failed generating parent correspondence message template. Validate settings credentials.';
        }
      } finally {
        setButtonLoading(btnGenerateAiMessage, false);
      }
    });
  }

  const btnCopyMessage = document.getElementById('btn-copy-parent-message');
  if (btnCopyMessage) {
    btnCopyMessage.addEventListener('click', () => {
      const txt = document.getElementById('message-editable-output').value;
      copyTextToClipboard(txt, 'Polite message draft safely copied to clip board.');
    });
  }

  // 9. Progression Analytics Report Card binding
  const reportStudentSelect = document.getElementById('reports-student-select');
  if (reportStudentSelect) {
    reportStudentSelect.addEventListener('change', async (e) => {
      await calculateProgressMetrics(e.target.value);
      await renderSavedReportsAndQueue(e.target.value);
    });
  }

  const btnGenerateAiReport = document.getElementById('btn-generate-ai-report');
  if (btnGenerateAiReport) {
    btnGenerateAiReport.addEventListener('click', async () => {

      const studentId = reportStudentSelect.value;
      if (!studentId) {
        showToast('Register students to enable academic progression audits!', 'error');
        return;
      }
      const matchStud = state.students.find(s => s.id === studentId);
      if (!matchStud) return;

      // Extract statistical metrics displayed in left panel
      const avgStr = document.getElementById('report-grade-avg').innerText.replace('%', '');
      const attStr = document.getElementById('report-attendance-rate').innerText.replace('%', '');
      const incStr = document.getElementById('report-incident-count').innerText;

      const gradeAvg = parseFloat(avgStr) || 0;
      const attendanceRate = parseFloat(attStr) || 100;
      const incidentCount = parseInt(incStr) || 0;

      if (!navigator.onLine) {
        queueProgressReport({ studentId, studentName: matchStud.name, gradeAvg, attendanceRate, incidentCount });
        return;
      }

      setButtonLoading(btnGenerateAiReport, true);
      const reportDiv = document.getElementById('report-editable-content');
      reportDiv.innerHTML = `<div class="spinner-container"><div class="spinner"></div><span>Synthesizing multi-column grades summaries and behavioral records indexes...</span></div>`;

      try {
        const analyticsReport = await ai.generateProgressReport({
          ...getAiConfig(),
          name: matchStud.name,
          gradeAvg,
          attendanceRate,
          incidentCount
        });

        reportDiv.innerText = analyticsReport;
        showToast('AI analytical review compiled successfully.', 'success');
      } catch (err) {
        if (err.message === 'QUOTA_EXCEEDED') {
          queueRetryItem({
            moduleType: 'report',
            promptPayload: {
              studentName: matchStud.name,
              gradeAvg,
              attendanceRate,
              incidentCount
            },
            targetStudentId: studentId
          });
        } else if (err.message.includes('fetch') || err.message.includes('Network') || err.message.includes('Failed to fetch')) {
          queueProgressReport({ studentId, studentName: matchStud.name, gradeAvg, attendanceRate, incidentCount });
        } else {
          showToast(err.message, 'error');
          reportDiv.innerText = 'Unable to compile analysis card. Double check configurations.';
        }
      } finally {
        setButtonLoading(btnGenerateAiReport, false);
      }
    });
  }

  // Print Report Card PDF
  const btnPrintReport = document.getElementById('btn-print-report');
  if (btnPrintReport) {
    btnPrintReport.addEventListener('click', () => {
      window.print();
    });
  }

  // 10. General Profile configurations save
  const settingsAiProvider = document.getElementById('settings-ai-provider');
  if (settingsAiProvider) {
    settingsAiProvider.addEventListener('change', () => {
      const val = settingsAiProvider.value;
      const geminiGroup = document.getElementById('settings-gemini-key-group');
      const groqGroup = document.getElementById('settings-groq-key-group');
      if (val === 'groq') {
        geminiGroup?.classList.add('hidden');
        groqGroup?.classList.remove('hidden');
      } else {
        geminiGroup?.classList.remove('hidden');
        groqGroup?.classList.add('hidden');
      }
    });
  }

  const settingsGeneralForm = document.getElementById('settings-general-form');
  if (settingsGeneralForm) {
    settingsGeneralForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const teacherName = document.getElementById('settings-teacher-name').value;
        const className = document.getElementById('settings-class-name').value;
        const schoolName = document.getElementById('settings-school-name').value;
        const apiKey = document.getElementById('settings-api-key').value.trim();
        const aiProviderVal = document.getElementById('settings-ai-provider').value;
        const groqApiKey = document.getElementById('settings-groq-key').value.trim();
        const language = document.getElementById('settings-language').value;

        // Keep current subjects, update other fields
        const record = {
          ...state.settings,
          name: teacherName,
          className: className,
          school: schoolName,
          apiKey: apiKey,
          groqApiKey: groqApiKey,
          aiProvider: aiProviderVal,
          language: language
        };

        db.saveSettings(record);
        state.settings = record;

        // Sync global select value
        const globalLangSel = document.getElementById('global-language-selector');
        if (globalLangSel) {
          globalLangSel.value = language;
        }

        updateSidebarIdentity();
        translatePage();
        await renderActiveModule();
        showToast('Settings configuration updated successfully.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }


  // Settings Add subject trigger
  const btnAddSubject = document.getElementById('btn-add-subject');
  if (btnAddSubject) {
    btnAddSubject.addEventListener('click', (e) => {
      e.preventDefault();
      const input = document.getElementById('settings-subject-input');
      const val = input.value.trim();
      if (!val) return;

      if (state.settings.subjects.includes(val)) {
        showToast('This course subject label is already in your database.', 'error');
        return;
      }

      try {
        state.settings.subjects.push(val);
        db.saveSettings(state.settings);
        input.value = '';
        renderSettingsSubjects();
        showToast(`Course syllabus database indexed: "${val}" active.`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Settings Add section trigger
  const btnAddSection = document.getElementById('btn-add-section');
  if (btnAddSection) {
    btnAddSection.addEventListener('click', async (e) => {
      e.preventDefault();
      await handleAddSectionSubmit(
        document.getElementById('settings-section-input'),
        document.getElementById('settings-section-count')
      );
    });
  }

  // Dashboard Add section trigger
  const btnDashAddSection = document.getElementById('btn-dash-add-section');
  if (btnDashAddSection) {
    btnDashAddSection.addEventListener('click', async (e) => {
      e.preventDefault();
      await handleAddSectionSubmit(
        document.getElementById('dash-section-input'),
        document.getElementById('dash-section-count')
      );
    });
  }

  // Purge Confirmation Modals
  const btnWipeDatabase = document.getElementById('btn-wipe-database');
  const purgeConfirmModal = document.getElementById('purge-confirm-modal');
  if (btnWipeDatabase && purgeConfirmModal) {
    btnWipeDatabase.addEventListener('click', () => {
      document.getElementById('purge-text-key').value = '';
      document.getElementById('btn-confirm-purge').disabled = true;
      purgeConfirmModal.classList.remove('hidden');
    });
  }

  const btnCancelPurge = document.getElementById('btn-cancel-purge');
  if (btnCancelPurge && purgeConfirmModal) {
    btnCancelPurge.addEventListener('click', () => {
      purgeConfirmModal.classList.add('hidden');
    });
  }

  const purgeTextKey = document.getElementById('purge-text-key');
  if (purgeTextKey) {
    purgeTextKey.addEventListener('input', (e) => {
      const confirmButton = document.getElementById('btn-confirm-purge');
      confirmButton.disabled = e.target.value !== 'DELETE ALL';
    });
  }

  const btnConfirmPurge = document.getElementById('btn-confirm-purge');
  if (btnConfirmPurge && purgeConfirmModal) {
    btnConfirmPurge.addEventListener('click', async () => {
      try {
        await db.wipeAllDatabase();
        showToast('All records purged. Restarting application profile.', 'error');
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

// Helper utilities for UI
function setButtonLoading(btnElement, isLoading) {
  if (!btnElement) return;
  const statusSpan = btnElement.querySelector('span');
  
  if (isLoading) {
    btnElement.disabled = true;
    btnElement.dataset.originalHtml = btnElement.innerHTML;
    btnElement.innerHTML = `<div class="spinner"></div> <span>Synthesizing...</span>`;
  } else {
    btnElement.disabled = false;
    if (btnElement.dataset.originalHtml) {
      btnElement.innerHTML = btnElement.dataset.originalHtml;
    }
  }
}

function copyTextToClipboard(text, successMsg) {
  if (!text || text.trim() === '') {
    showToast('There is no content in the text container to copy.', 'error');
    return;
  }
  
  // Use clipboard API fallback for PWA containers
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => showToast(successMsg, 'success'))
      .catch(() => showToast('Browser blocked copy permissions. Try highlights manually.', 'error'));
  } else {
    // legacy textarea copy helper
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast(successMsg, 'success');
  }
}

// Relational scoping helper functions
export function getStudentsBySection(sectionId) {
  return state.students.filter(s => s.sectionId === sectionId);
}

export async function getGradesBySectionAndSubject(sectionId, subject) {
  return await db.getGradesForSubject(subject, sectionId);
}

// Universal Section Selector dropdown injector and state validation
function renderUniversalSectionSelector(moduleName) {
  const container = document.querySelector(`#module-${moduleName} .universal-section-selector-container`);
  const contentWrapper = document.querySelector(`#module-${moduleName} .module-content-wrapper`);
  
  if (!container) return;

  // Clear previous selectors or warnings
  container.innerHTML = '';

  if (state.sections.length === 0) {
    // Hide content layout
    if (contentWrapper) contentWrapper.classList.add('hidden');

    // Show empty warning overlay card
    const warning = document.createElement('div');
    warning.className = 'panel';
    warning.style.textAlign = 'center';
    warning.style.padding = '48px';
    warning.style.margin = '20px 0';
    warning.style.border = '1px dashed var(--warning-color)';
    warning.innerHTML = `
      <i data-lucide="alert-triangle" style="width: 48px; height: 48px; margin: 0 auto 16px auto; color: var(--warning-color);"></i>
      <h2 style="font-size: 1.5rem; margin-bottom: 8px;">No Sections Found</h2>
      <p style="color: var(--text-secondary); max-width: 450px; margin: 0 auto 20px auto;">
        Please create a Section in Settings first.
      </p>
      <button class="btn btn-primary" onclick="document.getElementById('nav-settings').click()">
        Go to Settings
      </button>
    `;
    container.appendChild(warning);

    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Show content layout
  if (contentWrapper) contentWrapper.classList.remove('hidden');

  // Render select dropdown
  const selectorDiv = document.createElement('div');
  selectorDiv.style.display = 'flex';
  selectorDiv.style.alignItems = 'center';
  selectorDiv.style.gap = '12px';
  selectorDiv.style.padding = '12px 18px';
  selectorDiv.style.background = 'var(--surface-bg)';
  selectorDiv.style.border = '1px solid var(--border-color)';
  selectorDiv.style.borderRadius = 'var(--border-radius-md)';
  selectorDiv.style.marginBottom = '24px';
  selectorDiv.style.flexWrap = 'wrap';

  const selectOptions = state.sections.map(sec => 
    `<option value="${sec.id}" ${sec.id === state.activeSectionId ? 'selected' : ''}>${sec.name}</option>`
  ).join('');

  selectorDiv.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px;">
      <i data-lucide="layers" style="color: var(--accent-color); width: 18px; height: 18px;"></i>
      <span style="font-weight: 600; font-size: 0.95rem;">Select Section:</span>
    </div>
    <select class="section-select-dropdown" style="max-width: 250px; padding: 6px 12px; background: rgba(15, 27, 45, 0.6); border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); color: var(--text-primary); cursor: pointer; height: auto; width: auto;">
      ${selectOptions}
    </select>
  `;

  container.appendChild(selectorDiv);

  // Bind change event listener
  const dropdown = selectorDiv.querySelector('.section-select-dropdown');
  dropdown.addEventListener('change', async (e) => {
    state.activeSectionId = e.target.value;
    localStorage.setItem('activeSectionId', state.activeSectionId);
    
    // Sync all dropdown selections on other visible selector elements
    document.querySelectorAll('.section-select-dropdown').forEach(sel => {
      sel.value = state.activeSectionId;
    });

    // Re-render the active module below
    await renderActiveModule();
  });

  if (window.lucide) window.lucide.createIcons();
}

// ----------------------------------------------------
// UI RENDERING ROUTINES FOR EACH MODULE
// ----------------------------------------------------

/// Render Core dashboard figures
async function renderDashboard() {
  const dashGreeting = document.getElementById('dash-greeting');
  if (dashGreeting && state.settings.name) {
    const lang = state.settings.language || 'en';
    const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
    const prefix = dict["Good morning, "] || "Good morning, ";
    dashGreeting.innerText = `${prefix}${state.settings.name}!`;
  }

  const dateSpan = document.getElementById('dash-date');
  if (dateSpan) {
    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    dateSpan.innerText = new Date().toLocaleDateString('en-US', opts);
  }

  const sectionStudents = getStudentsBySection(state.activeSectionId);

  // Set card quantities
  const totalStudBadge = document.getElementById('dash-total-students');
  if (totalStudBadge) totalStudBadge.innerText = sectionStudents.length;

  const schoolTagValue = document.getElementById('dash-school-badge');
  if (schoolTagValue) schoolTagValue.innerText = state.settings.school || 'Academic Workspace Local';

  // Count absent today
  const attendanceTodayMap = await db.getAttendance(state.activeDate, state.activeSectionId);
  let absentCount = 0;
  sectionStudents.forEach(s => {
    if (attendanceTodayMap[s.id] === 'absent') absentCount++;
  });
  const absentBadgeValue = document.getElementById('dash-absent-today');
  if (absentBadgeValue) absentBadgeValue.innerText = absentCount;

  // Gradebooks columns quantity for this section
  let listedAssignmentsCount = 0;
  for (const sub of state.settings.subjects) {
    const gradeData = await db.getGradesForSubject(sub, state.activeSectionId);
    listedAssignmentsCount += gradeData.assignments.length;
  }
  const gradesCountBadge = document.getElementById('dash-pending-grades');
  if (gradesCountBadge) gradesCountBadge.innerText = listedAssignmentsCount;

  // Saved lesson files count
  const itemsCountBadge = document.getElementById('dash-upcoming-lessons');
  if (itemsCountBadge) {
    const lessonsList = await db.getLessons();
    itemsCountBadge.innerText = lessonsList.length;
  }

  // Today class profile analytical textual description
  const classSummaryText = document.getElementById('dash-class-summary-text');
  if (classSummaryText) {
    if (sectionStudents.length === 0) {
      classSummaryText.innerHTML = `<div>No registered students found in this section. Head to the <strong style="color:var(--accent-color); cursor:pointer;" onclick="document.getElementById('nav-students').click()">Students tracker module</strong> to set up your roster!</div>`;
    } else {
      let iepCount = sectionStudents.filter(s => s.isIEP).length;
      let presentCount = sectionStudents.length - absentCount;
      let calculatedRate = sectionStudents.length > 0 ? Math.round((presentCount / sectionStudents.length) * 100) : 100;
      
      classSummaryText.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div>📊 Class attendance is currently sitting at <strong>${calculatedRate}%</strong> for today (marked score: ${presentCount} present, ${absentCount} absent).</div>
          <div>⚠️ <strong>${iepCount} student profile(s)</strong> require Individualized Education accommodation pathways (IEP tags active).</div>
          <div>📚 Total course curricula indices mapped: <strong>${state.settings.subjects.length} active syllabus categories</strong>.</div>
        </div>
      `;
    }
  }
  renderDashboardSections();
}

// Render dynamic student profiles cards
function renderStudents() {
  const container = document.getElementById('student-roster-grid');
  if (!container) return;

  container.innerHTML = '';
  const sectionStudents = getStudentsBySection(state.activeSectionId);

  if (sectionStudents.length === 0) {
    container.innerHTML = `
      <div class="panel" style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 48px;">
        <i data-lucide="users" style="width: 48px; height: 48px; margin: 0 auto 16px auto; opacity: 0.5;"></i>
        <p>No student profiles mapped in this section yet.</p>
        <p style="font-size: 0.85rem; margin-top: 8px;">Tap "Add New Student" above to build your class records.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  sectionStudents.forEach(student => {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = `student-${student.id}`;
    
    // Check for IEP and generate Badge markup
    const iepMarkup = student.isIEP 
      ? `<div class="iep-badge"><i data-lucide="shield-alert" style="width: 12px; height: 12px; margin-right:4px;"></i> IEP Support Tag</div>` 
      : '';

    card.innerHTML = `
      <div style="font-size: 0.8rem; color:var(--text-secondary); font-family:var(--font-mono); font-weight:600;">ID: ${student.roll}</div>
      <h3 style="font-size: 1.25rem;" class="student-info-name">${student.name}</h3>
      ${iepMarkup}
      
      <div style="display:flex; flex-direction:column; gap:8px; margin-top:14px; font-size: 0.85rem; color:var(--text-secondary);">
        <div style="display:flex; align-items:center; gap:6px;">
          <i data-lucide="phone-call" style="width: 14px; height: 14px; flex-shrink:0;"></i>
          <span>${student.parentContact}</span>
        </div>
        <div style="display:flex; align-items:flex-start; gap:6px;">
          <i data-lucide="file-text" style="width: 14px; height: 14px; margin-top: 3px; flex-shrink:0;"></i>
          <span style="font-style: italic;">${student.notes || 'No academic notes appended.'}</span>
        </div>
      </div>

      <div class="student-card-actions">
        <button class="btn btn-secondary btn-small edit-student-btn" data-id="${student.id}" style="padding: 4px 10px;">Edit</button>
        <button class="btn btn-danger btn-small delete-student-btn" data-id="${student.id}" style="padding: 4px 10px;">Remove</button>
      </div>
    `;
    container.appendChild(card);
  });

  // Attach actions listeners inside cards
  document.querySelectorAll('.edit-student-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const matchStud = state.students.find(s => s.id === btn.dataset.id);
      if (matchStud) {
        document.getElementById('student-idx').value = matchStud.id;
        document.getElementById('student-name').value = matchStud.name;
        document.getElementById('student-roll').value = matchStud.roll;
        document.getElementById('student-parent').value = matchStud.parentContact;
        
        // Populate section list and select current section of student
        const selectFormSection = document.getElementById('student-section-id');
        if (selectFormSection) {
          selectFormSection.innerHTML = state.sections.map(sec => 
            `<option value="${sec.id}">${sec.name}</option>`
          ).join('');
          selectFormSection.value = matchStud.sectionId || state.activeSectionId;
        }

        document.getElementById('student-iep').checked = matchStud.isIEP;
        document.getElementById('student-notes').value = matchStud.notes || '';
        
        document.getElementById('student-form-title').innerText = `Edit Profile: ${matchStud.name}`;
        document.getElementById('student-form-panel').classList.remove('hidden');
        document.getElementById('student-form-panel').scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  document.querySelectorAll('.delete-student-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const parentName = state.students.find(s => s.id === btn.dataset.id)?.name || 'student';
      if (confirm(`Confirm removing student dossier for "${parentName}"? All grades metrics & incident logs will be dereferenced.`)) {
        await db.deleteStudent(btn.dataset.id);
        state.students = await db.getStudents();
        renderStudents();
        showToast(`Profile data for "${parentName}" deleted.`, 'error');
      }
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

// Render dynamic teacher profiles cards
function renderTeachers() {
  const container = document.getElementById('teacher-roster-grid');
  if (!container) return;

  container.innerHTML = '';

  if (state.teachers.length === 0) {
    container.innerHTML = `
      <div class="panel" style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 48px;">
        <i data-lucide="graduation-cap" style="width: 48px; height: 48px; margin: 0 auto 16px auto; opacity: 0.5;"></i>
        <p>No teacher profiles registered yet.</p>
        <p style="font-size: 0.85rem; margin-top: 8px;">Tap "Add New Teacher" above to register new profiles.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  state.teachers.forEach(teacher => {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = `teacher-${teacher.id}`;

    // Render with face thumbnail if it exists
    const photoHtml = teacher.photo 
      ? `<img src="${teacher.photo}" style="width: 50px; height: 50px; border-radius: 50%; object-fit: cover; border: 2px solid var(--accent-color); flex-shrink: 0;" />`
      : `<div style="width: 50px; height: 50px; border-radius: 50%; background: var(--surface-hover); display: flex; align-items: center; justify-content: center; border: 2px solid var(--border-color); flex-shrink: 0;">
          <i data-lucide="user" style="width: 24px; height: 24px; color: var(--text-secondary);"></i>
        </div>`;

    card.innerHTML = `
      <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 12px;">
        ${photoHtml}
        <div>
          <div style="font-size: 0.8rem; color:var(--text-secondary); font-family:var(--font-mono); font-weight:600;">ID: ${teacher.code}</div>
          <h3 style="font-size: 1.25rem; margin: 0;" class="teacher-info-name">${teacher.name}</h3>
        </div>
      </div>
      <div class="iep-badge" style="background: rgba(30, 215, 96, 0.1); color: var(--success-color); border: 1px solid rgba(30, 215, 96, 0.2);">
        <i data-lucide="book-open" style="width: 12px; height: 12px; margin-right:4px;"></i> Dept: ${teacher.dept}
      </div>
      
      <div style="display:flex; flex-direction:column; gap:8px; margin-top:14px; font-size: 0.85rem; color:var(--text-secondary);">
        <div style="display:flex; align-items:center; gap:6px;">
          <i data-lucide="mail" style="width: 14px; height: 14px; flex-shrink:0;"></i>
          <span>${teacher.contact}</span>
        </div>
        <div style="display:flex; align-items:flex-start; gap:6px;">
          <i data-lucide="file-text" style="width: 14px; height: 14px; margin-top: 3px; flex-shrink:0;"></i>
          <span style="font-style: italic;">${teacher.notes || 'No notes appended.'}</span>
        </div>
      </div>

      <div class="student-card-actions">
        <button class="btn btn-secondary btn-small edit-teacher-btn" data-id="${teacher.id}" style="padding: 4px 10px;">Edit</button>
        <button class="btn btn-danger btn-small delete-teacher-btn" data-id="${teacher.id}" style="padding: 4px 10px;">Remove</button>
      </div>
    `;
    container.appendChild(card);
  });

  // Attach actions listeners inside cards
  document.querySelectorAll('.edit-teacher-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const matchTch = state.teachers.find(t => t.id === btn.dataset.id);
      if (matchTch) {
        document.getElementById('teacher-idx').value = matchTch.id;
        document.getElementById('teacher-name').value = matchTch.name;
        document.getElementById('teacher-code').value = matchTch.code;
        document.getElementById('teacher-contact').value = matchTch.contact;
        document.getElementById('teacher-dept').value = matchTch.dept;
        document.getElementById('teacher-notes').value = matchTch.notes || '';
        
        // Load photo details
        const photoData = matchTch.photo || '';
        document.getElementById('teacher-photo-data').value = photoData;
        const photoImg = document.getElementById('teacher-photo-img');
        const placeholder = document.getElementById('teacher-photo-placeholder');
        const deleteBtn = document.getElementById('btn-delete-teacher-face');
        
        if (photoData) {
          if (photoImg) {
            photoImg.src = photoData;
            photoImg.classList.remove('hidden');
          }
          if (placeholder) placeholder.classList.add('hidden');
          if (deleteBtn) deleteBtn.classList.remove('hidden');
        } else {
          if (photoImg) {
            photoImg.src = '';
            photoImg.classList.add('hidden');
          }
          if (placeholder) placeholder.classList.remove('hidden');
          if (deleteBtn) deleteBtn.classList.add('hidden');
        }

        document.getElementById('teacher-form-title').innerText = `Edit Profile: ${matchTch.name}`;
        document.getElementById('teacher-form-panel').classList.remove('hidden');
        document.getElementById('teacher-form-panel').scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  document.querySelectorAll('.delete-teacher-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = state.teachers.find(t => t.id === btn.dataset.id)?.name || 'teacher';
      if (confirm(`Confirm removing teacher profile for "${name}"? Attendance logs for this teacher will be dereferenced.`)) {
        await db.deleteTeacher(btn.dataset.id);
        state.teachers = await db.getTeachers();
        renderTeachers();
        showToast(`Profile data for "${name}" deleted.`, 'error');
      }
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

// Render Attendance register list
async function renderAttendance() {
  const container = document.getElementById('attendance-roster-list');
  const dateHeading = document.getElementById('attendance-roster-heading');
  if (!container) return;

  container.innerHTML = '';
  const dateObj = new Date(state.activeDate + 'T00:00:00');
  const formattedDayText = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  if (dateHeading) {
    dateHeading.innerText = `Roster Verification File for ${formattedDayText}`;
  }

  if (state.attendanceType === 'teacher') {
    if (state.teachers.length === 0) {
      container.innerHTML = `
        <div class="panel" style="text-align: center; color: var(--text-secondary); padding: 48px;">
          <i data-lucide="graduation-cap" style="width: 48px; height: 48px; margin: 0 auto 16px auto; opacity: 0.5;"></i>
          <p>Your teachers registry holds 0 teachers. Active profiles are required to check attendance.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    const marksMap = await db.getTeacherAttendance(state.activeDate);
    let presentC = 0, absentC = 0, lateC = 0;

    state.teachers.forEach(teacher => {
      const status = marksMap[teacher.id] || '';
      if (status === 'present') presentC++;
      else if (status === 'absent') absentC++;
      else if (status === 'late') lateC++;

      const item = document.createElement('div');
      item.className = 'attendance-item';
      item.innerHTML = `
        <div class="student-info-main">
          <div class="student-info-name">${teacher.name}</div>
          <div class="student-info-meta">Code ID: ${teacher.code} • Department: ${teacher.dept}</div>
        </div>
        <div class="attendance-controls">
          <button class="btn-toggle toggle-pres ${status === 'present' ? 'active-present' : ''}" data-id="${teacher.id}">Present</button>
          <button class="btn-toggle toggle-abs  ${status === 'absent' ? 'active-absent' : ''}" data-id="${teacher.id}">Absent</button>
          <button class="btn-toggle toggle-late ${status === 'late' ? 'active-late' : ''}" data-id="${teacher.id}">Late</button>
        </div>
      `;
      container.appendChild(item);
    });

    // Render stats badges
    document.getElementById('att-stats-present').innerText = presentC;
    document.getElementById('att-stats-absent').innerText = absentC;
    document.getElementById('att-stats-late').innerText = lateC;

    // Add click toggler listeners
    container.querySelectorAll('.toggle-pres').forEach(btn => {
      btn.addEventListener('click', async () => await handleToggleAttendance(btn.dataset.id, 'present'));
    });
    container.querySelectorAll('.toggle-abs').forEach(btn => {
      btn.addEventListener('click', async () => await handleToggleAttendance(btn.dataset.id, 'absent'));
    });
    container.querySelectorAll('.toggle-late').forEach(btn => {
      btn.addEventListener('click', async () => await handleToggleAttendance(btn.dataset.id, 'late'));
    });

    if (window.lucide) window.lucide.createIcons();
  } else {
    const sectionStudents = getStudentsBySection(state.activeSectionId);

    if (sectionStudents.length === 0) {
      container.innerHTML = `
        <div class="panel" style="text-align: center; color: var(--text-secondary); padding: 48px;">
          <i data-lucide="user-x" style="width: 48px; height: 48px; margin: 0 auto 16px auto; opacity: 0.5;"></i>
          <p>Your class registry holds 0 students in this section. Active profiles are required to check attendance.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // Obtain todays marked values map for this section
    const marksMap = await db.getAttendance(state.activeDate, state.activeSectionId);

    let presentC = 0, absentC = 0, lateC = 0;

    sectionStudents.forEach(student => {
      // defaults to empty string if un-marked
      const status = marksMap[student.id] || '';
      
      // increment statistics summary counter
      if (status === 'present') presentC++;
      else if (status === 'absent') absentC++;
      else if (status === 'late') lateC++;

      const item = document.createElement('div');
      item.className = 'attendance-item';
      item.innerHTML = `
        <div class="student-info-main">
          <div class="student-info-name">${student.name}</div>
          <div class="student-info-meta">Roll Identification: ${student.roll} ${student.isIEP ? '• <span style="color:var(--accent-color);">IEP active</span>' : ''}</div>
        </div>
        <div class="attendance-controls">
          <button class="btn-toggle toggle-pres ${status === 'present' ? 'active-present' : ''}" data-id="${student.id}">Present</button>
          <button class="btn-toggle toggle-abs  ${status === 'absent' ? 'active-absent' : ''}" data-id="${student.id}">Absent</button>
          <button class="btn-toggle toggle-late ${status === 'late' ? 'active-late' : ''}" data-id="${student.id}">Late</button>
        </div>
      `;
      container.appendChild(item);
    });

    // Render stats badges
    document.getElementById('att-stats-present').innerText = presentC;
    document.getElementById('att-stats-absent').innerText = absentC;
    document.getElementById('att-stats-late').innerText = lateC;

    // Add click toggler listeners
    container.querySelectorAll('.toggle-pres').forEach(btn => {
      btn.addEventListener('click', async () => await handleToggleAttendance(btn.dataset.id, 'present'));
    });
    container.querySelectorAll('.toggle-abs').forEach(btn => {
      btn.addEventListener('click', async () => await handleToggleAttendance(btn.dataset.id, 'absent'));
    });
    container.querySelectorAll('.toggle-late').forEach(btn => {
      btn.addEventListener('click', async () => await handleToggleAttendance(btn.dataset.id, 'late'));
    });

    if (window.lucide) window.lucide.createIcons();
  }
}

async function handleToggleAttendance(studentId, targetStatus) {
  if (state.attendanceType === 'teacher') {
    const currentMarks = await db.getTeacherAttendance(state.activeDate);
    
    if (currentMarks[studentId] === targetStatus) {
      delete currentMarks[studentId];
    } else {
      currentMarks[studentId] = targetStatus;
    }

    try {
      await db.saveTeacherAttendance(state.activeDate, currentMarks);
      await renderAttendance();
    } catch (err) {
      showToast(err.message, 'error');
    }
  } else {
    const currentMarks = await db.getAttendance(state.activeDate, state.activeSectionId);
    
    if (currentMarks[studentId] === targetStatus) {
      delete currentMarks[studentId];
    } else {
      currentMarks[studentId] = targetStatus;
    }

    try {
      await db.saveAttendance(state.activeDate, state.activeSectionId, currentMarks);
      await renderAttendance();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
}

// Render Attendance History records view
async function renderAttendanceHistory() {
  const container = document.getElementById('attendance-history-list');
  if (!container) return;

  container.innerHTML = '';

  if (state.attendanceType === 'teacher') {
    const history = await db.getAllTeacherAttendanceHistory();

    if (history.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-secondary); padding: 32px 12px;">
          <i data-lucide="calendar" style="width:36px; height:36px; margin: 0 auto 10px auto; opacity:0.5;"></i>
          <p style="font-size:0.95rem;">No historical teacher attendance records saved yet.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    history.forEach(record => {
      const dateObj = new Date(record.date + 'T00:00:00');
      const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      
      let present = 0, absent = 0, late = 0;
      Object.values(record.marks).forEach(status => {
        if (status === 'present') present++;
        else if (status === 'absent') absent++;
        else if (status === 'late') late++;
      });

      const card = document.createElement('div');
      card.className = 'incident-card';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';
      card.style.flexWrap = 'wrap';
      card.style.gap = '12px';
      card.style.padding = '16px';
      card.style.borderLeft = '4px solid var(--accent-color)';

      card.innerHTML = `
        <div>
          <strong style="color:var(--text-primary); font-size:1.05rem;">${formattedDate}</strong>
          <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:4px; display:flex; gap:12px;">
            <span>Present: <span style="color:var(--success-color); font-weight:600;">${present}</span></span>
            <span>Absent: <span style="color:var(--error-color); font-weight:600;">${absent}</span></span>
            <span>Late: <span style="color:var(--warning-color); font-weight:600;">${late}</span></span>
          </div>
        </div>
        <div class="student-card-actions" style="margin-top:0; padding-top:0;">
          <button class="btn btn-secondary btn-small view-history-btn" data-date="${record.date}">View Register</button>
          <button class="btn btn-danger btn-small delete-history-btn" data-date="${record.date}">Delete</button>
        </div>
      `;
      container.appendChild(card);
    });

    // Event handlers
    container.querySelectorAll('.view-history-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeDate = btn.dataset.date;
        const datePicker = document.getElementById('attendance-date-picker');
        if (datePicker) datePicker.value = btn.dataset.date;
        const btnViewDaily = document.getElementById('btn-view-daily-attendance');
        if (btnViewDaily) btnViewDaily.click();
      });
    });

    container.querySelectorAll('.delete-history-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm(`Are you sure you want to permanently delete the teacher attendance record for ${btn.dataset.date}?`)) {
          try {
            await db.deleteTeacherAttendanceRecord(btn.dataset.date);
            await renderAttendanceHistory();
            showToast(`Teacher attendance record for ${btn.dataset.date} deleted.`, 'error');
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      });
    });
  } else {
    const history = await db.getAllAttendanceHistory();
    const sectionHistory = history.filter(h => h.sectionId === state.activeSectionId);

    if (sectionHistory.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-secondary); padding: 32px 12px;">
          <i data-lucide="calendar" style="width:36px; height:36px; margin: 0 auto 10px auto; opacity:0.5;"></i>
          <p style="font-size:0.95rem;">No historical attendance records saved for this section yet.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    sectionHistory.forEach(record => {
      const dateObj = new Date(record.date + 'T00:00:00');
      const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      
      // Count stats
      let present = 0, absent = 0, late = 0;
      Object.values(record.marks).forEach(status => {
        if (status === 'present') present++;
        else if (status === 'absent') absent++;
        else if (status === 'late') late++;
      });

      const card = document.createElement('div');
      card.className = 'incident-card';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';
      card.style.flexWrap = 'wrap';
      card.style.gap = '12px';
      card.style.padding = '16px';
      card.style.borderLeft = '4px solid var(--accent-color)';

      card.innerHTML = `
        <div>
          <strong style="color:var(--text-primary); font-size:1.05rem;">${formattedDate}</strong>
          <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:4px; display:flex; gap:12px;">
            <span>Present: <span style="color:var(--success-color); font-weight:600;">${present}</span></span>
            <span>Absent: <span style="color:var(--error-color); font-weight:600;">${absent}</span></span>
            <span>Late: <span style="color:var(--warning-color); font-weight:600;">${late}</span></span>
          </div>
        </div>
        <div class="student-card-actions" style="margin-top:0; padding-top:0;">
          <button class="btn btn-secondary btn-small view-history-btn" data-date="${record.date}">View Register</button>
          <button class="btn btn-danger btn-small delete-history-btn" data-date="${record.date}">Delete</button>
        </div>
      `;
      container.appendChild(card);
    });

    // Event handlers
    container.querySelectorAll('.view-history-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeDate = btn.dataset.date;
        const datePicker = document.getElementById('attendance-date-picker');
        if (datePicker) datePicker.value = btn.dataset.date;
        const btnViewDaily = document.getElementById('btn-view-daily-attendance');
        if (btnViewDaily) btnViewDaily.click();
      });
    });

    container.querySelectorAll('.delete-history-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm(`Are you sure you want to permanently delete the attendance record for ${btn.dataset.date}?`)) {
          try {
            await db.deleteAttendanceRecord(btn.dataset.date, state.activeSectionId);
            await renderAttendanceHistory();
            showToast(`Attendance record for ${btn.dataset.date} deleted.`, 'error');
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      });
    });
  }

  if (window.lucide) window.lucide.createIcons();
}

// Populate and render Gradebook Spreadsheet Table
async function renderGrades() {
  const subjectSelect = document.getElementById('grades-subject-select');
  const tableHeader = document.querySelector('#grades-data-table thead');
  const tableBody = document.getElementById('grades-data-body');
  const emptyState = document.getElementById('grades-empty-state');
  const tableWrapper = document.querySelector('.table-responsive');

  if (!tableBody) return;

  // 1. Double check and fill subject lists dropdown setting option
  subjectSelect.innerHTML = '';
  if (state.settings.subjects.length === 0) {
    tableWrapper.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  tableWrapper.classList.remove('hidden');

  state.settings.subjects.forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.innerText = sub;
    opt.selected = sub === state.selectedSubject;
    subjectSelect.appendChild(opt);
  });

  if (!state.selectedSubject) {
    state.selectedSubject = state.settings.subjects[0];
  }

  // 2. Fetch grades data dictionary for active subject and active section
  const gradebook = await db.getGradesForSubject(state.selectedSubject, state.activeSectionId);
  const sectionStudents = getStudentsBySection(state.activeSectionId);

  if (sectionStudents.length === 0) {
    tableWrapper.classList.add('hidden');
    emptyState.classList.remove('hidden');
    emptyState.innerHTML = `
      <i data-lucide="alert-circle" style="width:48px; height:48px; margin: 0 auto 12px auto; opacity:0.5; color:var(--accent-color);"></i>
      <p>Please register student profiles in this section before attempting to enter scores.</p>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  // Render Table Headers
  let headerRowMarkup = `<tr><th style="min-width: 160px;">Student Name</th>`;
  gradebook.assignments.forEach((assignment, index) => {
    headerRowMarkup += `
      <th style="text-align: center; min-width: 100px; position:relative;">
        <span style="display:block; padding-right:12px;">${assignment.name}</span>
        <button class="remove-assignment-header-btn" data-idx="${index}" 
                style="position:absolute; right:4px; top:12px; background:none; border:none; color:var(--error-color); cursor:pointer; font-weight:bold; font-size: 0.8rem;" 
                title="Remove Assigment Column">×</button>
      </th>`;
  });
  headerRowMarkup += `<th style="text-align: center; min-width: 90px;">Average Score</th></tr>`;
  tableHeader.innerHTML = headerRowMarkup;

  // Add click remove column logic
  tableHeader.querySelectorAll('.remove-assignment-header-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const colIdx = parseInt(btn.dataset.idx);
      const targetAssign = gradebook.assignments[colIdx];
      if (confirm(`Are you sure you want to delete assignment column "${targetAssign.name}" and all recorded grades?`)) {
        gradebook.assignments.splice(colIdx, 1);
        
        // Remove individual scores from this column ID safely
        Object.keys(gradebook.scores).forEach(studId => {
          if (gradebook.scores[studId] && gradebook.scores[studId][targetAssign.id] !== undefined) {
            delete gradebook.scores[studId][targetAssign.id];
          }
        });

        await db.saveGradesForSubject(state.selectedSubject, gradebook);
        await renderGrades();
        showToast(`Column "${targetAssign.name}" removed.`, 'error');
      }
    });
  });

  // Render Table Rows per student dynamically
  tableBody.innerHTML = '';
  sectionStudents.forEach(student => {
    const studentScoresMap = gradebook.scores[student.id] || {};
    
    let rowMarkup = `<tr><td style="font-weight:600;"><span class="text-primary">${student.name}</span></td>`;
    
    let sum = 0;
    let counts = 0;

    gradebook.assignments.forEach(assignment => {
      const score = studentScoresMap[assignment.id] !== undefined ? studentScoresMap[assignment.id] : '';
      
      if (score !== '') {
        sum += parseFloat(score);
        counts++;
      }

      rowMarkup += `
        <td style="text-align: center;">
          <input type="number" class="cell-input inline-score-input" min="0" max="100" 
                 data-student="${student.id}" data-assignment="${assignment.id}" value="${score}" placeholder="-" />
        </td>
      `;
    });

    const averageVal = counts > 0 ? Math.round((sum / counts) * 10) / 10 : null;
    let badgeClass = 'avg-red';
    if (averageVal >= 75) badgeClass = 'avg-green';
    else if (averageVal >= 50) badgeClass = 'avg-amber';

    const avgDisplay = averageVal !== null ? `${averageVal}%` : 'N/A';
    
    rowMarkup += `
      <td class="avg-cell" style="text-align: center;">
        <span class="avg-badge ${badgeClass}">${avgDisplay}</span>
      </td>
    </tr>`;

    tableBody.innerHTML += rowMarkup;
  });

  // Attach live spreadsheet input change listener
  document.querySelectorAll('.inline-score-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const studId = input.dataset.student;
      const assignId = input.dataset.assignment;
      const rawVal = e.target.value.trim();

      if (!gradebook.scores[studId]) {
        gradebook.scores[studId] = {};
      }

      if (rawVal === '') {
        delete gradebook.scores[studId][assignId];
      } else {
        const valNum = parseFloat(rawVal);
        if (isNaN(valNum) || valNum < 0 || valNum > 100) {
          showToast('Please type a valid grading grade score between 0 and 100.', 'error');
          e.target.value = gradebook.scores[studId][assignId] !== undefined ? gradebook.scores[studId][assignId] : '';
          return;
        }
        gradebook.scores[studId][assignId] = valNum;
      }

      try {
        await db.saveGradesForSubject(state.selectedSubject, gradebook);
        await renderGrades();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

// Compile grid cells to CSV format and execute local file downloading
async function exportTableToCSV(subjectName) {
  const grades = await db.getGradesForSubject(subjectName, state.activeSectionId);
  const sectionStudents = getStudentsBySection(state.activeSectionId);

  // Columns title line headers
  const headersList = ['Student Roll Identifier', 'Full Student Name'];
  grades.assignments.forEach(a => { headersList.push(`"${a.name}"`); });
  headersList.push('Classroom Grade Average %');

  const rowsList = [headersList.join(',')];

  sectionStudents.forEach(student => {
    const studentRowList = [student.roll, `"${student.name}"`];
    let sum = 0, count = 0;

    grades.assignments.forEach(a => {
      const score = grades.scores[student.id]?.[a.id];
      if (score !== undefined && score !== '') {
        studentRowList.push(score);
        sum += parseFloat(score);
        count++;
      } else {
        studentRowList.push('');
      }
    });

    const studentAvg = count > 0 ? Math.round((sum / count) * 100) / 100 : 'N/A';
    studentRowList.push(studentAvg);
    rowsList.push(studentRowList.join(','));
  });

  const fullContentString = rowsList.join('\n');
  const blob = new Blob([fullContentString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${subjectName.replace(/\s+/g, '_')}_Gradebook.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast(`CSV data export downloaded successfully for "${subjectName}".`, 'success');
}

// Render dynamic folders grid containing saved lesson plans
async function renderLessonsSchedules() {
  const container = document.getElementById('saved-lessons-grid');
  if (!container) return;

  container.innerHTML = '';
  const lessons = await db.getLessons();
  const queue = getAIQueue().filter(item => item.type === 'lesson');
  const retryQueue = getAIRetryQueue().filter(item => item.moduleType === 'lesson');
  const allLessons = [
    ...lessons,
    ...queue.map(item => ({
      id: item.dbId,
      subject: item.subject,
      topic: item.topic,
      date: item.date,
      content: 'Pending AI Generation: This plan will be automatically synthesized by Gemini when online connectivity returns.',
      isPending: true,
      isRetry: false,
      queueId: item.id
    })),
    ...retryQueue.map(item => ({
      id: item.dbId,
      subject: item.promptPayload.subject,
      topic: item.promptPayload.topic,
      date: item.promptPayload.date,
      content: 'Pending AI Generation: The AI is busy. This plan will be automatically generated in a minute.',
      isPending: true,
      isRetry: true,
      queueId: item.id
    }))
  ];

  if (allLessons.length === 0) {
    container.innerHTML = `
      <div class="panel" style="grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 32px;">
        <i data-lucide="folder-open" style="width: 42px; height: 42px; margin: 0 auto 12px auto; opacity: 0.5;"></i>
        <p>No lesson designs saved locally yet.</p>
        <p style="font-size:0.85rem; margin-top:6px;">Tap "Create Lesson Plan" above to create drafts manually or leverage AI.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  allLessons.forEach(plan => {
    const formattedDate = plan.date 
      ? new Date(plan.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Asynchronous Scheduled';

    const card = document.createElement('div');
    card.className = 'card';
    card.style.borderLeft = plan.isPending ? '4px solid var(--warning-color)' : '4px solid var(--accent-color)';

    const badgeMarkup = plan.isPending
      ? (plan.isRetry
         ? `<span class="stat-badge late" style="margin-left: 8px; display:inline-flex; align-items:center; gap:4px; font-size:0.7rem; padding: 2px 6px; border-radius: 4px; vertical-align: middle; background-color: rgba(245, 166, 35, 0.15); border: 1px dashed var(--warning-color); color: var(--warning-color);"><i data-lucide="refresh-cw" style="width:11px; height:11px;"></i> AI Busy (Retrying)</span>`
         : `<span class="stat-badge late" style="margin-left: 8px; display:inline-flex; align-items:center; gap:4px; font-size:0.7rem; padding: 2px 6px; border-radius: 4px; vertical-align: middle;"><i data-lucide="clock" style="width:11px; height:11px;"></i> Pending Sync</span>`
        )
      : '';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div style="font-size:0.75rem; font-family:var(--font-mono); color:${plan.isPending ? 'var(--warning-color)' : 'var(--accent-color)'}; font-weight:600; text-transform:uppercase;">${plan.subject}</div>
        ${badgeMarkup}
      </div>
      <h3 style="font-size:1.15rem; margin-top:2px;">${plan.topic}</h3>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:8px;">
        <i data-lucide="clock" style="width:13px; height:13px; display:inline; vertical-align:middle; margin-right:4px;"></i> Date: ${formattedDate}
      </div>
      <p style="font-size:0.85rem; color:var(--text-secondary); margin-top:10px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; font-style: ${plan.isPending ? 'italic' : 'normal'};">
        ${plan.content || 'Draft has empty contents.'}
      </p>
      
      <div class="student-card-actions" style="margin-top:14px; padding-top:10px;">
        <button class="btn btn-secondary btn-small load-plan-btn" data-id="${plan.id}" ${plan.isPending ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} style="padding:3px 8px;">Edit Plan</button>
        ${plan.isRetry ? `<button class="btn btn-primary btn-small force-retry-plan-btn" data-queue-id="${plan.queueId}" style="padding:3px 8px;">Retry</button>` : ''}
        <button class="btn btn-danger btn-small delete-plan-btn" data-id="${plan.id}" data-pending="${plan.isPending || false}" data-retry="${plan.isRetry || false}" data-queue-id="${plan.queueId || ''}" style="padding:3px 8px;">Purge</button>
      </div>
    `;
    container.appendChild(card);
  });

  // Folder click edit bindings
  container.querySelectorAll('.load-plan-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lessonsList = await db.getLessons();
      const match = lessonsList.find(l => l.id === btn.dataset.id);
      if (match) {
        // Toggle view tab
        document.getElementById('btn-view-lesson-editor').click();
        
        // Pop values
        document.getElementById('lesson-id-holder').value = match.id;
        document.getElementById('lesson-subject').value = match.subject;
        document.getElementById('lesson-topic').value = match.topic;
        document.getElementById('lesson-date').value = match.date || '';
        document.getElementById('lesson-editable-editor').innerText = match.content;
      }
    });
  });

  container.querySelectorAll('.delete-plan-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isPending = btn.dataset.pending === 'true';
      const isRetry = btn.dataset.retry === 'true';
      if (isPending) {
        const queueId = btn.dataset.queueId;
        if (confirm('Remove this pending lesson plan from the queue?')) {
          if (isRetry) {
            const queue = getAIRetryQueue().filter(item => item.id !== queueId);
            saveAIRetryQueue(queue);
          } else {
            const queue = getAIQueue().filter(item => item.id !== queueId);
            saveAIQueue(queue);
          }
          await renderLessonsSchedules();
          showToast('Pending lesson plan removed from queue.', 'error');
        }
      } else {
        const lessonsList = await db.getLessons();
        const planTopic = lessonsList.find(l => l.id === btn.dataset.id)?.topic || 'lesson';
        if (confirm(`Delete curriculum folder document for "${planTopic}"?`)) {
          await db.deleteLesson(btn.dataset.id);
          await renderLessonsSchedules();
          showToast('Lesson draft deleted successfully.', 'error');
        }
      }
    });
  });

  container.querySelectorAll('.force-retry-plan-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.innerText = 'Retrying...';
      await processAIRetryQueueItem(btn.dataset.queueId);
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

function populateLessonFormSubjects() {
  const select = document.getElementById('lesson-subject');
  if (!select) return;
  select.innerHTML = '<option value="">-- Choose Subject --</option>';
  state.settings.subjects.forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.innerText = sub;
    select.appendChild(opt);
  });
}

// Render dynamic Classroom Behavioral Incidents Tracker
async function renderIncidents() {
  const studentSelect = document.getElementById('incident-student');
  const feedList = document.getElementById('incidents-history-list');

  if (!studentSelect || !feedList) return;

  const sectionStudents = getStudentsBySection(state.activeSectionId);
  const sectionStudentIds = new Set(sectionStudents.map(s => s.id));

  // 1. Populate log student select dropdown
  studentSelect.innerHTML = '<option value="">-- Select Student Involved --</option>';
  sectionStudents.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.innerText = s.name;
    studentSelect.appendChild(opt);
  });

  // Today date defaults for logging
  document.getElementById('incident-date').value = new Date().toISOString().split('T')[0];

  // 2. Render feed list
  const incidents = await db.getIncidents();
  const filteredIncidents = incidents.filter(i => sectionStudentIds.has(i.studentId));
  feedList.innerHTML = '';

  if (filteredIncidents.length === 0) {
    feedList.innerHTML = `
      <div style="text-align: center; color: var(--text-secondary); padding: 32px 12px;">
        <i data-lucide="file-check-2" style="width:36px; height:36px; margin: 0 auto 10px auto; opacity:0.5; color:var(--success-color);"></i>
        <p style="font-size:0.95rem;">Model Behavior Active: Empty incidents list!</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  filteredIncidents.forEach(incident => {
    const studName = sectionStudents.find(s => s.id === incident.studentId)?.name || 'De-registered Student';
    const formDate = incident.date 
      ? new Date(incident.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Asynchronous';

    const card = document.createElement('div');
    card.className = 'incident-card';
    card.innerHTML = `
      <div class="incident-meta">
        <div>
          <strong style="color:var(--text-primary); font-size:1.05rem;">${studName}</strong>
          <span style="font-size:0.8rem; display:block; color:var(--error-color); margin-top:2px;">Category: ${incident.type}</span>
        </div>
        <div style="font-size:0.8rem; font-family:var(--font-mono); color:var(--text-secondary);">${formDate}</div>
      </div>
      
      <div style="margin-bottom:12px; font-size:0.92rem; line-height:1.45; color:var(--text-secondary);">
        <strong style="color:var(--text-primary); display:block; font-size:0.8rem; text-transform:uppercase; margin-bottom:4px;">Chronology:</strong>
        ${incident.description}
      </div>
      
      <div style="background-color:rgba(0,0,0,0.15); border-left:3px solid var(--accent-color); padding:8px 12px; border-radius:4px; font-size:0.88rem; color:var(--text-secondary);">
        <strong style="color:var(--text-primary); display:block; font-size:0.75rem; text-transform:uppercase; margin-bottom:2px;">Action Taken:</strong>
        ${incident.action}
      </div>

      <div class="student-card-actions" style="margin-top:14px; padding-top:10px;">
        <button class="btn btn-secondary btn-small transmit-incident-btn" data-id="${incident.id}">
          <i data-lucide="share" style="width:12px; height:12px;"></i> Send to Principal
        </button>
        <button class="btn btn-danger btn-small delete-incident-btn" data-id="${incident.id}">Remove</button>
      </div>
    `;
    feedList.appendChild(card);
  });

  // Attach Incident Card Buttons Listeners
  feedList.querySelectorAll('.transmit-incident-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const incidentsList = await db.getIncidents();
      const inc = incidentsList.find(i => i.id === btn.dataset.id);
      if (!inc) return;
      const studentName = state.students.find(s => s.id === inc.studentId)?.name || 'Student';
      
      // Compile highly professional clipboard format text representation
      const reportClip = `STUDENT INCIDENT FORWARD
-------------------------
Reporter/Teacher: ${state.settings.name}
Class Division: ${state.settings.className}
School Institution: ${state.settings.school}

Active Subject Profile:
- Student Involved: ${studentName}
- Date File: ${inc.date}
- Category Type: ${inc.type}

Fact Description Chronology:
- "${inc.description}"

Resolution Action Taken:
- "${inc.action}"
-------------------------
Generated via K-12 Teacher Workspace Database.`;

      copyTextToClipboard(reportClip, 'Incident dossier formatted and copied to clipboard successfully!');
    });
  });

  feedList.querySelectorAll('.delete-incident-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Delete behavioral incident archive entry?')) {
        await db.deleteIncident(btn.dataset.id);
        await renderIncidents();
        showToast('Incident chronicled entry removed from database.', 'error');
      }
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

// Render dynamic messaging student select panel elements
async function renderParentMessages() {
  const select = document.getElementById('message-student');
  if (!select) return;

  const sectionStudents = getStudentsBySection(state.activeSectionId);
  select.innerHTML = '<option value="">-- Choose Student Roster Profile --</option>';
  sectionStudents.forEach(student => {
    const opt = document.createElement('option');
    opt.value = student.id;
    opt.innerText = student.name;
    select.appendChild(opt);
  });

  // Attach change listener to update drafts list for selected student
  select.removeEventListener('change', handleMessageStudentChange);
  select.addEventListener('change', handleMessageStudentChange);

  // Trigger default selection rendering
  if (sectionStudents.length > 0) {
    select.value = sectionStudents[0].id;
    await renderSavedDraftsAndQueue(sectionStudents[0].id);
  } else {
    await renderSavedDraftsAndQueue('');
  }
}

async function handleMessageStudentChange(e) {
  await renderSavedDraftsAndQueue(e.target.value);
}

// Render dynamic metrics inside Progress Reports View Screen
async function renderProgressReports() {
  const select = document.getElementById('reports-student-select');
  if (!select) return;

  const sectionStudents = getStudentsBySection(state.activeSectionId);
  select.innerHTML = '<option value="">-- Select Student Target Profile --</option>';
  sectionStudents.forEach(student => {
    const opt = document.createElement('option');
    opt.value = student.id;
    opt.innerText = student.name;
    select.appendChild(opt);
  });

  // Attach change listener to update progress reports and reports drafts list
  select.removeEventListener('change', handleReportStudentChange);
  select.addEventListener('change', handleReportStudentChange);

  // Trigger metrics analysis for currently active selection
  if (sectionStudents.length > 0) {
    select.value = sectionStudents[0].id;
    await calculateProgressMetrics(sectionStudents[0].id);
    await renderSavedReportsAndQueue(sectionStudents[0].id);
  } else {
    document.getElementById('report-grade-avg').innerText = '0.0%';
    document.getElementById('report-attendance-rate').innerText = '100.0%';
    document.getElementById('report-incident-count').innerText = '0';
    await renderSavedReportsAndQueue('');
  }
}

async function handleReportStudentChange(e) {
  await calculateProgressMetrics(e.target.value);
  await renderSavedReportsAndQueue(e.target.value);
}

// Calculate progress analytics for a single student profile
async function calculateProgressMetrics(studentId) {
  if (!studentId) return;

  // 1. Calculate Grade Book Cumulative Average over all subjects
  let gradeSumTotal = 0, assignmentCountTotal = 0;
  
  for (const sub of state.settings.subjects) {
    const gradeBookData = await db.getGradesForSubject(sub, state.activeSectionId);
    const studScores = gradeBookData.scores[studentId] || {};
    
    gradeBookData.assignments.forEach(assign => {
      const score = studScores[assign.id];
      if (score !== undefined && score !== '') {
        gradeSumTotal += parseFloat(score);
        assignmentCountTotal++;
      }
    });
  }

  const aggregateAvg = assignmentCountTotal > 0 ? Math.round((gradeSumTotal / assignmentCountTotal) * 10) / 10 : null;
  const gradeDisplayNode = document.getElementById('report-grade-avg');
  
  if (gradeDisplayNode) {
    if (aggregateAvg !== null) {
      gradeDisplayNode.innerText = `${aggregateAvg}%`;
      gradeDisplayNode.className = aggregateAvg >= 75 ? 'avg-green' : (aggregateAvg >= 50 ? 'avg-amber' : 'avg-red');
    } else {
      gradeDisplayNode.innerText = 'No grades in records';
      gradeDisplayNode.className = '';
    }
  }

  // 2. Calculate Active Attendance Rate %
  const allHistory = await db.getAllAttendanceHistory();
  const sectionHistory = allHistory.filter(h => h.sectionId === state.activeSectionId);
  let loggedDaysCount = sectionHistory.length;
  let activeStudentPrC = 0;

  for (const day of sectionHistory) {
    const status = day.marks[studentId];
    if (status === 'present' || status === 'late') {
      activeStudentPrC++;
    }
  }

  const attendanceRatio = loggedDaysCount > 0 ? Math.round((activeStudentPrC / loggedDaysCount) * 1000) / 10 : 100;
  const attendanceDisplayNode = document.getElementById('report-attendance-rate');
  if (attendanceDisplayNode) {
    attendanceDisplayNode.innerText = `${attendanceRatio}%`;
    attendanceDisplayNode.className = attendanceRatio >= 85 ? 'avg-green' : (attendanceRatio >= 70 ? 'avg-amber' : 'avg-red');
  }

  // 3. Count incidents logged
  const incidentsList = await db.getIncidents();
  const incidentsTotalCount = incidentsList.filter(inc => inc.studentId === studentId).length;
  const incidentDisplayNode = document.getElementById('report-incident-count');
  if (incidentDisplayNode) {
    incidentDisplayNode.innerText = incidentsTotalCount;
    incidentDisplayNode.style.color = incidentsTotalCount > 0 ? 'var(--error-color)' : 'var(--success-color)';
  }
}

// Settings Module Renderers
function renderSettings() {
  document.getElementById('settings-teacher-name').value = state.settings.name || '';
  document.getElementById('settings-class-name').value = state.settings.className || '';
  document.getElementById('settings-school-name').value = state.settings.school || '';
  document.getElementById('settings-api-key').value = state.settings.apiKey || '';
  document.getElementById('settings-ai-provider').value = state.settings.aiProvider || 'gemini';
  document.getElementById('settings-groq-key').value = state.settings.groqApiKey || '';
  
  const provider = state.settings.aiProvider || 'gemini';
  const geminiGroup = document.getElementById('settings-gemini-key-group');
  const groqGroup = document.getElementById('settings-groq-key-group');
  if (provider === 'groq') {
    geminiGroup?.classList.add('hidden');
    groqGroup?.classList.remove('hidden');
  } else {
    geminiGroup?.classList.remove('hidden');
    groqGroup?.classList.add('hidden');
  }

  const settingsLang = document.getElementById('settings-language');
  if (settingsLang) {
    settingsLang.value = state.settings.language || 'en';
  }

  renderSettingsSubjects();
  renderSettingsSections();
}


function renderSettingsSubjects() {
  const container = document.getElementById('settings-tag-container');
  if (!container) return;

  container.innerHTML = '';
  state.settings.subjects.forEach(subject => {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = `
      <span>${subject}</span>
      <button class="tag-remove" data-name="${subject}" title="Delete Subject">&times;</button>
    `;
    container.appendChild(tag);
  });

  // Attach delete buttons listeners for subject tags
  container.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const subName = btn.dataset.name;
      if (confirm(`Remove "${subName}" from Course syllabus list? ALL grades entered for this subject will be permanently deleted.`)) {
        try {
          state.settings.subjects = state.settings.subjects.filter(s => s !== subName);
          db.saveSettings(state.settings);
          
          // Delete accompanying grade records safely from IndexedDB by saving empty data
          await db.saveGradesForSubject(subName, { subject: subName.replace(/\s+/g, '_'), assignments: [], scores: {} });

          showToast(`Course Subject "${subName}" deleted and matching grade sheets wiped.`, 'error');
          renderSettingsSubjects();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });
  });
}

function renderSectionsList(containerId, editBtnClass, deleteBtnClass) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  state.sections.forEach(sec => {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.style.display = 'inline-flex';
    tag.style.alignItems = 'center';
    tag.style.gap = '8px';
    tag.innerHTML = `
      <span>${sec.name}</span>
      <button class="${editBtnClass}" data-id="${sec.id}" title="Rename Section" style="background:none; border:none; color:var(--text-secondary); cursor:pointer; font-size:0.8rem; padding:0 2px;">
        ✏️
      </button>
      <button class="${deleteBtnClass} tag-remove" data-id="${sec.id}" title="Delete Section" style="background:none; border:none; cursor:pointer; padding:0 2px; font-weight:bold;">&times;</button>
    `;
    container.appendChild(tag);
  });

  // Rename Section trigger
  container.querySelectorAll(`.${editBtnClass}`).forEach(btn => {
    btn.addEventListener('click', async () => {
      const secId = btn.dataset.id;
      const sec = state.sections.find(s => s.id === secId);
      if (!sec) return;
      
      const newName = prompt('Enter new name for section:', sec.name);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed) {
        showToast('Section name cannot be empty.', 'error');
        return;
      }
      
      try {
        sec.name = trimmed;
        await db.saveSection(sec);
        state.sections = await db.getSections();
        renderSettingsSections();
        renderDashboardSections();
        showToast(`Section renamed to "${trimmed}".`, 'success');
        
        // Re-render universal selectors to reflect changes
        const activeModule = document.querySelector('.module.active');
        if (activeModule) {
          const activeId = activeModule.id.replace('module-', '');
          renderUniversalSectionSelector(activeId);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Delete Section trigger with cascade warning
  container.querySelectorAll(`.${deleteBtnClass}`).forEach(btn => {
    btn.addEventListener('click', async () => {
      const secId = btn.dataset.id;
      const sec = state.sections.find(s => s.id === secId);
      if (!sec) return;
      
      if (confirm(`CRITICAL WARNING: Deleting section "${sec.name}" will permanently delete ALL students, grades, and attendance records associated with it. Are you sure you want to proceed?`)) {
        try {
          await db.deleteSection(secId);
          state.sections = await db.getSections();
          state.students = await db.getStudents();
          
          if (state.activeSectionId === secId) {
            state.activeSectionId = state.sections[0]?.id || '';
            localStorage.setItem('activeSectionId', state.activeSectionId);
          }
          
          renderSettingsSections();
          renderDashboardSections();
          showToast(`Section "${sec.name}" and all associated data permanently deleted.`, 'error');
          
          // Re-render current module to reflect change
          await renderActiveModule();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });
  });
}

function renderSettingsSections() {
  renderSectionsList('settings-section-container', 'section-edit', 'section-remove');
}

function renderDashboardSections() {
  renderSectionsList('dash-section-container', 'dash-section-edit', 'dash-section-remove');
}

// ----------------------------------------------------
// Multilingual Translation System (Kannada, Hindi, English)
// ----------------------------------------------------
function initTranslation() {
  const englishKeys = Object.keys(TRANSLATIONS.en);
  
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const trimmed = node.textContent.trim();
      if (trimmed) {
        const matchKey = englishKeys.find(k => k === trimmed);
        if (matchKey) {
          if (node.parentNode && node.parentNode.hasAttribute('data-i18n-key')) {
            return;
          }
          const parent = node.parentNode;
          if (parent) {
            const tagName = parent.tagName.toLowerCase();
            if (tagName !== 'script' && tagName !== 'style' && tagName !== 'textarea' && tagName !== 'input') {
              const span = document.createElement('span');
              span.setAttribute('data-i18n-key', matchKey);
              span.textContent = node.textContent;
              parent.replaceChild(span, node);
            }
          }
        }
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      if (tagName !== 'script' && tagName !== 'style' && tagName !== 'textarea' && tagName !== 'input') {
        if (node.hasAttribute('placeholder')) {
          const placeholder = node.getAttribute('placeholder');
          const matchKey = englishKeys.find(k => k === placeholder);
          if (matchKey) {
            node.setAttribute('data-i18n-placeholder-key', matchKey);
          }
        }
        
        if (tagName === 'option') {
          const trimmed = node.textContent.trim();
          const matchKey = englishKeys.find(k => k === trimmed);
          if (matchKey) {
            node.setAttribute('data-i18n-key', matchKey);
          }
        }

        const children = Array.from(node.childNodes);
        for (let child of children) {
          walk(child);
        }
      }
    }
  }

  walk(document.body);
}

function applyLanguage(lang) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  
  document.querySelectorAll('[data-i18n-key]').forEach(el => {
    const key = el.getAttribute('data-i18n-key');
    if (dict[key]) {
      el.textContent = dict[key];
    }
  });

  document.querySelectorAll('[data-i18n-placeholder-key]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder-key');
    if (dict[key]) {
      el.setAttribute('placeholder', dict[key]);
    }
  });
}

function translatePage() {
  const lang = state.settings.language || 'en';
  initTranslation();
  applyLanguage(lang);
}

// ─────────────────────────────────────────────
// Offline AI Queue & Sync & Retry Helpers
// ─────────────────────────────────────────────

function getAIQueue() {
  try {
    const q = localStorage.getItem('ai_queue');
    return q ? JSON.parse(q) : [];
  } catch (e) {
    console.error('Error reading ai_queue:', e);
    return [];
  }
}

function saveAIQueue(queue) {
  try {
    localStorage.setItem('ai_queue', JSON.stringify(queue));
  } catch (e) {
    console.error('Error saving ai_queue:', e);
  }
}

function getAIRetryQueue() {
  try {
    const q = localStorage.getItem('ai_retry_queue');
    return q ? JSON.parse(q) : [];
  } catch (e) {
    console.error('Error reading ai_retry_queue:', e);
    return [];
  }
}

function saveAIRetryQueue(queue) {
  try {
    localStorage.setItem('ai_retry_queue', JSON.stringify(queue));
  } catch (e) {
    console.error('Error saving ai_retry_queue:', e);
  }
}

function queueLessonPlan({ subject, topic, grade, duration }) {
  const queue = getAIQueue();
  const dbId = db.generateUUID();
  const item = {
    id: db.generateUUID(),
    dbId,
    type: 'lesson',
    subject,
    topic,
    grade,
    duration,
    date: document.getElementById('lesson-date').value || '',
    timestamp: new Date().toISOString()
  };
  queue.push(item);
  saveAIQueue(queue);

  showToast('Saved to Queue. AI will generate this when you reconnect to the internet.', 'success');

  // Reset form and go back to directory view
  document.getElementById('lesson-id-holder').value = '';
  document.getElementById('lesson-specification-form').reset();
  document.getElementById('lesson-editable-editor').innerText = 'Start scribbling...';
  
  const btnViewSaved = document.getElementById('btn-view-saved-lessons');
  if (btnViewSaved) btnViewSaved.click();
}

function queueParentMessage({ studentId, studentName, tone, context }) {
  const queue = getAIQueue();
  const dbId = db.generateUUID();
  const item = {
    id: db.generateUUID(),
    dbId,
    type: 'message',
    studentId,
    studentName,
    tone,
    context,
    timestamp: new Date().toISOString()
  };
  queue.push(item);
  saveAIQueue(queue);

  showToast('Saved to Queue. AI will generate this when you reconnect to the internet.', 'success');

  // Reset form and update UI
  document.getElementById('message-context').value = '';
  document.getElementById('message-editable-output').value = 'Saved to offline sync queue. Gemini will write this message once your internet connection returns.';
  
  renderSavedDraftsAndQueue(studentId);
}

function queueProgressReport({ studentId, studentName, gradeAvg, attendanceRate, incidentCount }) {
  const queue = getAIQueue();
  const dbId = db.generateUUID();
  const item = {
    id: db.generateUUID(),
    dbId,
    type: 'report',
    studentId,
    studentName,
    gradeAvg,
    attendanceRate,
    incidentCount,
    timestamp: new Date().toISOString()
  };
  queue.push(item);
  saveAIQueue(queue);

  showToast('Saved to Queue. AI will generate this when you reconnect to the internet.', 'success');

  // Reset output and update UI
  document.getElementById('report-editable-content').innerText = 'Saved to offline sync queue. Gemini will write this progress report once your internet connection returns.';
  
  renderSavedReportsAndQueue(studentId);
}

function queueRetryItem({ moduleType, promptPayload, targetStudentId }) {
  const queue = getAIRetryQueue();
  const dbId = db.generateUUID();
  const retryItem = {
    id: db.generateUUID(),
    dbId,
    moduleType,
    promptPayload,
    targetStudentId: targetStudentId || null,
    timestamp: new Date().toISOString()
  };
  queue.push(retryItem);
  saveAIRetryQueue(queue);

  showToast('API rate limit reached. Your request has been queued and will generate in the background.', 'warning');

  if (moduleType === 'lesson') {
    document.getElementById('lesson-id-holder').value = '';
    document.getElementById('lesson-specification-form').reset();
    document.getElementById('lesson-editable-editor').innerText = 'Pending Generation: The AI is busy. This plan will be automatically generated in a minute.';
    const btnViewSaved = document.getElementById('btn-view-saved-lessons');
    if (btnViewSaved) btnViewSaved.click();
  } else if (moduleType === 'message') {
    document.getElementById('message-context').value = '';
    document.getElementById('message-editable-output').value = 'Pending Generation: The AI is busy. This draft will be generated automatically in a minute.';
    renderSavedDraftsAndQueue(targetStudentId);
  } else if (moduleType === 'report') {
    document.getElementById('report-editable-content').innerText = 'Pending Generation: The AI is busy. This report will be generated automatically in a minute.';
    renderSavedReportsAndQueue(targetStudentId);
  }
}

let isProcessingAiQueue = false;
let isProcessingRetryQueue = false;

async function processAIRetryQueueItem(itemId) {
  if (!navigator.onLine) {
    showToast('Cannot retry while offline.', 'error');
    return;
  }

  const queue = getAIRetryQueue();
  const item = queue.find(i => i.id === itemId);
  if (!item) return;

  try {
    showToast('Attempting to retry AI generation...', 'info');
    
    if (item.moduleType === 'lesson') {
      const resultText = await ai.generateLessonPlan({
        ...getAiConfig(),
        subject: item.promptPayload.subject,
        topic: item.promptPayload.topic,
        grade: item.promptPayload.grade,
        duration: item.promptPayload.duration
      });

      await db.saveLesson({
        id: item.dbId,
        subject: item.promptPayload.subject,
        topic: item.promptPayload.topic,
        date: item.promptPayload.date,
        content: resultText
      });
    } else if (item.moduleType === 'message') {
      const resultText = await ai.generateParentMessage({
        ...getAiConfig(),
        studentName: item.promptPayload.studentName,
        messageType: item.promptPayload.tone,
        context: item.promptPayload.context
      });

      await db.saveMessageDraft({
        id: item.dbId,
        studentId: item.targetStudentId,
        studentName: item.promptPayload.studentName,
        tone: item.promptPayload.tone,
        context: item.promptPayload.context,
        content: resultText,
        timestamp: new Date().toISOString()
      });
    } else if (item.moduleType === 'report') {
      const resultText = await ai.generateProgressReport({
        ...getAiConfig(),
        name: item.promptPayload.studentName,
        gradeAvg: item.promptPayload.gradeAvg,
        attendanceRate: item.promptPayload.attendanceRate,
        incidentCount: item.promptPayload.incidentCount
      });

      await db.saveReportDraft({
        id: item.dbId,
        studentId: item.targetStudentId,
        studentName: item.promptPayload.studentName,
        gradeAvg: item.promptPayload.gradeAvg,
        attendanceRate: item.promptPayload.attendanceRate,
        incidentCount: item.promptPayload.incidentCount,
        content: resultText,
        timestamp: new Date().toISOString()
      });
    }

    // Success! Remove from retry queue
    const newQueue = getAIRetryQueue().filter(i => i.id !== item.id);
    saveAIRetryQueue(newQueue);
    
    showToast('Your pending AI task has finished generating!', 'success');
    
    // Refresh the UI to reflect changes
    await renderActiveModule();
    
  } catch (err) {
    if (err.message === 'QUOTA_EXCEEDED') {
      showToast('AI is still busy. Please wait a minute before retrying again.', 'error');
      await renderActiveModule();
    } else {
      console.error('Failed to process retried AI item permanently:', item, err);
      const newQueue = getAIRetryQueue().filter(i => i.id !== item.id);
      saveAIRetryQueue(newQueue);
      showToast(`A queued AI task failed permanently: ${err.message}`, 'error');
      await renderActiveModule();
    }
  }
}

function renderPendingSyncItems() {
  const queue = getAIQueue();
  const retryQueue = getAIRetryQueue();

  // 1. Render Messages Queue
  const msgContainer = document.getElementById('pending-messages-container');
  const msgList = document.getElementById('pending-messages-list');
  if (msgContainer && msgList) {
    const offlineMsgItems = queue.filter(item => item.type === 'message');
    const retryMsgItems = retryQueue.filter(item => item.moduleType === 'message');
    
    const allMsgItems = [
      ...offlineMsgItems.map(item => ({ ...item, isRetry: false })),
      ...retryMsgItems.map(item => ({ ...item, isRetry: true, studentName: item.promptPayload.studentName }))
    ];

    if (allMsgItems.length > 0) {
      msgContainer.classList.remove('hidden');
      msgList.innerHTML = allMsgItems.map(item => {
        const label = item.isRetry ? 'AI Busy (Retrying)' : 'Pending Sync';
        return `
          <div class="attendance-item" style="border: 1px dashed var(--warning-color); border-radius: var(--border-radius-sm); padding: 8px 12px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; background: rgba(245, 166, 35, 0.05); margin-bottom: 6px;">
            <div>
              <strong>${item.studentName}</strong> - <span style="font-style: italic; color: var(--warning-color);">${label}</span>
            </div>
            <div style="display: flex; gap: 6px;">
              ${item.isRetry ? `<button class="btn btn-primary btn-small force-retry-btn" data-id="${item.id}" style="padding: 2px 6px; font-size: 0.75rem;">Retry</button>` : ''}
              <button class="btn btn-danger btn-small delete-queued-msg-btn" data-id="${item.id}" data-retry="${item.isRetry}" style="padding: 2px 6px; font-size: 0.75rem;">Cancel</button>
            </div>
          </div>
        `;
      }).join('');

      // Add cancel event listeners
      msgList.querySelectorAll('.delete-queued-msg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const qId = btn.dataset.id;
          const isRetry = btn.dataset.retry === 'true';
          if (confirm('Cancel this pending AI message request?')) {
            if (isRetry) {
              const newQ = getAIRetryQueue().filter(i => i.id !== qId);
              saveAIRetryQueue(newQ);
            } else {
              const newQ = getAIQueue().filter(i => i.id !== qId);
              saveAIQueue(newQ);
            }
            renderPendingSyncItems();
            showToast('Pending message generation request canceled.', 'error');
          }
        });
      });

      // Add force retry event listeners
      msgList.querySelectorAll('.force-retry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.innerText = 'Retrying...';
          await processAIRetryQueueItem(btn.dataset.id);
        });
      });
    } else {
      msgContainer.classList.add('hidden');
      msgList.innerHTML = '';
    }
  }

  // 2. Render Reports Queue
  const rptContainer = document.getElementById('pending-reports-container');
  const rptList = document.getElementById('pending-reports-list');
  if (rptContainer && rptList) {
    const offlineRptItems = queue.filter(item => item.type === 'report');
    const retryRptItems = retryQueue.filter(item => item.moduleType === 'report');
    
    const allRptItems = [
      ...offlineRptItems.map(item => ({ ...item, isRetry: false })),
      ...retryRptItems.map(item => ({ ...item, isRetry: true, studentName: item.promptPayload.studentName }))
    ];

    if (allRptItems.length > 0) {
      rptContainer.classList.remove('hidden');
      rptList.innerHTML = allRptItems.map(item => {
        const label = item.isRetry ? 'AI Busy (Retrying)' : 'Pending Sync';
        return `
          <div class="attendance-item" style="border: 1px dashed var(--warning-color); border-radius: var(--border-radius-sm); padding: 8px 12px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; background: rgba(245, 166, 35, 0.05); margin-bottom: 6px;">
            <div>
              <strong>${item.studentName}</strong> - <span style="font-style: italic; color: var(--warning-color);">${label}</span>
            </div>
            <div style="display: flex; gap: 6px;">
              ${item.isRetry ? `<button class="btn btn-primary btn-small force-retry-btn" data-id="${item.id}" style="padding: 2px 6px; font-size: 0.75rem;">Retry</button>` : ''}
              <button class="btn btn-danger btn-small delete-queued-rpt-btn" data-id="${item.id}" data-retry="${item.isRetry}" style="padding: 2px 6px; font-size: 0.75rem;">Cancel</button>
            </div>
          </div>
        `;
      }).join('');

      // Add cancel event listeners
      rptList.querySelectorAll('.delete-queued-rpt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const qId = btn.dataset.id;
          const isRetry = btn.dataset.retry === 'true';
          if (confirm('Cancel this pending AI progress report request?')) {
            if (isRetry) {
              const newQ = getAIRetryQueue().filter(i => i.id !== qId);
              saveAIRetryQueue(newQ);
            } else {
              const newQ = getAIQueue().filter(i => i.id !== qId);
              saveAIQueue(newQ);
            }
            renderPendingSyncItems();
            showToast('Pending progress report generation request canceled.', 'error');
          }
        });
      });

      // Add force retry event listeners
      rptList.querySelectorAll('.force-retry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.innerText = 'Retrying...';
          await processAIRetryQueueItem(btn.dataset.id);
        });
      });
    } else {
      rptContainer.classList.add('hidden');
      rptList.innerHTML = '';
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

async function renderSavedDraftsAndQueue(studentId) {
  renderPendingSyncItems();

  // Render Saved Drafts for this student
  const draftsContainer = document.getElementById('saved-messages-container');
  const draftsList = document.getElementById('saved-messages-list');
  if (draftsContainer && draftsList) {
    if (!studentId) {
      draftsContainer.classList.add('hidden');
      return;
    }
    const allDrafts = await db.getMessageDrafts();
    const studentDrafts = allDrafts.filter(d => d.studentId === studentId);
    
    if (studentDrafts.length > 0) {
      draftsContainer.classList.remove('hidden');
      draftsList.innerHTML = studentDrafts.map(d => {
        const date = new Date(d.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        let toneLabel = d.tone.split(' and ')[0].split(',')[0];
        if (toneLabel.length > 25) toneLabel = toneLabel.substring(0, 22) + '...';
        return `
          <div class="attendance-item" style="border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); padding: 8px 12px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); margin-bottom: 6px;">
            <div>
              <strong>${toneLabel}</strong> - <span style="font-size: 0.75rem; color: var(--text-secondary);">${date}</span>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-small select-msg-draft-btn" data-id="${d.id}" style="padding: 2px 6px; font-size: 0.75rem;">Load</button>
              <button class="btn btn-danger btn-small delete-msg-draft-btn" data-id="${d.id}" style="padding: 2px 6px; font-size: 0.75rem;">×</button>
            </div>
          </div>
        `;
      }).join('');

      // Event listeners
      draftsList.querySelectorAll('.select-msg-draft-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const drafts = await db.getMessageDrafts();
          const draft = drafts.find(d => d.id === btn.dataset.id);
          if (draft) {
            document.getElementById('message-editable-output').value = draft.content;
            showToast('Loaded saved parent message draft!', 'success');
          }
        });
      });

      draftsList.querySelectorAll('.delete-msg-draft-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('Delete this saved message draft?')) {
            await db.deleteMessageDraft(btn.dataset.id);
            await renderSavedDraftsAndQueue(studentId);
            showToast('Saved message draft deleted.', 'error');
          }
        });
      });
    } else {
      draftsContainer.classList.add('hidden');
    }
  }
}

async function renderSavedReportsAndQueue(studentId) {
  renderPendingSyncItems();

  // Render Saved Reports for this student
  const draftsContainer = document.getElementById('saved-reports-container');
  const draftsList = document.getElementById('saved-reports-list');
  if (draftsContainer && draftsList) {
    if (!studentId) {
      draftsContainer.classList.add('hidden');
      return;
    }
    const allDrafts = await db.getReportDrafts();
    const studentDrafts = allDrafts.filter(d => d.studentId === studentId);
    
    if (studentDrafts.length > 0) {
      draftsContainer.classList.remove('hidden');
      draftsList.innerHTML = studentDrafts.map(d => {
        const date = new Date(d.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `
          <div class="attendance-item" style="border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); padding: 8px 12px; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); margin-bottom: 6px;">
            <div>
              <strong>Report Draft</strong> - <span style="font-size: 0.75rem; color: var(--text-secondary);">${date}</span>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-small select-rpt-draft-btn" data-id="${d.id}" style="padding: 2px 6px; font-size: 0.75rem;">Load</button>
              <button class="btn btn-danger btn-small delete-rpt-draft-btn" data-id="${d.id}" style="padding: 2px 6px; font-size: 0.75rem;">×</button>
            </div>
          </div>
        `;
      }).join('');

      // Event listeners
      draftsList.querySelectorAll('.select-rpt-draft-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const drafts = await db.getReportDrafts();
          const draft = drafts.find(d => d.id === btn.dataset.id);
          if (draft) {
            document.getElementById('report-editable-content').innerText = draft.content;
            showToast('Loaded saved progress report draft!', 'success');
          }
        });
      });

      draftsList.querySelectorAll('.delete-rpt-draft-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('Delete this saved report draft?')) {
            await db.deleteReportDraft(btn.dataset.id);
            await renderSavedReportsAndQueue(studentId);
            showToast('Saved report draft deleted.', 'error');
          }
        });
      });
    } else {
      draftsContainer.classList.add('hidden');
    }
  }
}

async function processAiQueue() {
  if (!navigator.onLine) return;
  if (isProcessingAiQueue) return;
  
  const queue = getAIQueue();
  if (queue.length === 0) return;

  isProcessingAiQueue = true;
  showToast(`Reconnected! Synthesizing ${queue.length} queued AI draft(s)...`, 'success');

  const remaining = [];

  for (const item of queue) {
    try {
      if (item.type === 'lesson') {
        const resultText = await ai.generateLessonPlan({
          ...getAiConfig(),
          subject: item.subject,
          topic: item.topic,
          grade: item.grade,
          duration: item.duration
        });

        await db.saveLesson({
          id: item.dbId,
          subject: item.subject,
          topic: item.topic,
          date: item.date,
          content: resultText
        });

        showToast(`Your pending AI Lesson Plan "${item.topic}" has been generated successfully!`, 'success');
      } else if (item.type === 'message') {
        const resultText = await ai.generateParentMessage({
          ...getAiConfig(),
          studentName: item.studentName,
          messageType: item.tone,
          context: item.context
        });

        await db.saveMessageDraft({
          id: item.dbId,
          studentId: item.studentId,
          studentName: item.studentName,
          tone: item.tone,
          context: item.context,
          content: resultText,
          timestamp: new Date().toISOString()
        });

        showToast(`Your pending AI Message for "${item.studentName}" has been generated successfully!`, 'success');
      } else if (item.type === 'report') {
        const resultText = await ai.generateProgressReport({
          ...getAiConfig(),
          name: item.studentName,
          gradeAvg: item.gradeAvg,
          attendanceRate: item.attendanceRate,
          incidentCount: item.incidentCount
        });

        await db.saveReportDraft({
          id: item.dbId,
          studentId: item.studentId,
          studentName: item.studentName,
          gradeAvg: item.gradeAvg,
          attendanceRate: item.attendanceRate,
          incidentCount: item.incidentCount,
          content: resultText,
          timestamp: new Date().toISOString()
        });

        showToast(`Your pending AI Progress Report for "${item.studentName}" has been generated successfully!`, 'success');
      }
    } catch (err) {
      if (err.message === 'QUOTA_EXCEEDED') {
        const retryQueue = getAIRetryQueue();
        retryQueue.push({
          id: item.id || db.generateUUID(),
          dbId: item.dbId,
          moduleType: item.type,
          promptPayload: {
            subject: item.subject,
            topic: item.topic,
            grade: item.grade,
            duration: item.duration,
            date: item.date,
            studentName: item.studentName,
            tone: item.tone,
            context: item.context,
            gradeAvg: item.gradeAvg,
            attendanceRate: item.attendanceRate,
            incidentCount: item.incidentCount
          },
          targetStudentId: item.studentId || null,
          timestamp: new Date().toISOString()
        });
        saveAIRetryQueue(retryQueue);
        showToast(`The AI is currently busy. A queued task was moved to the retry list.`, 'warning');
      } else {
        console.error('Failed to sync queued AI item:', item, err);
        remaining.push(item);
        showToast(`Failed to sync a queued AI item: ${err.message}. It remains in queue.`, 'error');
      }
    }
  }

  saveAIQueue(remaining);
  isProcessingAiQueue = false;
  await renderActiveModule();
}

async function processAIRetryQueue() {
  if (!navigator.onLine) return;
  if (isProcessingRetryQueue) return;

  const queue = getAIRetryQueue();
  if (queue.length === 0) return;

  isProcessingRetryQueue = true;
  try {
    await processAIRetryQueueItem(queue[0].id);
  } finally {
    isProcessingRetryQueue = false;
  }
}

// ----------------------------------------------------
// Biometric Face Scanner Flow Control
// ----------------------------------------------------
async function startFaceScanner(mode) {
  state.scannerMode = mode;
  
  const modal = document.getElementById('face-scanner-modal');
  const video = document.getElementById('camera-video');
  const statusOverlay = document.getElementById('scanner-status-overlay');
  const progressOverlay = document.getElementById('scanner-progress-overlay');
  const successOverlay = document.getElementById('scanner-success-overlay');
  const triggerBtn = document.getElementById('btn-trigger-face-scan');
  const teacherSelectGroup = document.getElementById('scanner-teacher-select-group');
  const teacherSelect = document.getElementById('scanner-teacher-select');
  const errorMsg = document.getElementById('camera-error-msg');
  
  if (!modal || !video) return;

  // Reset overlay states
  if (errorMsg) {
    errorMsg.classList.add('hidden');
    errorMsg.innerText = '';
  }
  if (progressOverlay) progressOverlay.classList.add('hidden');
  if (successOverlay) successOverlay.classList.add('hidden');
  if (statusOverlay) {
    statusOverlay.innerText = 'Initializing Camera...';
    statusOverlay.classList.remove('hidden');
  }
  if (triggerBtn) {
    triggerBtn.disabled = false;
    triggerBtn.querySelector('span').innerText = mode === 'register' ? 'Scan Face' : 'Match & Verify';
  }

  // Handle selection dropdown in attendance mode
  if (mode === 'attendance') {
    if (teacherSelectGroup) teacherSelectGroup.classList.remove('hidden');
    if (teacherSelect) {
      teacherSelect.innerHTML = '';
      
      const registeredTeachers = state.teachers.filter(t => t.photo);
      if (registeredTeachers.length === 0) {
        showToast('No teacher profiles with registered face scans found.', 'error');
        return;
      }
      
      registeredTeachers.forEach(teacher => {
        const opt = document.createElement('option');
        opt.value = teacher.id;
        opt.innerText = `${teacher.name} (${teacher.code})`;
        teacherSelect.appendChild(opt);
      });
    }
    
    const titleEl = document.getElementById('face-scanner-title');
    if (titleEl) titleEl.querySelector('span').innerText = 'Biometric Attendance Check-in';
    const subEl = document.getElementById('face-scanner-subtitle');
    if (subEl) subEl.innerText = 'Identify your profile and perform scanning';
  } else {
    if (teacherSelectGroup) teacherSelectGroup.classList.add('hidden');
    const titleEl = document.getElementById('face-scanner-title');
    if (titleEl) titleEl.querySelector('span').innerText = 'Biometric Face Scanner';
    const subEl = document.getElementById('face-scanner-subtitle');
    if (subEl) subEl.innerText = 'Align your face in the center of the frame';
  }

  modal.classList.remove('hidden');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 640 },
        facingMode: 'user'
      },
      audio: false
    });
    state.activeStream = stream;
    video.srcObject = stream;
    video.play();
    if (statusOverlay) statusOverlay.innerText = 'Biometric scanner active';
  } catch (err) {
    console.error('Camera access error:', err);
    if (errorMsg) {
      errorMsg.innerText = 'Unable to access camera feed. Verify hardware configuration.';
      errorMsg.classList.remove('hidden');
    }
    if (statusOverlay) statusOverlay.innerText = 'Camera Access Failed';
    if (triggerBtn) triggerBtn.disabled = true;
  }
}

function stopFaceScanner() {
  const modal = document.getElementById('face-scanner-modal');
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const scanLine = document.getElementById('scan-line');
  
  if (state.activeStream) {
    state.activeStream.getTracks().forEach(track => track.stop());
    state.activeStream = null;
  }
  
  if (video) {
    video.srcObject = null;
    video.classList.remove('hidden');
  }

  if (canvas) {
    canvas.classList.add('hidden');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  if (scanLine) {
    scanLine.classList.remove('hidden');
  }
  
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function finishScan(dataUrl, precomputedDescriptor = null) {
  const progressOverlay = document.getElementById('scanner-progress-overlay');
  const successOverlay = document.getElementById('scanner-success-overlay');
  const successMatchMsg = document.getElementById('scanner-success-match-msg');
  const statusOverlay = document.getElementById('scanner-status-overlay');
  
  if (progressOverlay) progressOverlay.classList.add('hidden');
  
  if (state.scannerMode === 'register') {
    const photoInput = document.getElementById('teacher-photo-data');
    const photoImg = document.getElementById('teacher-photo-img');
    const placeholder = document.getElementById('teacher-photo-placeholder');
    const deleteBtn = document.getElementById('btn-delete-teacher-face');
    
    if (statusOverlay) statusOverlay.innerText = 'Verifying face structure...';

    // Verify face is actually detected before allowing registration
    try {
      let desc = precomputedDescriptor;
      if (!desc) {
        await loadFaceApiModels();
        desc = await getDescriptorFromImage(dataUrl);
      }
      if (!desc) {
        // Face detection failed
        const errorMsg = document.getElementById('camera-error-msg');
        if (errorMsg) {
          errorMsg.innerText = 'Registration Failed. Face not detected in frame. Please align your face in the center and try again.';
          errorMsg.classList.remove('hidden');
        }
        if (statusOverlay) statusOverlay.innerText = 'Face Not Detected';
        showToast('Face not detected. Registration blocked.', 'error');

        // Re-enable scan button so they can retry
        const triggerBtn = document.getElementById('btn-trigger-face-scan');
        if (triggerBtn) {
          triggerBtn.disabled = false;
          const textSpan = triggerBtn.querySelector('span');
          if (textSpan) textSpan.innerText = 'Scan Face';
        }
        return;
      }
    } catch (err) {
      console.error('Error during registration face validation:', err);
      showToast('Error validating face structure.', 'error');
      return;
    }

    if (photoInput) photoInput.value = dataUrl;
    if (photoImg) {
      photoImg.src = dataUrl;
      photoImg.classList.remove('hidden');
    }
    if (placeholder) placeholder.classList.add('hidden');
    if (deleteBtn) deleteBtn.classList.remove('hidden');

    if (successOverlay) successOverlay.classList.remove('hidden');
    if (successMatchMsg) successMatchMsg.innerText = 'Template registered to profile';
    if (statusOverlay) statusOverlay.innerText = 'Face Profile Registered';
    
    setTimeout(() => {
      stopFaceScanner();
    }, 1500);
    
  } else if (state.scannerMode === 'attendance') {
    const teacherSelect = document.getElementById('scanner-teacher-select');
    if (!teacherSelect) return;
    const teacherId = teacherSelect.value;
    const teacher = state.teachers.find(t => t.id === teacherId);
    
    if (!teacher) {
      showToast('Error validating profile details.', 'error');
      stopFaceScanner();
      return;
    }

    if (statusOverlay) statusOverlay.innerText = 'Comparing face biometrics...';

    // Perform check-in diagnostics to detect where failure lies
    try {
      await loadFaceApiModels();
      const desc1 = await getDescriptorFromImage(teacher.photo);
      const desc2 = precomputedDescriptor || await getDescriptorFromImage(dataUrl);

      if (!desc1) {
        const errorMsg = document.getElementById('camera-error-msg');
        if (errorMsg) {
          errorMsg.innerText = 'Verification Failed. No face found in your registered profile template. Please delete it in Settings and re-register.';
          errorMsg.classList.remove('hidden');
        }
        if (statusOverlay) statusOverlay.innerText = 'Profile Face Error';
        showToast('Face not found in registered profile template.', 'error');

        const triggerBtn = document.getElementById('btn-trigger-face-scan');
        if (triggerBtn) {
          triggerBtn.disabled = false;
          const textSpan = triggerBtn.querySelector('span');
          if (textSpan) textSpan.innerText = 'Match & Verify';
        }
        return;
      }

      if (!desc2) {
        const errorMsg = document.getElementById('camera-error-msg');
        if (errorMsg) {
          errorMsg.innerText = 'Verification Failed. Face not detected in current scan. Please center your face and try again.';
          errorMsg.classList.remove('hidden');
        }
        if (statusOverlay) statusOverlay.innerText = 'Scan Face Error';
        showToast('Face not detected in current camera view.', 'error');

        const triggerBtn = document.getElementById('btn-trigger-face-scan');
        if (triggerBtn) {
          triggerBtn.disabled = false;
          const textSpan = triggerBtn.querySelector('span');
          if (textSpan) textSpan.innerText = 'Match & Verify';
        }
        return;
      }

      // Compute matching similarity
      const distance = faceapi.euclideanDistance(desc1, desc2);
      console.log('Euclidean distance between face descriptors:', distance);
      
      const similarity = Math.max(0, 1 - distance) * 100;
      const passThreshold = 40.0; // Enforces Euclidean distance <= 0.60 (standard face-api match threshold)
      const matchScore = similarity.toFixed(1);

      if (similarity >= passThreshold) {
        if (successOverlay) successOverlay.classList.remove('hidden');
        if (successMatchMsg) successMatchMsg.innerText = `Matched: ${teacher.name} (${matchScore}%)`;
        if (statusOverlay) statusOverlay.innerText = 'Verification Successful';

        const currentMarks = await db.getTeacherAttendance(state.activeDate);
        currentMarks[teacherId] = 'present';
        
        try {
          await db.saveTeacherAttendance(state.activeDate, currentMarks);
          showToast(`Identity verified. ${teacher.name} marked Present.`, 'success');
          await renderAttendance();
        } catch (err) {
          showToast(err.message, 'error');
        }

        setTimeout(() => {
          stopFaceScanner();
        }, 2000);
      } else {
        // Face mismatch (different person / friend)
        const errorMsg = document.getElementById('camera-error-msg');
        if (errorMsg) {
          errorMsg.innerText = `Verification Failed. Face mismatch similarity (${matchScore}%) is below the required threshold.`;
          errorMsg.classList.remove('hidden');
        }
        if (statusOverlay) statusOverlay.innerText = 'Verification Failed';
        showToast('Identity verification failed: mismatch detected.', 'error');

        const triggerBtn = document.getElementById('btn-trigger-face-scan');
        if (triggerBtn) {
          triggerBtn.disabled = false;
          const textSpan = triggerBtn.querySelector('span');
          if (textSpan) textSpan.innerText = 'Match & Verify';
        }
      }
    } catch (err) {
      console.error('Error during biometric comparison:', err);
      showToast('Error performing biometric comparison.', 'error');
    }
  }
}

// ----------------------------------------------------
// Biometric Face Comparison Algorithms (face-api.js)
// ----------------------------------------------------
let modelsLoaded = false;
async function loadFaceApiModels() {
  if (modelsLoaded) return;
  const statusOverlay = document.getElementById('scanner-status-overlay');
  if (statusOverlay) statusOverlay.innerText = 'Loading neural network models...';
  
  // Use relative path to support subdirectories/subpaths correctly
  const MODEL_URL = './models/';
  
  // Implement a 15-second loading timeout to prevent UI freeze on slow connection
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Model download timed out.')), 15000)
  );

  try {
    await Promise.race([
      Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]),
      timeoutPromise
    ]);
    
    modelsLoaded = true;
    console.log('face-api.js neural network models loaded successfully.');
  } catch (err) {
    console.error('Error loading face-api models:', err);
    throw new Error('Failed to load neural network models. Check network connectivity or path settings.');
  }
}

async function getDescriptorFromImage(photoUrlOrImgElement) {
  let img = photoUrlOrImgElement;
  if (typeof photoUrlOrImgElement === 'string') {
    img = await new Promise((resolve, reject) => {
      const i = new Image();
      // Only set crossOrigin for external HTTP/HTTPS URLs, as setting it on base64 data URIs throws a security exception.
      if (photoUrlOrImgElement.startsWith('http') || photoUrlOrImgElement.startsWith('//')) {
        i.crossOrigin = 'anonymous';
      }
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(new Error('Image failed to load: check format or permissions.'));
      i.src = photoUrlOrImgElement;
    });
  }
  
  // Configure detection options with a slightly lower confidence threshold (0.4) for robust low-light detection
  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 });
  const detection = await faceapi.detectSingleFace(img, options)
    .withFaceLandmarks()
    .withFaceDescriptor();
    
  return detection ? detection.descriptor : null;
}

async function compareFaces(photoDataUrl1, photoDataUrl2) {
  try {
    await loadFaceApiModels();
    
    const desc1 = await getDescriptorFromImage(photoDataUrl1);
    const desc2 = await getDescriptorFromImage(photoDataUrl2);
    
    if (!desc1 || !desc2) {
      console.warn('Face detection failed for one or both templates.');
      return 0; // 0% similarity
    }
    
    const distance = faceapi.euclideanDistance(desc1, desc2);
    console.log('Euclidean distance between face descriptors:', distance);
    
    // Scale similarity score where distance <= 0.55 (match) corresponds to >= 45.0% similarity.
    const similarity = Math.max(0, 1 - distance) * 100;
    return similarity;
  } catch (err) {
    console.error("Error during neural network comparison:", err);
    return 0;
  }
}

// ----------------------------------------------------
// Biometric Eye and Face Scan Visualization Overlays
// ----------------------------------------------------
function drawBiometricOverlay(canvas, landmarks, progress) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const pts = landmarks.positions; // Array of 68 { x, y } points

  // 1. Draw neon-cyan wireframe mesh
  ctx.strokeStyle = 'rgba(0, 243, 255, 0.3)';
  ctx.lineWidth = 1;
  
  // Jawline (0-16)
  drawPath(ctx, pts.slice(0, 17), false);
  // Eyebrows (17-21, 22-26)
  drawPath(ctx, pts.slice(17, 22), false);
  drawPath(ctx, pts.slice(22, 27), false);
  // Nose (27-30, 31-35)
  drawPath(ctx, pts.slice(27, 31), false);
  drawPath(ctx, pts.slice(31, 36), false);
  // Eyes (36-41, 42-47)
  drawPath(ctx, pts.slice(36, 42), true);
  drawPath(ctx, pts.slice(42, 48), true);
  // Mouth (48-59)
  drawPath(ctx, pts.slice(48, 60), true);
  
  // Connect extra futuristic lines (e.g. eye corners to eyebrows/nose)
  ctx.beginPath();
  // Nose bridge to inner brows
  ctx.moveTo(pts[27].x, pts[27].y); ctx.lineTo(pts[21].x, pts[21].y);
  ctx.moveTo(pts[27].x, pts[27].y); ctx.lineTo(pts[22].x, pts[22].y);
  // Nose tip to inner eye corners
  ctx.moveTo(pts[30].x, pts[30].y); ctx.lineTo(pts[39].x, pts[39].y);
  ctx.moveTo(pts[30].x, pts[30].y); ctx.lineTo(pts[42].x, pts[42].y);
  // Outer eyes to jawline
  ctx.moveTo(pts[36].x, pts[36].y); ctx.lineTo(pts[0].x, pts[0].y);
  ctx.moveTo(pts[45].x, pts[45].y); ctx.lineTo(pts[16].x, pts[16].y);
  ctx.stroke();

  // 2. Draw Eye Reticles (Left eye indices 36-41, Right eye indices 42-47)
  const leftEyePts = pts.slice(36, 42);
  const leftCenter = getCenter(leftEyePts);
  const leftRadius = getRadius(leftEyePts, leftCenter) * 2.2;

  const rightEyePts = pts.slice(42, 48);
  const rightCenter = getCenter(rightEyePts);
  const rightRadius = getRadius(rightEyePts, rightCenter) * 2.2;

  drawEyeReticle(ctx, leftCenter, leftRadius, progress);
  drawEyeReticle(ctx, rightCenter, rightRadius, progress);

  // 3. Draw horizontal sweeping laser line (Amber)
  const laserY = (progress / 100) * size;
  
  // Laser Glow
  const laserGrad = ctx.createLinearGradient(0, laserY - 15, 0, laserY + 15);
  laserGrad.addColorStop(0, 'rgba(245, 166, 35, 0)');
  laserGrad.addColorStop(0.5, 'rgba(245, 166, 35, 0.6)');
  laserGrad.addColorStop(1, 'rgba(245, 166, 35, 0)');
  
  ctx.fillStyle = laserGrad;
  ctx.fillRect(0, laserY - 15, size, 30);
  
  // Core laser line
  ctx.strokeStyle = '#f5a623';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, laserY);
  ctx.lineTo(size, laserY);
  ctx.stroke();
}

function drawPath(ctx, points, closePath) {
  if (!points || points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  if (closePath) ctx.closePath();
  ctx.stroke();
}

function getCenter(points) {
  let sumX = 0, sumY = 0;
  points.forEach(p => {
    sumX += p.x;
    sumY += p.y;
  });
  return { x: sumX / points.length, y: sumY / points.length };
}

function getRadius(points, center) {
  let maxDist = 0;
  points.forEach(p => {
    const dist = Math.hypot(p.x - center.x, p.y - center.y);
    if (dist > maxDist) maxDist = dist;
  });
  return maxDist || 10;
}

function drawEyeReticle(ctx, center, radius, progress) {
  // Pulse effect based on progress percentage
  const pulse = radius * (1 + 0.1 * Math.sin(progress * 0.15));
  
  // Outer circle
  ctx.strokeStyle = 'rgba(0, 243, 255, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(center.x, center.y, pulse, 0, 2 * Math.PI);
  ctx.stroke();

  // Inner crosshair target center dot
  ctx.fillStyle = 'rgba(0, 243, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(center.x, center.y, 2, 0, 2 * Math.PI);
  ctx.fill();

  // Draw corner ticks / bracket indicators around the eye
  const tickLen = pulse * 0.4;
  ctx.beginPath();
  // Top-Left corner
  ctx.moveTo(center.x - pulse, center.y - pulse + tickLen);
  ctx.lineTo(center.x - pulse, center.y - pulse);
  ctx.lineTo(center.x - pulse + tickLen, center.y - pulse);
  
  // Top-Right corner
  ctx.moveTo(center.x + pulse - tickLen, center.y - pulse);
  ctx.lineTo(center.x + pulse, center.y - pulse);
  ctx.lineTo(center.x + pulse, center.y - pulse + tickLen);

  // Bottom-Left corner
  ctx.moveTo(center.x - pulse, center.y + pulse - tickLen);
  ctx.lineTo(center.x - pulse, center.y + pulse);
  ctx.lineTo(center.x - pulse + tickLen, center.y + pulse);

  // Bottom-Right corner
  ctx.moveTo(center.x + pulse - tickLen, center.y + pulse);
  ctx.lineTo(center.x + pulse, center.y + pulse);
  ctx.lineTo(center.x + pulse, center.y + pulse - tickLen);
  
  ctx.stroke();
  
  // Draw subtle eye scanning label text
  ctx.font = 'bold 8px monospace';
  ctx.fillStyle = 'rgba(0, 243, 255, 0.85)';
  ctx.textAlign = 'center';
  ctx.fillText('LOCK ON', center.x, center.y - pulse - 5);
}
