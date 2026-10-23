/* ============================================================
   Study Helper — frontend (Clean Rebuild)
   ============================================================ */

const $ = (id) => document.getElementById(id);
const PROFILE_ID_KEY = 'studyHelper.profileId';
const TTS_ENABLED_KEY = 'studyHelper.ttsEnabled';
const COMMON_SUBJECTS = ['Mathematics','English','Physics','Chemistry','Biology','History','Geography','Computer Science','Economics','Business Studies','Accounting','Literature','Art','Music'];
const SUBJECT_COLORS = ['#4f46e5','#0891b2','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'];

function getSubjectColor(s){
  if (!s) return SUBJECT_COLORS[0];
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return SUBJECT_COLORS[Math.abs(h) % SUBJECT_COLORS.length];
}
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Burning the midnight oil';
}

const state = {
  profile: null, profileId: null,
  materials: [], materialId: null,
  docId: null, docName: '', history: [], sending: false,
  selectedSubjects: new Set(),
  timetable: null, timetableLoading: false,
  vision: null, visionLoading: false,
  exercises: [], current: null, answers: {}, mode: 'type',
  answerFile: null, submitting: false,
  announcements: [], unreadAnnouncements: 0,
  ttsEnabled: false, ttsVoice: null, ttsRate: 1.0,
  pollTimer: null
};

const views = {
  auth: $('authView'), profile: $('profileView'), upload: $('uploadView'), chat: $('chatView'),
  timetable: $('timetableView'), vision: $('visionView'),
  exercises: $('exercisesView'), takeExercise: $('takeExerciseView'),
  result: $('resultView'), info: $('infoView')
};

const toast = $('toast');
const toastAnn = $('toastAnnouncement');
const usageText = $('usageText'), usageDot = $('usageDot');
const profileBtn = $('profileBtn'), timetableBtn = $('timetableBtn');
const visionBtn = $('visionBtn'), exercisesBtn = $('exercisesBtn');
const exBadge = $('exBadge');
const ttsToggle = $('ttsToggle');

function showToast(msg){ toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); }
function showAnnouncementToast(msg){ toastAnn.textContent = msg; toastAnn.classList.add('show'); setTimeout(() => toastAnn.classList.remove('show'), 5000); }
function showView(name){
  Object.values(views).forEach(v => v && v.classList.remove('active'));
  if (views[name]) views[name].classList.add('active');
  window.scrollTo(0, 0);
}
async function refreshUsage(){
  try {
    const r = await fetch('/api/usage');
    const d = await r.json();
    usageText.textContent = `${d.used} / ${d.limit} today`;
    usageDot.className = 'dot';
    if (d.used >= d.limit) usageDot.classList.add('danger');
    else if (d.used > d.limit * 0.8) usageDot.classList.add('warn');
  } catch { usageText.textContent = '—'; }
}

// --- TTS ---
function stripMarkdownForSpeech(md){
  if (!md) return '';
  return md.replace(/```[\s\S]*?```/g, ' [code example] ').replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1').replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^[\s]*[-*+]\s+/gm, '').replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '').replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\s+/g, ' ').trim();
}
function pickVoice(){
  try {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || !voices.length) return null;
    
    const preferred = [/Google UK English Female/i, /Google US English/i, /Samantha/i, /Karen/i, /en[-_]GB/i, /en[-_]US/i];
    
    for (const p of preferred) { 
      const v = voices.find(v => {
        if (v.name && p.test(v.name)) return true;
        if (v.lang && typeof v.lang === 'string' && v.lang.match(p)) return true;
        return false;
      }); 
      if (v) return v; 
    }
    return voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
  } catch (e) {
    return null;
  }
}
function cancelSpeech(){
  if (!('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); } catch {}
  document.querySelectorAll('.bubble.speaking').forEach(b => b.classList.remove('speaking'));
}
function speak(text, bubbleEl = null){
  if (!state.ttsEnabled) return;
  if (!('speechSynthesis' in window)) { showToast('Speech not supported.'); return; }
  cancelSpeech();
  const clean = stripMarkdownForSpeech(text);
  if (!clean) return;
  if (bubbleEl) bubbleEl.classList.add('speaking');
  const u = new SpeechSynthesisUtterance(clean);
  if (state.ttsVoice) u.voice = state.ttsVoice;
  u.rate = 0.95; u.pitch = 1.0;
  u.onend = () => { if (bubbleEl) bubbleEl.classList.remove('speaking'); };
  u.onerror = () => { if (bubbleEl) bubbleEl.classList.remove('speaking'); };
  window.speechSynthesis.speak(u);
}
function updateTtsToggleUI(){
  if (!ttsToggle) return;
  ttsToggle.textContent = state.ttsEnabled ? '🔊' : '🔇';
  ttsToggle.classList.toggle('off', !state.ttsEnabled);
}
function initTts(){
  state.ttsEnabled = localStorage.getItem(TTS_ENABLED_KEY) === '1';
  updateTtsToggleUI();
  if (!('speechSynthesis' in window)) { ttsToggle.style.display = 'none'; return; }
  state.ttsVoice = pickVoice();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => { state.ttsVoice = pickVoice(); });
  ttsToggle.addEventListener('click', () => {
    state.ttsEnabled = !state.ttsEnabled;
    localStorage.setItem(TTS_ENABLED_KEY, state.ttsEnabled ? '1' : '0');
    updateTtsToggleUI();
    if (!state.ttsEnabled) { cancelSpeech(); showToast('Reading aloud turned off'); }
    else { try { const u = new SpeechSynthesisUtterance(''); u.volume = 0; window.speechSynthesis.speak(u); } catch {} showToast('Reading aloud turned on'); }
  });
}

// --- Auth & Profile ---
async function loadProfileFromServer(){
  const id = localStorage.getItem(PROFILE_ID_KEY);
  if (!id) return null;
  try {
    const r = await fetch(`/api/profile/${id}`);
    if (!r.ok) { localStorage.removeItem(PROFILE_ID_KEY); return null; }
    return await r.json();
  } catch { return null; }
}
async function saveProfileToServer(p){
  const r = await fetch('/api/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Save failed.');
  localStorage.setItem(PROFILE_ID_KEY, d.id);
  return d.profile;
}
function renderSubjectChips(){
  const c = $('subjectChips'); c.innerHTML = '';
  for (const s of COMMON_SUBJECTS) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'chip' + (state.selectedSubjects.has(s) ? ' active' : '');
    b.textContent = s;
    b.onclick = () => { if (state.selectedSubjects.has(s)) state.selectedSubjects.delete(s); else state.selectedSubjects.add(s); renderSubjectChips(); };
    c.appendChild(b);
  }
}
function addCustomSubject(){
  const i = $('customSubject'); const v = i.value.trim();
  if (!v) return;
  if (!COMMON_SUBJECTS.includes(v)) COMMON_SUBJECTS.push(v);
  state.selectedSubjects.add(v); i.value = ''; renderSubjectChips();
}
function updateProfileButton(){
  if (!state.profile) {
    profileBtn.classList.remove('visible');
    [timetableBtn, visionBtn, exercisesBtn].forEach(b => b.style.display = 'none');
    return;
  }
  profileBtn.textContent = (state.profile.name || '?').charAt(0).toUpperCase();
  profileBtn.classList.add('visible');
  [timetableBtn, visionBtn, exercisesBtn].forEach(b => b.style.display = 'flex');
  const lcBtn = document.getElementById('liveClassBtn');
  if (lcBtn) lcBtn.style.display = 'flex';
}
function fillProfileForm(p){
  if (!p) return;
  $('pName').value = p.name || ''; $('pAge').value = p.age || '';
  $('pLevel').value = p.level || ''; $('pGrade').value = p.grade || '';
  $('pSchool').value = p.school || ''; $('pGoal').value = p.goal || '';
  $('pExamDate').value = p.examDate || ''; $('pHours').value = p.hours || 10;
  $('pStyle').value = p.style || 'mixed'; $('pTime').value = p.time || 'evening';
  $('pNotes').value = p.notes || '';
  state.selectedSubjects = new Set(p.subjects || []); renderSubjectChips();
}

async function handleProfileSubmit(e){
  e.preventDefault();
  const subjects = Array.from(state.selectedSubjects);
  if (!subjects.length) { showToast('Pick at least one subject.'); return; }
  const p = {
    id: state.profile?.id, name: $('pName').value.trim(), age: Number($('pAge').value),
    level: $('pLevel').value, grade: $('pGrade').value.trim(), school: $('pSchool').value.trim(), subjects,
    goal: $('pGoal').value, examDate: $('pExamDate').value || '', hours: Number($('pHours').value),
    style: $('pStyle').value, time: $('pTime').value, notes: $('pNotes').value.trim()
  };
  if (!p.name || !p.age || !p.level || !p.grade) { showToast('Fill required fields.'); return; }
  const btn = e.target.querySelector('.btn-primary-large');
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let saved;
    const isRegister = !!$('regUserHidden').value;
    if (isRegister) {
      p.username = $('regUserHidden').value;
      p.password = $('regPassHidden').value;
      const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      saved = d.profile; localStorage.setItem('studyHelper.profileId', d.id);
      $('regUserHidden').value = ''; $('regPassHidden').value = '';
    } else {
      saved = await saveProfileToServer(p);
    }
    state.profile = saved; state.profileId = saved.id;
    updateProfileButton();
    $('heroName').innerHTML = getGreeting() + ', <span class="accent">' + saved.name + '</span>';
    showToast(`Welcome, ${saved.name}!`);
    await loadMaterials();
    await pollAnnouncements();
    showView('upload');
  } catch (err) { showToast(err.message); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// --- Materials & Chat ---
async function loadMaterials(){
  if (!state.profileId) return;
  try { const r = await fetch(`/api/materials/${state.profileId}`); const d = await r.json(); state.materials = d.materials || []; renderMaterials(); } catch (e) {}
}
function renderMaterials(){
  const grid = $('modulesGrid');
  if (!state.materials.length) {
    grid.innerHTML = `<div class="modules-empty"><div class="modules-empty-icon">📚</div><h3>No modules yet</h3><p>Upload up to 6 PDF or DOCX files. Each becomes a subject the tutor can teach you.</p><button class="btn-primary-inline" onclick="document.getElementById('addMaterialsBtn').click()">📎 Add your first module</button></div>`;
    return;
  }
  grid.innerHTML = state.materials.map(m => `<div class="module-card" data-id="${m.id}"><button class="module-delete" data-id="${m.id}" title="Remove">🗑</button><div class="module-subject">${escapeHtml(m.subject)}</div><h3>${escapeHtml(m.title)}</h3><div class="module-topics">${m.topics.length} topics</div><div class="module-size">${Math.round(m.textLength / 1000)}k chars</div></div>`).join('');
  grid.querySelectorAll('.module-card').forEach(c => { c.addEventListener('click', e => { if (e.target.closest('.module-delete')) return; openModule(c.dataset.id); }); });
  grid.querySelectorAll('.module-delete').forEach(b => { b.addEventListener('click', async e => { e.stopPropagation(); if (!confirm('Remove this module?')) return; await fetch(`/api/materials/${state.profileId}/${b.dataset.id}`, { method: 'DELETE' }); await loadMaterials(); }); });
}
async function uploadMaterials(files){
  if (!files || !files.length) return;
  const err = $('materialsError'), upl = $('materialsUploading'), txt = $('materialsUploadingText');
  err.style.display = 'none'; upl.style.display = 'block'; txt.textContent = `Analyzing ${files.length} document(s)…`;
  const form = new FormData(); form.append('profileId', state.profileId); Array.from(files).slice(0, 6).forEach(f => form.append('files', f));
  try {
    const r = await fetch('/api/materials/upload', { method: 'POST', body: form });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed.');
    if (d.errors?.length) { err.style.display = 'block'; err.textContent = 'Some files failed: ' + d.errors.map(e => `${e.file}: ${e.error}`).join('; '); }
    await loadMaterials(); if (d.materials?.length) showToast(`Added ${d.materials.length} module(s)`);
  } catch (e) { err.style.display = 'block'; err.textContent = e.message; } finally { upl.style.display = 'none'; $('materialsInput').value = ''; }
}
function openModule(id){
  const m = state.materials.find(x => x.id === id); if (!m) return;
  cancelSpeech(); state.materialId = id; state.docId = null; state.docName = m.title; state.history = [];
  $('docName').textContent = m.title; $('docChars').textContent = `${m.subject} · ${m.topics.length} topics`;
  $('messages').innerHTML = '';
  appendMessage('tutor', `Hi ${state.profile?.name || 'there'}! Let's study **${m.title}**.\n\nWhat would you like to learn about?`, { skipSpeak: true });
  showView('chat'); setTimeout(() => $('input').focus(), 400);
}
function openFreeChat(){
  cancelSpeech(); state.materialId = null; state.docId = null; state.docName = 'Free chat'; state.history = [];
  $('docName').textContent = 'Free tutor chat'; $('docChars').textContent = 'Ask anything'; $('messages').innerHTML = '';
  appendMessage('tutor', `Hi ${state.profile?.name || 'there'}! What would you like to learn about today?`, { skipSpeak: true });
  showView('chat'); setTimeout(() => $('input').focus(), 400);
}
function appendMessage(role, content, opts = {}){
  const m = $('messages'); if (!m) return;
  const msg = document.createElement('div'); msg.className = 'msg ' + role;
  const av = document.createElement('div'); av.className = 'avatar ' + (role === 'user' ? 'user-av' : 'tutor'); av.textContent = role === 'user' ? 'Y' : '📚';
  const bub = document.createElement('div'); bub.className = 'bubble';
  if (role === 'tutor') bub.innerHTML = marked.parse(content || ''); else bub.textContent = content;
  msg.appendChild(av); msg.appendChild(bub); m.appendChild(msg); m.scrollTop = m.scrollHeight;
  if (role === 'tutor' && !opts.skipSpeak && state.ttsEnabled) speak(content, bub);
  return bub;
}
function appendTyping(){
  const m = $('messages'); if (!m) return;
  const msg = document.createElement('div'); msg.className = 'msg tutor'; msg.id = 'typingMsg';
  msg.innerHTML = `<div class="avatar tutor">📚</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  m.appendChild(msg); m.scrollTop = m.scrollHeight;
}
function removeTyping(){ const t = $('typingMsg'); if (t) t.remove(); }
function autoResize(){ const i = $('input'); if (!i) return; i.style.height = '52px'; i.style.height = Math.min(i.scrollHeight, 180) + 'px'; }
async function sendMessage(){
  if (state.sending) return; const text = $('input').value.trim(); if (!text) return;
  if (!state.materialId && !state.docId) { showToast('Open a module first.'); return; }
  cancelSpeech(); state.sending = true; $('sendBtn').disabled = true; $('input').disabled = true; $('input').value = ''; autoResize();
  appendMessage('user', text); appendTyping();
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: state.docId, materialId: state.materialId, message: text, history: state.history, profileId: state.profileId }) });
    const d = await r.json(); removeTyping();
    if (!r.ok) appendMessage('tutor', '⚠️ ' + (d.error || 'Something went wrong.'));
    else {
      appendMessage('tutor', d.reply || '');
      state.history.push({ role: 'user', content: text }); state.history.push({ role: 'assistant', content: d.reply || '' });
      if (d.decision?.announcement) showAnnouncementToast(d.decision.announcement);
      if (d.exercise) showAnnouncementToast('📝 New exercise ready: ' + d.exercise.title);
      await pollAnnouncements(); if (d.exercise) await refreshExBadge();
    }
  } catch (e) { removeTyping(); appendMessage('tutor', '⚠️ Could not reach the server.'); }
  finally { state.sending = false; $('sendBtn').disabled = false; $('input').disabled = false; $('input').focus(); refreshUsage(); }
}

// --- Polling & Banners ---
async function pollAnnouncements(){
  if (!state.profileId) return;
  try {
    const r = await fetch(`/api/teacher-state/${state.profileId}`); const d = await r.json();
    state.announcements = d.announcements || []; state.unreadAnnouncements = state.announcements.filter(a => !a.seen).length; renderAnnouncementsBanner();
    const banner = $('liveClassBanner');
    if (banner) {
      banner.style.display = 'none'; // Disable countdown banner
      if (false) { // Never auto-show
        $('liveClassMessage').textContent = '"' + d.pendingClassSuggestion.message + '"';
        $('liveClassTopic').textContent = d.pendingClassSuggestion.topic;
        $('liveClassCount').textContent = '1 Class Ready';
        
        if (window.liveClassTimerInterval) clearInterval(window.liveClassTimerInterval);
        const timerEl = $('liveClassTimer');
        const updateTimer = () => {
          const msLeft = d.pendingClassSuggestion.scheduledAt - Date.now();
          if (msLeft <= 0) { timerEl.textContent = 'Class has started!'; timerEl.style.color = 'var(--danger)'; return; }
          const mins = Math.floor(msLeft / 60000); const secs = Math.floor((msLeft % 60000) / 1000);
          timerEl.textContent = `Starts in ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        };
        updateTimer(); window.liveClassTimerInterval = setInterval(updateTimer, 1000); banner.style.display = 'flex';
      } else { banner.style.display = 'none'; if (window.liveClassTimerInterval) clearInterval(window.liveClassTimerInterval); }
    }
  } catch {}
}
function renderAnnouncementsBanner(){
  const container = $('announcementsBanner'); if (!container) return;
  const unread = state.announcements.filter(a => !a.seen).slice(-1)[0];
  if (!unread) { container.innerHTML = ''; return; }
  const t = new Date(unread.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  container.innerHTML = `<div class="announcements-banner"><div class="announcements-icon">📢</div><div class="announcements-body"><div class="ann-text">${escapeHtml(unread.text)}</div><div class="ann-time">${t}</div></div><button class="announcements-dismiss" id="dismissAnn">✕</button></div>`;
  $('dismissAnn').addEventListener('click', async () => { await fetch(`/api/announcements/${state.profileId}/seen`, { method: 'POST' }); await pollAnnouncements(); });
}
async function refreshExBadge(){
  if (!state.profileId) return;
  try {
    const r = await fetch(`/api/exercises/${state.profileId}`); const d = await r.json();
    const activeCount = (d.exercises || []).filter(e => e.status === 'active').length;
    if (activeCount > 0) { exBadge.textContent = activeCount; exBadge.style.display = 'inline-flex'; } else { exBadge.style.display = 'none'; }
  } catch {}
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  initTts();
  $('profileForm')?.addEventListener('submit', handleProfileSubmit);
  $('addSubjectBtn')?.addEventListener('click', addCustomSubject);
  $('customSubject')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustomSubject(); } });
  profileBtn?.addEventListener('click', () => { fillProfileForm(state.profile); showView('profile'); });
  
  // Info View Logic
  $('infoBtn')?.addEventListener('click', () => showView('info'));
  document.querySelectorAll('.info-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.info-tab').forEach(t => t.classList.remove('active')); e.target.classList.add('active');
      document.querySelectorAll('.info-section').forEach(sec => sec.classList.remove('active'));
      const targetId = 'sec-' + e.target.dataset.target; $(targetId)?.classList.add('active');
    });
  });

  $('addMaterialsBtn')?.addEventListener('click', () => $('materialsInput').click());
  $('materialsInput')?.addEventListener('change', e => uploadMaterials(e.target.files));
  $('freeChatBtn')?.addEventListener('click', openFreeChat);
  $('sendBtn')?.addEventListener('click', sendMessage);
  $('input')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  $('input')?.addEventListener('input', autoResize);
  $('newDocBtn')?.addEventListener('click', () => { cancelSpeech(); showView('upload'); });

  renderSubjectChips(); refreshUsage(); setInterval(refreshUsage, 60000);

  state.profile = await loadProfileFromServer();
  if (state.profile) {
    state.profileId = state.profile.id; fillProfileForm(state.profile); updateProfileButton();
    $('heroName').innerHTML = getGreeting() + ', <span class="accent">' + state.profile.name + '</span>';
    await loadMaterials(); 
    

    await pollAnnouncements(); await refreshExBadge();
    showView('upload');
    setInterval(async () => { await pollAnnouncements(); await refreshExBadge(); }, 45000);
  } else {
    showView('auth');
  }
});

// Placeholder functions for buttons that might be pressed before their scripts load
function generateTimetable(){ console.log('Timetable generation triggered'); }
function openVisionView(){ console.log('Vision triggered'); }
function loadExerciseList(){ console.log('Exercises triggered'); }

window.__appState = state;
window.showView = showView;
window.showToast = showToast;


// ============================================================
// AVATAR UPLOAD & LIVE CLASS MODAL (Appended)
// ============================================================

async function resizeImageToSquare(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(size / img.width, size / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
      canvas.toBlob(blob => resolve(blob), 'image/png', 0.9);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function uploadAvatar(file) {
  if (!state.profileId) { showToast('Save your profile first.'); return; }
  const wrap = document.getElementById('avatarProgressWrap');
  const fill = document.getElementById('avatarProgressFill');
  const txt = document.getElementById('avatarProgressText');
  const pickBtn = document.getElementById('avatarPickBtn');

  try {
    const blob = await resizeImageToSquare(file, 256);
    const form = new FormData();
    form.append('file', new File([blob], 'avatar.png', { type: 'image/png' }));

    if (wrap) {
      wrap.style.display = 'block';
      if(pickBtn) { pickBtn.disabled = true; pickBtn.textContent = 'Uploading...'; }
      fill.style.width = '0%'; txt.textContent = 'Uploading... 0%';
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/profile/${state.profileId}/avatar`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && wrap) {
        const pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = pct + '%'; txt.textContent = `Uploading... ${pct}%`;
      }
    };

    xhr.onload = async () => {
      if(pickBtn) { pickBtn.disabled = false; pickBtn.textContent = '📷 Upload picture'; }
      if (xhr.status === 200) {
        if (wrap) { fill.style.width = '100%'; txt.textContent = '✅ Complete!'; setTimeout(() => wrap.style.display = 'none', 2000); }
        showToast('Profile picture updated!');
        if (state.profile) state.profile.avatarUpdatedAt = new Date().toISOString();
        await refreshAvatarDisplay(true);
      } else {
        if (wrap) wrap.style.display = 'none';
        let errMsg = 'Upload failed'; try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch {}
        showToast(errMsg);
      }
    };

    xhr.onerror = () => {
      if(pickBtn) { pickBtn.disabled = false; pickBtn.textContent = '📷 Upload picture'; }
      if (wrap) wrap.style.display = 'none';
      showToast('Network error during upload.');
    };
    xhr.send(form);
  } catch (e) {
    if (wrap) wrap.style.display = 'none';
    if(pickBtn) { pickBtn.disabled = false; pickBtn.textContent = '📷 Upload picture'; }
    showToast(e.message);
  }
}

async function refreshAvatarDisplay(force = false) {
  if (!state.profileId) return;
  const version = (state.profile?.avatarUpdatedAt || 'none') + (force ? '&t=' + Date.now() : '');
  const url = `/api/profile/${state.profileId}/avatar?v=${version}`;
  const preview = document.getElementById('avatarPreview');
  const removeBtn = document.getElementById('avatarRemoveBtn');

  const img = new Image();
  img.onload = () => {
    if (profileBtn) {
      profileBtn.innerHTML = ''; profileBtn.style.backgroundImage = `url(${url})`;
      profileBtn.style.backgroundSize = 'cover'; profileBtn.style.backgroundPosition = 'center'; profileBtn.textContent = '';
    }
    if (preview) { preview.style.backgroundImage = `url(${url})`; preview.style.backgroundSize = 'cover'; preview.textContent = ''; }
    if (removeBtn) removeBtn.style.display = 'inline-flex';
    checkForceAvatarBanner();
  };
  img.onerror = () => {
    if (profileBtn) { profileBtn.style.backgroundImage = ''; profileBtn.textContent = (state.profile?.name || '?').charAt(0).toUpperCase(); }
    if (preview) { preview.style.backgroundImage = ''; preview.textContent = '👤'; }
    if (removeBtn) removeBtn.style.display = 'none';
    checkForceAvatarBanner();
  };
  img.src = url;
}

function checkForceAvatarBanner() {
  const banner = document.getElementById('forceAvatarBanner');
  if (!banner) return;
  if (state.profile && !state.profile.avatarUpdatedAt) {
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// Attach Avatar Listeners
document.addEventListener('DOMContentLoaded', () => {
  // Header Live Class button triggers the Language Modal
  const liveClassBtn = document.getElementById('liveClassBtn');
  if (liveClassBtn) {
    liveClassBtn.addEventListener('click', () => {
      const modal = document.getElementById('langModal');
      if (modal) modal.style.display = 'flex';
    });
  }

  document.getElementById('avatarPickBtn')?.addEventListener('click', () => document.getElementById('avatarInput').click());
  document.getElementById('avatarInput')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadAvatar(f);
    e.target.value = '';
  });
  setInterval(checkForceAvatarBanner, 3000); // Poll banner occasionally

  // LIVE CLASS MODAL LOGIC
  const oldBtn = document.getElementById('joinLiveClassBtn');
  if (oldBtn) {
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);
    
    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const modal = document.getElementById('langModal');
      if (modal) modal.style.display = 'flex';
    });
  }

  document.querySelectorAll('.lang-btn').forEach(btn => {
    const newLangBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newLangBtn, btn);
    newLangBtn.addEventListener('click', async (e) => {
      const lang = e.currentTarget.dataset.lang;
      window.classLang = lang;
      
      document.getElementById('langModal').style.display = 'none';
      document.getElementById('liveClassBanner').style.display = 'none';
      
      const profileId = localStorage.getItem('studyHelper.profileId');
      if (profileId) {
        try { await fetch('/api/classroom/dismiss-suggestion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId }) }); } catch {}
      }
      
      if (typeof window.__classroomStart === 'function') window.__classroomStart();
      else { showToast('Error loading classroom. Refreshing...'); setTimeout(() => location.reload(), 1000); }
    });
  });
});
