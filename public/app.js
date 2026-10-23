/* ============================================================
   Study Helper — frontend (Step 5c: with TTS)
   ============================================================ */

const $ = (id) => document.getElementById(id);
const PROFILE_ID_KEY = 'studyHelper.profileId';
const TTS_ENABLED_KEY = 'studyHelper.ttsEnabled';
const COMMON_SUBJECTS = ['Mathematics','English','Physics','Chemistry','Biology','History','Geography','Computer Science','Economics','Business Studies','Accounting','Literature','Art','Music'];
const SUBJECT_COLORS = ['#4f46e5','#0891b2','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'];


function getGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Burning the midnight oil';
}

function getSubjectColor(s){
  if (!s) return SUBJECT_COLORS[0];
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return SUBJECT_COLORS[Math.abs(h) % SUBJECT_COLORS.length];
}
function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// STATE
// ============================================================
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
  // TTS
  ttsEnabled: false,
  ttsVoice: null,
  ttsRate: 1.0,
  pollTimer: null
};

const views = {
  auth: $('authView'),
  profile: $('profileView'), upload: $('uploadView'), chat: $('chatView'),
  timetable: $('timetableView'), vision: $('visionView'),
  exercises: $('exercisesView'), takeExercise: $('takeExerciseView'),
  result: $('resultView'),
  info: $('infoView')
};

const toast = $('toast');
const toastAnn = $('toastAnnouncement');
const usageText = $('usageText'), usageDot = $('usageDot');
const profileBtn = $('profileBtn'), timetableBtn = $('timetableBtn');
const visionBtn = $('visionBtn'), exercisesBtn = $('exercisesBtn');
const exBadge = $('exBadge');
const ttsToggle = $('ttsToggle');

// ============================================================
// UTILITIES
// ============================================================
function showToast(msg){ toast.textContent = msg; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); }
function showAnnouncementToast(msg){
  toastAnn.textContent = msg;
  toastAnn.classList.add('show');
  setTimeout(() => toastAnn.classList.remove('show'), 5000);
}
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

// ============================================================
// TEXT-TO-SPEECH
// ============================================================
function stripMarkdownForSpeech(md){
  if (!md) return '';
  return md
    .replace(/```[\s\S]*?```/g, ' [code example] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickVoice(){
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;
  const preferred = [
    /Google UK English Female/i, /Google US English/i, /Google UK English Male/i,
    /Samantha/i, /Karen/i, /Daniel/i, /Moira/i,
    /Microsoft (Aria|Jenny|Guy|Zira|David|Hazel)/i,
    /en[-_]GB/i, /en[-_]US/i,
  ];
  for (const p of preferred) {
    const v = voices.find(v => p.test(v.name) || p.test(v.lang));
    if (v) return v;
  }
  return voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
}

function chunkText(text, maxLen = 220){
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0){
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf('. ', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('? ', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('! ', maxLen);
    if (cut < maxLen * 0.4) cut = remaining.lastIndexOf(', ', maxLen);
    if (cut < maxLen * 0.3) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < 0) cut = maxLen;
    else cut += 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks.filter(c => c.length > 0);
}

let speakQueue = [];

function cancelSpeech(){
  if (!('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); } catch {}
  speakQueue = [];
  document.querySelectorAll('.bubble.speaking').forEach(b => b.classList.remove('speaking'));
}

function speak(text, bubbleEl = null){
  if (!state.ttsEnabled) return;
  if (!('speechSynthesis' in window)) { showToast('Speech not supported in this browser'); return; }
  cancelSpeech();
  const clean = stripMarkdownForSpeech(text);
  if (!clean) return;
  const chunks = chunkText(clean, 220);
  if (bubbleEl) bubbleEl.classList.add('speaking');

  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    if (state.ttsVoice) u.voice = state.ttsVoice;
    u.rate = state.ttsRate || 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onend = () => {
      if (i === chunks.length - 1 && bubbleEl){
        bubbleEl.classList.remove('speaking');
      }
    };
    u.onerror = () => {
      if (bubbleEl) bubbleEl.classList.remove('speaking');
    };
    speakQueue.push(u);
    window.speechSynthesis.speak(u);
  });
}

function updateTtsToggleUI(){
  if (!ttsToggle) return;
  ttsToggle.textContent = state.ttsEnabled ? '🔊' : '🔇';
  ttsToggle.title = state.ttsEnabled ? 'Reading aloud is ON — click to mute' : 'Reading aloud is OFF — click to enable';
  ttsToggle.classList.toggle('off', !state.ttsEnabled);
}

function initTts(){
  // Load preference
  state.ttsEnabled = localStorage.getItem(TTS_ENABLED_KEY) === '1';
  updateTtsToggleUI();

  if (!('speechSynthesis' in window)) {
    ttsToggle.style.display = 'none';
    return;
  }

  // Load voices (may be async on some browsers)
  state.ttsVoice = pickVoice();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    state.ttsVoice = pickVoice();
  });

  ttsToggle.addEventListener('click', () => {
    state.ttsEnabled = !state.ttsEnabled;
    localStorage.setItem(TTS_ENABLED_KEY, state.ttsEnabled ? '1' : '0');
    updateTtsToggleUI();

    if (!state.ttsEnabled) {
      cancelSpeech();
      showToast('Reading aloud turned off');
    } else {
      // Warm up speech on iOS (gesture-triggered unlock)
      try {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch {}
      showToast('Reading aloud turned on');
    }
  });
}

// Add the small "reading…" indicator + replay button to a tutor bubble
function decorateTutorBubble(bubbleEl, text){
  // Replay button
  const replayBtn = document.createElement('button');
  replayBtn.className = 'bubble-replay';
  replayBtn.title = 'Read this response aloud';
  replayBtn.setAttribute('aria-label', 'Replay response aloud');
  replayBtn.textContent = '🔊';
  replayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.ttsEnabled) {
      // Auto-enable on explicit replay click
      state.ttsEnabled = true;
      localStorage.setItem(TTS_ENABLED_KEY, '1');
      updateTtsToggleUI();
    }
    speak(text, bubbleEl);
  });
  bubbleEl.appendChild(replayBtn);

  // Speaking indicator
  const indicator = document.createElement('div');
  indicator.className = 'speaking-indicator';
  indicator.innerHTML = `
    <span class="wave"><span></span><span></span><span></span><span></span></span>
    <span>Reading aloud…</span>
  `;
  bubbleEl.appendChild(indicator);
}

// ============================================================
// PROFILE
// ============================================================
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
    const b = document.createElement('button');
    b.type = 'button';
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
  state.selectedSubjects.add(v);
  i.value = ''; renderSubjectChips();
}
function updateProfileButton(){
  if (!state.profile) {
    profileBtn.classList.remove('visible');
    [timetableBtn, visionBtn, exercisesBtn].forEach(b => b.style.display = 'none');
    return;
  }
  profileBtn.textContent = (state.profile.name || '?').charAt(0).toUpperCase();
  profileBtn.title = `Edit profile (${state.profile.name})`;
  profileBtn.classList.add('visible');
  [timetableBtn, visionBtn, exercisesBtn].forEach(b => b.style.display = 'flex');
  setTimeout(() => refreshAvatarDisplay && refreshAvatarDisplay(), 30);
}
function fillProfileForm(p){
  if (!p) return;
  $('pName').value = p.name || ''; $('pAge').value = p.age || '';
  $('pLevel').value = p.level || ''; $('pGrade').value = p.grade || '';
  $('pSchool').value = p.school || ''; $('pGoal').value = p.goal || '';
  $('pExamDate').value = p.examDate || ''; $('pHours').value = p.hours || 10;
  $('pStyle').value = p.style || 'mixed'; $('pTime').value = p.time || 'evening';
  $('pNotes').value = p.notes || '';
  state.selectedSubjects = new Set(p.subjects || []);

  // --- Auth Logic ---
  $('tabLogin')?.addEventListener('click', () => {
    $('tabLogin').classList.add('active'); $('tabRegister').classList.remove('active');
    $('loginForm').style.display = 'block'; $('registerForm').style.display = 'none';
  });
  $('tabRegister')?.addEventListener('click', () => {
    $('tabRegister').classList.add('active'); $('tabLogin').classList.remove('active');
    $('registerForm').style.display = 'block'; $('loginForm').style.display = 'none';
  });

  $('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = $('loginUser').value.trim();
    const pass = $('loginPass').value;
    const err = $('loginError');
    err.style.display = 'none';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      
      localStorage.setItem('studyHelper.profileId', d.id);
      state.profile = d.profile;
      state.profileId = d.id;
      
      fillProfileForm(state.profile);
      updateProfileButton();
      $('heroName').innerHTML = getGreeting() + ', <span class="accent">' + state.profile.name + '</span>';
      
      showView('upload');
      await pollAnnouncements();
      await refreshExBadge();
      await refreshAvatarDisplay();
    } catch (e) {
      err.textContent = e.message; err.style.display = 'block';
    }
  });

  $('registerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const user = $('regUser').value.trim();
    const pass = $('regPass').value;
    if (pass.length < 4) { $('regError').textContent = 'Password must be at least 4 chars'; $('regError').style.display='block'; return; }
    
    $('regUserHidden').value = user;
    $('regPassHidden').value = pass;
    
    // Clear any old data in the profile form
    $('profileForm').reset();
    state.selectedSubjects.clear();
    renderSubjectChips();
    
    showView('profile');
  });

  $('backToAuthBtn')?.addEventListener('click', () => {
    showView('auth');
  });

  renderSubjectChips();

}
async function handleProfileSubmit(e){
  e.preventDefault();
  const subjects = Array.from(state.selectedSubjects);
  if (!subjects.length) { showToast('Pick at least one subject.'); return; }
  const p = {
    id: state.profile?.id,
    name: $('pName').value.trim(), age: Number($('pAge').value),
    level: $('pLevel').value, grade: $('pGrade').value.trim(),
    school: $('pSchool').value.trim(), subjects,
    goal: $('pGoal').value, examDate: $('pExamDate').value || '',
    hours: Number($('pHours').value), style: $('pStyle').value,
    time: $('pTime').value, notes: $('pNotes').value.trim()
  };
  if (!p.name || !p.age || !p.level || !p.grade) { showToast('Fill required fields.'); return; }
  const btn = e.target.querySelector('.btn-primary-large');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  const isRegister = !!$('regUserHidden').value;
  try {
    let saved;
    if (isRegister) {
      p.username = $('regUserHidden').value;
      p.password = $('regPassHidden').value;
      
      const r = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p)
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Registration failed');
      saved = d.profile;
      localStorage.setItem('studyHelper.profileId', d.id);
      $('regUserHidden').value = ''; // clear
      $('regPassHidden').value = '';
    } else {
      saved = await saveProfileToServer(p);
    }
    
    state.profile = saved; state.profileId = saved.id;
    updateProfileButton();
    $('heroName').innerHTML = getGreeting() + ', <span class="accent">' + saved.name + '</span>';
    showToast(`Welcome, ${saved.name}!`);
    await loadMaterials();
    setTimeout(checkForceAvatarBanner, 100);
    await pollAnnouncements();
    showView('upload');
  } catch (err) { showToast(err.message); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// ============================================================
// MATERIALS
// ============================================================
async function loadMaterials(){
  if (!state.profileId) return;
  try {
    const r = await fetch(`/api/materials/${state.profileId}`);
    const d = await r.json();
    state.materials = d.materials || [];
    renderMaterials();
  } catch (e) { console.error(e); }
}
function renderMaterials(){
  const grid = $('modulesGrid');
  if (!state.materials.length) {
    grid.innerHTML = `<div class="modules-empty">
      <div class="modules-empty-icon">📚</div>
      <h3>No modules yet</h3>
      <p>Upload up to 6 PDF or DOCX files. Each becomes a subject the tutor can teach you.</p>
      <button class="btn-primary-inline" onclick="document.getElementById('addMaterialsBtn').click()">📎 Add your first module</button>
    </div>`;
    return;
  }
  grid.innerHTML = state.materials.map(m => `
    <div class="module-card" data-id="${m.id}">
      <button class="module-delete" data-id="${m.id}" title="Remove">🗑</button>
      <div class="module-subject">${escapeHtml(m.subject)}</div>
      <h3>${escapeHtml(m.title)}</h3>
      <div class="module-topics">${m.topics.length} topic${m.topics.length === 1 ? '' : 's'}</div>
      <div class="module-size">${Math.round(m.textLength / 1000)}k chars</div>
    </div>`).join('');
  grid.querySelectorAll('.module-card').forEach(c => {
    c.addEventListener('click', e => { if (e.target.closest('.module-delete')) return; openModule(c.dataset.id); });
  });
  grid.querySelectorAll('.module-delete').forEach(b => {
    b.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Remove this module?')) return;
      await fetch(`/api/materials/${state.profileId}/${b.dataset.id}`, { method: 'DELETE' });
      await loadMaterials();
    });
  });
}
async function uploadMaterials(files){
  if (!files || !files.length) return;
  const err = $('materialsError'), upl = $('materialsUploading'), txt = $('materialsUploadingText');
  err.style.display = 'none'; upl.style.display = 'block';
  txt.textContent = `Analyzing ${files.length} document${files.length === 1 ? '' : 's'}…`;
  const form = new FormData();
  form.append('profileId', state.profileId);
  Array.from(files).slice(0, 6).forEach(f => form.append('files', f));
  try {
    const r = await fetch('/api/materials/upload', { method: 'POST', body: form });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed.');
    if (d.errors?.length) {
      err.style.display = 'block';
      err.textContent = 'Some files failed: ' + d.errors.map(e => `${e.file}: ${e.error}`).join('; ');
    }
    await loadMaterials();
    if (d.materials?.length) showToast(`Added ${d.materials.length} module${d.materials.length === 1 ? '' : 's'}`);
  } catch (e) {
    err.style.display = 'block'; err.textContent = e.message;
  } finally {
    upl.style.display = 'none'; $('materialsInput').value = '';
  }
}
function openModule(id){
  const m = state.materials.find(x => x.id === id);
  if (!m) return;
  cancelSpeech();
  state.materialId = id; state.docId = null; state.docName = m.title; state.history = [];
  $('docName').textContent = m.title;
  $('docChars').textContent = `${m.subject} · ${m.topics.length} topics`;
  $('messages').innerHTML = '';
  const name = state.profile?.name ? `**${state.profile.name}**` : 'there';
  const topics = m.topics.slice(0, 6).map(t => `• ${t.name}`).join('\n');
  appendMessage('tutor', `Hi ${name}! Let's study **${m.title}**.\n\n**Topics available:**\n${topics}\n\nWhat would you like to learn about?`, { skipSpeak: true });
  showView('chat');
  setTimeout(() => $('input').focus(), 400);
}
function openFreeChat(){
  cancelSpeech();
  state.materialId = null; state.docId = null; state.docName = 'Free chat'; state.history = [];
  $('docName').textContent = 'Free tutor chat';
  $('docChars').textContent = 'Ask anything';
  $('messages').innerHTML = '';
  appendMessage('tutor', `Hi ${state.profile?.name || 'there'}! What would you like to learn about today?`, { skipSpeak: true });
  showView('chat');
  setTimeout(() => $('input').focus(), 400);
}

// ============================================================
// CHAT
// ============================================================
function appendMessage(role, content, opts = {}){
  const m = $('messages');
  const msg = document.createElement('div');
  msg.className = 'msg ' + role;
  const av = document.createElement('div');
  av.className = 'avatar ' + (role === 'user' ? 'user-av' : 'tutor');
  av.textContent = role === 'user' ? 'You'.charAt(0) : '📚';
  const bub = document.createElement('div');
  bub.className = 'bubble';
  if (role === 'tutor') {
    bub.innerHTML = marked.parse(content || '');
    decorateTutorBubble(bub, content);
  } else {
    bub.textContent = content;
  }
  msg.appendChild(av); msg.appendChild(bub);
  m.appendChild(msg);
  m.scrollTop = m.scrollHeight;

  // Auto-speak tutor messages unless explicitly skipped
  if (role === 'tutor' && !opts.skipSpeak && state.ttsEnabled) {
    speak(content, bub);
  }
  return bub;
}
function appendTyping(){
  const m = $('messages');
  const msg = document.createElement('div');
  msg.className = 'msg tutor'; msg.id = 'typingMsg';
  msg.innerHTML = `<div class="avatar tutor">📚</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  m.appendChild(msg);
  m.scrollTop = m.scrollHeight;
}
function removeTyping(){ const t = $('typingMsg'); if (t) t.remove(); }
function autoResize(){
  const i = $('input');
  i.style.height = '52px';
  i.style.height = Math.min(i.scrollHeight, 180) + 'px';
}
async function sendMessage(){
  if (state.sending) return;
  const text = $('input').value.trim();
  if (!text) return;
  cancelSpeech();  // stop any ongoing speech before next turn
  state.sending = true;
  $('sendBtn').disabled = true; $('input').disabled = true;
  $('input').value = ''; autoResize();
  appendMessage('user', text); appendTyping();

  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docId: state.docId, materialId: state.materialId,
        message: text, history: state.history, profileId: state.profileId
      })
    });
    const d = await r.json();
    removeTyping();
    if (!r.ok) {
      appendMessage('tutor', '⚠️ ' + (d.error || 'Something went wrong.'));
    } else {
      appendMessage('tutor', d.reply || '');
      state.history.push({ role: 'user', content: text });
      state.history.push({ role: 'assistant', content: d.reply || '' });

      if (d.decision?.announcement) showAnnouncementToast(d.decision.announcement);
      await pollAnnouncements(); // Instantly check for live class suggestions
      if (d.exercise) showAnnouncementToast('📝 New exercise ready: ' + d.exercise.title);

      await pollAnnouncements();
      if (d.exercise) await refreshExBadge();
    }
  } catch (e) {
    removeTyping();
    appendMessage('tutor', '⚠️ Could not reach the server.');
  } finally {
    state.sending = false;
    $('sendBtn').disabled = false; $('input').disabled = false;
    $('input').focus(); refreshUsage();
  }
}

// ============================================================
// ANNOUNCEMENTS
// ============================================================
async function pollAnnouncements(){
  if (!state.profileId) return;
  try {
    const r = await fetch(`/api/teacher-state/${state.profileId}`);
    const d = await r.json();
    state.announcements = d.announcements || [];
    state.unreadAnnouncements = state.announcements.filter(a => !a.seen).length;
    renderAnnouncementsBanner();
    
    // Handle Live Class Suggestion
    const banner = document.getElementById('liveClassBanner');
    if (banner) {
      if (d.pendingClassSuggestion) {
        document.getElementById('liveClassMessage').textContent = '"' + d.pendingClassSuggestion.message + '"';
        document.getElementById('liveClassTopic').textContent = d.pendingClassSuggestion.topic;
        document.getElementById('liveClassCount').textContent = '1 Class Ready';
        
        // Start the countdown
        if (window.liveClassTimerInterval) clearInterval(window.liveClassTimerInterval);
        const timerEl = document.getElementById('liveClassTimer');
        const btn = document.getElementById('joinLiveClassBtn');
        
        const updateTimer = () => {
          const msLeft = d.pendingClassSuggestion.scheduledAt - Date.now();
          if (msLeft <= 0) {
            timerEl.textContent = 'Class has started!';
            timerEl.style.color = 'var(--danger)';
            btn.textContent = 'Start Now →';
            btn.style.transform = 'scale(1.05)';
            return;
          }
          const mins = Math.floor(msLeft / 60000);
          const secs = Math.floor((msLeft % 60000) / 1000);
          timerEl.textContent = `Starts in ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        };
        
        updateTimer();
        window.liveClassTimerInterval = setInterval(updateTimer, 1000);
        banner.style.display = 'flex';
      } else {
        banner.style.display = 'none';
        if (window.liveClassTimerInterval) clearInterval(window.liveClassTimerInterval);
      }
    }
  } catch {}
}
function renderAnnouncementsBanner(){
  const container = $('announcementsBanner');
  if (!container) return;
  const unread = state.announcements.filter(a => !a.seen).slice(-1)[0];
  if (!unread) { container.innerHTML = ''; return; }
  const t = new Date(unread.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  container.innerHTML = `
    <div class="announcements-banner">
      <div class="announcements-icon">📢</div>
      <div class="announcements-body">
        <div class="ann-text">${escapeHtml(unread.text)}</div>
        <div class="ann-time">${t}</div>
      </div>
      <button class="announcements-dismiss" id="dismissAnn" title="Dismiss">✕</button>
    </div>`;
  $('dismissAnn').addEventListener('click', async () => {
    await fetch(`/api/announcements/${state.profileId}/seen`, { method: 'POST' });
    await pollAnnouncements();
  });
}
async function refreshExBadge(){
  if (!state.profileId) return;
  try {
    const r = await fetch(`/api/exercises/${state.profileId}`);
    const d = await r.json();
    const activeCount = (d.exercises || []).filter(e => e.status === 'active').length;
    if (activeCount > 0) {
      exBadge.textContent = activeCount;
      exBadge.style.display = 'inline-flex';
    } else {
      exBadge.style.display = 'none';
    }
  } catch {}
}

// ============================================================
// TIMETABLE
// ============================================================
async function loadTimetable(){
  if (!state.profileId) return null;
  try { const r = await fetch(`/api/timetable/${state.profileId}`); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}
function daysUntil(dateStr){
  if (!dateStr) return null;
  const t = new Date(dateStr + 'T00:00:00'), n = new Date(); n.setHours(0,0,0,0);
  return Math.round((t - n) / 86400000);
}
async function generateTimetable(){
  if (!state.profileId) return;
  state.timetableLoading = true;
  $('timetableLoading').classList.remove('hidden');
  $('timetableContent').innerHTML = '';
  $('regenerateTimetableBtn').disabled = true;
  try {
    const r = await fetch('/api/timetable', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: state.profileId })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed.');
    state.timetable = d.timetable;
    renderTimetable(d.timetable, d.generatedAt);
  } catch (e) {
    $('timetableContent').innerHTML = `<div class="error-box active">${escapeHtml(e.message)}</div>`;
  } finally {
    state.timetableLoading = false;
    $('timetableLoading').classList.add('hidden');
    $('regenerateTimetableBtn').disabled = false;
    refreshUsage();
  }
}
async function openTimetableView(force = false){
  showView('timetable');
  if (!state.profileId) { $('timetableContent').innerHTML = `<div class="error-box active">Complete your profile first.</div>`; return; }
  if (!force) {
    const e = state.timetable ? { timetable: state.timetable } : await loadTimetable();
    if (e?.timetable) { state.timetable = e.timetable; renderTimetable(e.timetable, e.generatedAt); return; }
  }
  await generateTimetable();
}
function renderTimetable(t, generatedAt){
  const totalHours = Number(t.totalHours) || 0;
  const sessions = (t.days || []).reduce((a, d) => a + (d.sessions?.length || 0), 0);
  const du = daysUntil(state.profile?.examDate);
  const gen = generatedAt ? new Date(generatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Just now';
  $('timetableSub').textContent = `${state.profile?.name || 'Your'} plan · ${gen}`;

  const summary = [
    `<div class="summary-card"><div class="summary-number">${totalHours}h</div><div class="summary-label">Total this week</div></div>`,
    `<div class="summary-card"><div class="summary-number">${sessions}</div><div class="summary-label">Sessions</div></div>`
  ];
  if (du !== null && du >= 0) summary.push(`<div class="summary-card ${du <= 14 ? 'urgent' : ''}"><div class="summary-number">${du}d</div><div class="summary-label">Until exam</div></div>`);

  const breakdown = (t.subjectBreakdown || []).map(s => {
    const pct = totalHours ? Math.round((s.hours / totalHours) * 100) : 0;
    const c = getSubjectColor(s.subject);
    return `<div class="breakdown-bar"><span class="breakdown-subject" style="color:${c}">${escapeHtml(s.subject)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${c};"></div></div><span class="breakdown-hours">${s.hours}h</span></div>`;
  }).join('');

  const daysHtml = (t.days || []).map(day => {
    const ds = day.sessions || [];
    const rest = ds.length === 0;
    const body = rest ? `<p class="rest-day">Rest day 🌿</p>`
      : ds.map(s => {
        const c = getSubjectColor(s.subject);
        return `<div class="session-pill" style="border-left-color:${c};">
          ${s.period ? `<div class="session-period">${escapeHtml(s.period)}</div>` : ''}
          <div class="session-subject" style="color:${c};">${escapeHtml(s.subject)}</div>
          <div class="session-topic">${escapeHtml(s.topic)}</div>
          ${s.subtopic ? `<div class="session-subtopic">↳ ${escapeHtml(s.subtopic)}</div>` : ''}
          <div class="session-meta">${s.durationMinutes} min · ${escapeHtml(s.timeOfDay)}</div>
        </div>`;
      }).join('');
    return `<div class="day-card ${rest ? 'empty' : ''}"><h3>${escapeHtml(day.day)}</h3>${body}</div>`;
  }).join('');

  $('timetableContent').innerHTML = `
    <div class="timetable-summary">${summary.join('')}</div>
    ${t.weekSummary ? `<div class="week-summary">💡 ${escapeHtml(t.weekSummary)}</div>` : ''}
    ${breakdown ? `<div class="subject-breakdown"><h3>Subject breakdown</h3>${breakdown}</div>` : ''}
    <div class="timetable-grid">${daysHtml}</div>`;
}

// ============================================================
// VISION
// ============================================================
async function loadVision(){
  if (!state.profileId) return null;
  try { const r = await fetch(`/api/vision/${state.profileId}`); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}
async function generateVision(){
  if (!state.profileId) return;
  state.visionLoading = true;
  $('visionLoading').classList.remove('hidden');
  $('visionContent').innerHTML = '';
  $('regenerateVisionBtn').disabled = true;
  try {
    const r = await fetch('/api/vision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: state.profileId })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed.');
    state.vision = d.vision;
    renderVision(d.vision, d.generatedAt);
  } catch (e) {
    $('visionContent').innerHTML = `<div class="error-box active">${escapeHtml(e.message)}</div>`;
  } finally {
    state.visionLoading = false;
    $('visionLoading').classList.add('hidden');
    $('regenerateVisionBtn').disabled = false;
    refreshUsage();
  }
}
async function openVisionView(force = false){
  showView('vision');
  if (!state.profileId) { $('visionContent').innerHTML = `<div class="error-box active">Complete your profile.</div>`; return; }
  if (!force) {
    const e = state.vision ? { vision: state.vision } : await loadVision();
    if (e?.vision) { state.vision = e.vision; renderVision(e.vision, e.generatedAt); return; }
  }
  await generateVision();
}
function renderVision(v, generatedAt){
  const gen = generatedAt ? new Date(generatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Just now';
  $('visionSub').textContent = `${state.profile?.name || 'Your'} projection · ${gen}`;
  const conf = (v.confidence || 'medium').toLowerCase();
  const meta = [`<span>🎯 Confidence: <span class="confidence-badge confidence-${conf}">${conf.charAt(0).toUpperCase() + conf.slice(1)}</span></span>`];
  if (v.daysUntilExam !== null && v.daysUntilExam !== undefined && v.daysUntilExam >= 0)
    meta.push(`<span>⏳ ${v.daysUntilExam} days to exam</span>`);
  const sc = (k, l, d) => d ? `<div class="scenario-card ${k}"><div class="scenario-label">${l}</div><div class="scenario-score">${escapeHtml(d.score || '—')}</div><div class="scenario-desc">${escapeHtml(d.description || '')}</div></div>` : '';
  const msHtml = (v.milestones || []).map(m => `<div class="milestone"><div class="milestone-period">${escapeHtml(m.period || '')}</div><div class="milestone-body"><div class="milestone-focus">${escapeHtml(m.focus || '')}</div><div class="milestone-target">${escapeHtml(m.target || '')}</div></div></div>`).join('');
  const riskHtml = (v.risks || []).map(r => `<div class="risk-item"><div class="risk-name">⚠️ ${escapeHtml(r.risk || '')}</div><div class="risk-mitigation">✅ ${escapeHtml(r.mitigation || '')}</div></div>`).join('');
  const focus = v.todayFocus ? `<div class="todays-focus"><div class="todays-focus-label">🎯 Today's focus</div><div class="todays-focus-subject">${escapeHtml(v.todayFocus.subject || '')}</div><div class="todays-focus-action">${escapeHtml(v.todayFocus.action || '')}</div></div>` : '';
  $('visionContent').innerHTML = `
    <div class="vision-hero"><div class="vision-headline">${escapeHtml(v.headline || 'Your vision')}</div><div class="vision-meta">${meta.join('')}</div></div>
    ${focus}
    <div class="vision-section-title">📊 Possible outcomes</div>
    <div class="scenarios-grid">${sc('best', 'Best case', v.bestCase)}${sc('likely', 'Likely case', v.likelyCase)}${sc('worst', 'Worst case', v.worstCase)}</div>
    ${msHtml ? `<div class="milestones"><div class="vision-section-title">🗺️ Milestones</div><div class="milestone-list">${msHtml}</div></div>` : ''}
    ${riskHtml ? `<div class="risks"><div class="vision-section-title">⚠️ Risks</div><div class="risk-list">${riskHtml}</div></div>` : ''}`;
}

// ============================================================
// EXERCISES
// ============================================================
const TYPE_LABELS = { quiz: 'Quiz', short_answer: 'Short answer', research: 'Research', mixed: 'Mixed' };

function formatMsLeft(ms){
  if (ms <= 0) return 'Overdue';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m left`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h left`;
}

async function loadExerciseList(){
  const c = $('exercisesContent');
  c.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">Loading…</div>';
  try {
    const r = await fetch(`/api/exercises/${state.profileId}`);
    const d = await r.json();
    state.exercises = d.exercises || [];
    renderExerciseList();
    await refreshExBadge();
  } catch (e) {
    c.innerHTML = `<div class="error-box active">${escapeHtml(e.message)}</div>`;
  }
}
function renderExerciseList(){
  const c = $('exercisesContent');
  const list = state.exercises;
  $('exercisesSub').textContent = list.length
    ? `${list.length} exercise${list.length === 1 ? '' : 's'} · your teacher assigns as you learn`
    : 'Your teacher assigns exercises as you learn.';

  if (!list.length) {
    c.innerHTML = `<div class="exercises-grid"><div class="ex-empty">
      <span class="ex-empty-icon">🎓</span>
      <h3>No exercises yet</h3>
      <p>Start a lesson in the chat — your teacher will assign a personalised exercise when the time is right.</p>
    </div></div>`;
    return;
  }

  c.innerHTML = `<div class="exercises-grid">${list.map(ex => {
    const statusBadge = {
      active: '<span class="ex-status active">● Active</span>',
      submitted: `<span class="ex-status submitted">✓ Best: ${ex.bestScore}%</span>`,
      overdue: '<span class="ex-status overdue">⏰ Overdue</span>'
    }[ex.status] || '';
    const deadline = ex.status === 'active' && ex.msLeft !== null
      ? `<span class="ex-deadline ${ex.msLeft < 5 * 60000 ? 'urgent' : ''}">⏳ ${formatMsLeft(ex.msLeft)}</span>`
      : '';
    const durationTag = ex.durationLabel
      ? `<span class="ex-duration-tag">${ex.durationLabel}</span>`
      : '';
    return `<div class="ex-card" data-id="${ex.id}">
      <div class="ex-card-top">
        <span class="ex-badge ${ex.type}">${TYPE_LABELS[ex.type] || ex.type}</span>
        <span class="ex-diff ${ex.difficulty}">${ex.difficulty}</span>
      </div>
      <h3>${escapeHtml(ex.title)}</h3>
      <div class="ex-card-meta">${escapeHtml(ex.subject)} · ${ex.questionCount} Q · ${ex.totalPoints} pts</div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;margin-top:0.2rem;">
        ${statusBadge}${deadline}${durationTag}
      </div>
      <div class="ex-card-score">
        <span style="color:var(--muted);font-size:0.8rem;">${ex.assignedByAI ? '🤖 Assigned by teacher' : ''}</span>
        <span style="color:var(--muted);font-size:0.8rem;">${ex.attemptCount} attempt${ex.attemptCount === 1 ? '' : 's'}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
  c.querySelectorAll('.ex-card').forEach(card => card.addEventListener('click', () => openExercise(card.dataset.id)));
}

async function openExercise(id){
  try {
    const r = await fetch(`/api/exercise/${id}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    state.current = d.exercise;
    state.answers = {}; state.mode = 'type'; state.answerFile = null;
    renderExerciseTake();
    showView('takeExercise');
  } catch (e) { showToast(e.message); }
}
function renderExerciseTake(){
  const ex = state.current;
  $('takeExerciseTitle').textContent = ex.title;
  $('takeExerciseInstructions').textContent = ex.instructions || '';
  $('takeExerciseMeta').innerHTML = `<span>${escapeHtml(ex.subject)}</span><span>${TYPE_LABELS[ex.type]}</span><span>${ex.difficulty}</span><span>${ex.questions.length} Q · ${ex.totalPoints} pts</span>`;

  const dl = $('exerciseDeadline');
  if (ex.dueAt) {
    const ms = new Date(ex.dueAt).getTime() - Date.now();
    dl.style.display = 'block';
    dl.className = 'exercise-deadline';
    if (ms <= 0) { dl.classList.add('overdue'); dl.textContent = '⏰ This exercise is overdue — you can still submit for practice.'; }
    else if (ms < 5 * 60000) { dl.classList.add('urgent'); dl.textContent = `🔥 ${formatMsLeft(ms)} — submit soon!`; }
    else { dl.textContent = `⏳ ${formatMsLeft(ms)} to complete (${ex.durationLabel || 'custom'} duration)`; }
  } else {
    dl.style.display = 'none';
  }

  setAnswerMode('type');
  renderQuestions();
  updateSubmitBar();
}
function setAnswerMode(m){
  state.mode = m;
  $('tabTypeBtn').classList.toggle('active', m === 'type');
  $('tabUploadBtn').classList.toggle('active', m === 'upload');
  $('typeAnswerMode').style.display = m === 'type' ? 'block' : 'none';
  $('uploadAnswerMode').style.display = m === 'upload' ? 'block' : 'none';
}
function renderQuestions(){
  const ex = state.current;
  $('questionsList').innerHTML = ex.questions.map((q, i) => {
    let body;
    if (q.type === 'multiple_choice' && Array.isArray(q.options)) {
      body = `<div class="q-options">${q.options.map((opt, oi) =>
        `<label class="q-option" data-qid="${q.id}" data-val="${oi}"><input type="radio" name="q_${q.id}" value="${oi}"><span><strong>${String.fromCharCode(65+oi)}.</strong> ${escapeHtml(opt)}</span></label>`
      ).join('')}</div>`;
    } else {
      const tall = (q.type === 'essay' || q.type === 'research') ? 'q-tall' : '';
      body = `<textarea class="q-textarea ${tall}" data-qid="${q.id}" placeholder="Your answer…"></textarea>`;
    }
    return `<div class="q-card"><div class="q-head"><span class="q-number">Q${i+1}</span><span class="q-points">(${q.points} pt${q.points === 1 ? '' : 's'})</span></div><div class="q-text">${escapeHtml(q.question)}</div>${body}</div>`;
  }).join('');
  document.querySelectorAll('#questionsList .q-option').forEach(opt => {
    opt.addEventListener('click', e => {
      e.preventDefault();
      opt.parentElement.querySelectorAll('.q-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      opt.querySelector('input').checked = true;
      state.answers[opt.dataset.qid] = Number(opt.dataset.val);
      updateSubmitBar();
    });
  });
  document.querySelectorAll('#questionsList .q-textarea').forEach(ta => {
    ta.addEventListener('input', () => { state.answers[ta.dataset.qid] = ta.value; updateSubmitBar(); });
  });
}
function updateSubmitBar(){
  const btn = $('submitExerciseBtn');
  if (state.mode === 'upload') btn.disabled = !state.answerFile || state.submitting;
  else {
    const answered = state.current.questions.filter(q => {
      const a = state.answers[q.id];
      return a !== undefined && a !== '' && a !== null;
    }).length;
    btn.disabled = answered === 0 || state.submitting;
  }
}
async function submitExercise(){
  if (state.submitting) return;
  const ex = state.current;
  const errBox = $('takeExerciseError');
  errBox.classList.remove('active');
  state.submitting = true;
  const btn = $('submitExerciseBtn');
  const orig = btn.textContent; btn.textContent = 'Grading…'; btn.disabled = true;
  try {
    let d;
    if (state.mode === 'upload') {
      if (!state.answerFile) throw new Error('Select a file.');
      const form = new FormData();
      form.append('exerciseId', ex.id);
      form.append('file', state.answerFile);
      const r = await fetch('/api/exercise/submit-file', { method: 'POST', body: form });
      d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed.');
    } else {
      const r = await fetch('/api/exercise/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exerciseId: ex.id, answers: state.answers })
      });
      d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed.');
    }
    renderResult(d.submission);
    showView('result');
    refreshUsage();
  } catch (e) {
    errBox.textContent = e.message; errBox.classList.add('active');
  } finally {
    state.submitting = false; btn.textContent = orig; updateSubmitBar();
  }
}
function renderResult(sub){
  const g = sub.grading || {};
  const pct = Number(g.percentage) || 0;
  const cls = pct >= 80 ? '' : pct >= 50 ? 'mid' : 'low';
  $('resultHero').className = 'result-hero ' + cls;
  $('resultHero').innerHTML = `<div class="result-score-circle"><div class="result-score-number">${pct}%</div><div class="result-score-max">${g.totalScore ?? '?'} / 100</div></div><div class="result-grade">${escapeHtml(g.letterGrade || '—')}</div><div class="result-feedback">${escapeHtml(g.overallFeedback || '')}</div>`;
  const qResults = Array.isArray(g.questionResults) ? g.questionResults : [];
  const ex = state.current;
  const qMap = ex ? Object.fromEntries(ex.questions.map(q => [q.id, q])) : {};
  const qHtml = qResults.map(qr => {
    const q = qMap[qr.questionId];
    const idx = q ? ex.questions.indexOf(q) + 1 : '?';
    const ratio = qr.maxScore ? qr.score / qr.maxScore : 0;
    const c = ratio >= 0.95 ? 'full' : ratio > 0 ? 'partial' : 'zero';
    return `<div class="q-result"><div class="q-result-head"><span class="q-result-id">Q${idx}</span><span class="q-result-score ${c}">${qr.score} / ${qr.maxScore}</span></div><div class="q-result-feedback">${escapeHtml(qr.feedback || '')}</div></div>`;
  }).join('');
  const strengths = Array.isArray(g.strengths) ? g.strengths : [];
  const improvements = Array.isArray(g.improvements) ? g.improvements : [];
  $('resultContent').innerHTML = `
    ${qHtml ? `<div class="result-section"><div class="result-section-title">📋 Breakdown</div>${qHtml}</div>` : ''}
    ${(strengths.length || improvements.length) ? `<div class="result-section"><div class="result-section-title">🔎 Summary</div><div class="strengths-improvements"><div><div style="font-size:0.78rem;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:0.5rem;">Strengths</div><ul class="si-list strengths">${strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('') || '<li style="color:var(--muted);">—</li>'}</ul></div><div><div style="font-size:0.78rem;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:0.5rem;">Improvements</div><ul class="si-list improvements">${improvements.map(s => `<li>${escapeHtml(s)}</li>`).join('') || '<li style="color:var(--muted);">—</li>'}</ul></div></div></div>` : ''}`;
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTts();

  $('profileForm').addEventListener('submit', handleProfileSubmit);
  $('addSubjectBtn').addEventListener('click', addCustomSubject);
  $('customSubject').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustomSubject(); } });
  profileBtn.addEventListener('click', () => { fillProfileForm(state.profile); showView('profile'); });
  timetableBtn.addEventListener('click', () => openTimetableView(false));
  visionBtn.addEventListener('click', () => openVisionView(false));
  exercisesBtn.addEventListener('click', async () => { showView('exercises'); await pollAnnouncements(); await loadExerciseList(); });
  $('regenerateTimetableBtn').addEventListener('click', () => openTimetableView(true));
  $('regenerateVisionBtn').addEventListener('click', () => openVisionView(true));

  $('addMaterialsBtn').addEventListener('click', () => $('materialsInput').click());
  $('materialsInput').addEventListener('change', e => uploadMaterials(e.target.files));
  $('freeChatBtn').addEventListener('click', openFreeChat);

  $('sendBtn').addEventListener('click', sendMessage);
  $('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  $('input').addEventListener('input', autoResize);
  $('newDocBtn').addEventListener('click', () => { cancelSpeech(); showView('upload'); });

  $('takeBackBtn').addEventListener('click', () => { showView('exercises'); loadExerciseList(); });
  $('tabTypeBtn').addEventListener('click', () => { setAnswerMode('type'); updateSubmitBar(); });
  $('tabUploadBtn').addEventListener('click', () => { setAnswerMode('upload'); updateSubmitBar(); });
  $('answerSheetPickBtn').addEventListener('click', () => $('answerSheetInput').click());
  $('answerSheetInput').addEventListener('change', e => {
    state.answerFile = e.target.files[0] || null;
    $('answerSheetFileName').textContent = state.answerFile ? state.answerFile.name : 'No file selected';
    updateSubmitBar();
  });
  $('submitExerciseBtn').addEventListener('click', submitExercise);
  $('resultBackBtn').addEventListener('click', () => { showView('exercises'); loadExerciseList(); });

  renderSubjectChips();
  refreshUsage();
  setInterval(refreshUsage, 60000);

  state.profile = await loadProfileFromServer();
  if (state.profile) {
    state.profileId = state.profile.id;
    fillProfileForm(state.profile);
    updateProfileButton();
    $('heroName').innerHTML = getGreeting() + ', <span class="accent">' + state.profile.name + '</span>';
    await loadMaterials();
    
    // Ask AI to auto-schedule a class if none exists
    try {
      const sched = await fetch('/api/classroom/auto-schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: state.profileId })
      });
      const schedData = await sched.json();
      if (schedData.suggestion) {
        // Poll will pick up the banner visually
      }
    } catch (e) { console.error('Auto-schedule error', e); }

    await pollAnnouncements();
    await refreshExBadge();
    showView('upload');
    state.pollTimer = setInterval(async () => {
      await pollAnnouncements();
      await refreshExBadge();
    }, 45000);
  } else {
    showView('auth');
  }
});

// Stop speech when tab is hidden or page is closed
window.addEventListener('visibilitychange', () => {
  if (document.hidden && state.ttsEnabled) cancelSpeech();
});
window.addEventListener('beforeunload', () => {
  if ('speechSynthesis' in window) try { window.speechSynthesis.cancel(); } catch {}
});

window.__appState = state;

/* ============================================================
   Classroom hooks (appended)
   ============================================================ */
window.__classroom = {
  ttsEnabled: () => state.ttsEnabled,
  cancelSpeech,
  profileId: () => state.profileId,
  profile: () => state.profile,
  materials: () => state.materials,
  showToast,
  showView,
  refreshExBadge,
  loadExerciseList
};

/* Show / hide the "Live Class" button whenever profile state changes.
   app.js's own updateProfileButton doesn't know about this button yet, so
   we poll for the profile a few times after load — enough to catch the
   async profile fetch. */
(function () {
  function sync() {
    const btn = document.getElementById('liveClassBtn');
    if (!btn) return;
    btn.style.display = (window.__appState && window.__appState.profile) ? 'flex' : 'none';
  }
  document.addEventListener('DOMContentLoaded', sync);
  let tries = 0;
  const t = setInterval(() => { sync(); if (++tries > 40) clearInterval(t); }, 200);
})();

/* ============================================================
   AVATAR (appended)
   ============================================================ */

async function resizeImageToSquare(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(size / img.width, size / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
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

  const wrap = $('avatarProgressWrap');
  const fill = $('avatarProgressFill');
  const txt = $('avatarProgressText');
  const pickBtn = $('avatarPickBtn');

  try {
    const blob = await resizeImageToSquare(file, 256);
    const form = new FormData();
    form.append('file', new File([blob], 'avatar.png', { type: 'image/png' }));

    if (wrap) {
      wrap.style.display = 'block';
      pickBtn.disabled = true;
      pickBtn.textContent = 'Uploading...';
      fill.style.width = '0%';
      txt.textContent = 'Uploading to GitHub... 0%';
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/profile/${state.profileId}/avatar`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && wrap) {
        const pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = pct + '%';
        txt.textContent = `Uploading to GitHub... ${pct}%`;
      }
    };

    xhr.onload = async () => {
      if (pickBtn) {
        pickBtn.disabled = false;
        pickBtn.textContent = '📷 Upload picture';
      }
      
      if (xhr.status === 200) {
        if (wrap) {
          fill.style.width = '100%';
          txt.textContent = '✅ Complete!';
          setTimeout(() => { wrap.style.display = 'none'; }, 2000);
        }
        showToast('Profile picture updated!');
        
        if (state.profile) state.profile.avatarUpdatedAt = new Date().toISOString();
        await refreshAvatarDisplay(true);
        checkForceAvatarBanner();
      } else {
        if (wrap) wrap.style.display = 'none';
        let errMsg = 'Upload failed';
        try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch {}
        showToast(errMsg);
      }
    };

    xhr.onerror = () => {
      if (pickBtn) { pickBtn.disabled = false; pickBtn.textContent = '📷 Upload picture'; }
      if (wrap) wrap.style.display = 'none';
      showToast('Network error during upload.');
    };

    xhr.send(form);

  } catch (e) {
    if (wrap) wrap.style.display = 'none';
    if (pickBtn) { pickBtn.disabled = false; pickBtn.textContent = '📷 Upload picture'; }
    showToast(e.message);
  }
}

async function removeAvatar() {
  if (!state.profileId) return;
  if (!confirm('Remove your profile picture?')) return;
  try {
    const r = await fetch(`/api/profile/${state.profileId}/avatar`, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed');
    if (state.profile) delete state.profile.avatarUpdatedAt;
    await refreshAvatarDisplay(true);
    checkForceAvatarBanner();
    showToast('Picture removed');
  } catch (e) { showToast(e.message); }
}

async function refreshAvatarDisplay(force = false) {
  if (!state.profileId) return;
  const version = (state.profile?.avatarUpdatedAt || 'none') + (force ? '&t=' + Date.now() : '');
  const url = `/api/profile/${state.profileId}/avatar?v=${version}`;
  const preview = $('avatarPreview');
  const removeBtn = $('avatarRemoveBtn');

  const img = new Image();
  img.onload = () => {
    profileBtn.innerHTML = '';
    profileBtn.style.backgroundImage = `url(${url})`;
    profileBtn.style.backgroundSize = 'cover';
    profileBtn.style.backgroundPosition = 'center';
    profileBtn.textContent = '';
    if (preview) {
      preview.style.backgroundImage = `url(${url})`;
      preview.style.backgroundSize = 'cover';
      preview.style.backgroundPosition = 'center';
      preview.textContent = '';
    }
    if (removeBtn) removeBtn.style.display = 'inline-flex';
    checkForceAvatarBanner();
  };
  img.onerror = () => {
    profileBtn.style.backgroundImage = '';
    profileBtn.textContent = (state.profile?.name || '?').charAt(0).toUpperCase();
    if (preview) {
      preview.style.backgroundImage = '';
      preview.textContent = '👤';
    }
    if (removeBtn) removeBtn.style.display = 'none';
    checkForceAvatarBanner();
  };
  img.src = url;
}

function checkForceAvatarBanner() {
  const banner = $('forceAvatarBanner');
  if (!banner) return;
  if (state.profile && !state.profile.avatarUpdatedAt) {
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // --- Info View Logic ---
  document.getElementById('infoBtn')?.addEventListener('click', () => {
    showView('info');
  });

  document.querySelectorAll('.info-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      // Update tab styles
      document.querySelectorAll('.info-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      
      // Update content sections
      document.querySelectorAll('.info-section').forEach(sec => sec.classList.remove('active'));
      const targetId = 'sec-' + e.target.dataset.target;
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  $('avatarPickBtn')?.addEventListener('click', () => $('avatarInput').click());
  $('avatarInput')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadAvatar(f);
    e.target.value = '';
  });
  $('avatarRemoveBtn')?.addEventListener('click', removeAvatar);
  
  // Poll for profile state to show the banner if needed
  setInterval(checkForceAvatarBanner, 2000);
});


// ============================================================
// FOOLPROOF LIVE CLASS BUTTON BINDING (Appended)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // We use a small delay to ensure all scripts are fully loaded
  setTimeout(() => {
    const oldBtn = document.getElementById('joinLiveClassBtn');
    if (oldBtn) {
      // Clone the button to remove ALL previous (possibly broken) listeners
      const newBtn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(newBtn, oldBtn);

      newBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        newBtn.textContent = 'Loading...';
        
        // 1. Clear the suggestion on the server
        const profileId = localStorage.getItem('studyHelper.profileId');
        if (profileId) {
          try {
            await fetch('/api/classroom/dismiss-suggestion', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profileId })
            });
          } catch (err) {}
        }
        
        // 2. Hide the banner
        const banner = document.getElementById('liveClassBanner');
        if (banner) banner.style.display = 'none';
        newBtn.textContent = 'Join Class';
        
        // 3. Start the class
        if (typeof window.__classroomStart === 'function') {
          window.__classroomStart();
        } else {
          console.error('Classroom module not found on window');
          alert('Classroom is still loading. Please wait a second and try again.');
        }
      });
    }
  }, 1000); // 1 second delay ensures classroom.js is ready
});


// ============================================================
// BULLETPROOF LANGUAGE MODAL BINDING (Appended)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const oldBtn = document.getElementById('joinLiveClassBtn');
    if (oldBtn) {
      // Clone to remove ALL old listeners
      const newBtn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(newBtn, oldBtn);

      newBtn.addEventListener('click', (e) => {
        e.preventDefault();
        // Show the modal instead of starting the class
        const modal = document.getElementById('langModal');
        if (modal) modal.style.display = 'flex';
      });
    }

    // Handle the language selection buttons inside the modal
    document.querySelectorAll('.lang-btn').forEach(btn => {
      const newLangBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newLangBtn, btn);

      newLangBtn.addEventListener('click', async (e) => {
        const lang = e.currentTarget.dataset.lang;
        window.classLang = lang; // Set the language globally
        
        // Hide modal and banner
        const modal = document.getElementById('langModal');
        if (modal) modal.style.display = 'none';
        const banner = document.getElementById('liveClassBanner');
        if (banner) banner.style.display = 'none';
        
        // Dismiss the suggestion on the server
        const profileId = localStorage.getItem('studyHelper.profileId');
        if (profileId) {
          try {
            await fetch('/api/classroom/dismiss-suggestion', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profileId })
            });
          } catch (err) {}
        }
        
        // Start the class
        if (typeof window.__classroomStart === 'function') {
          window.__classroomStart();
        } else {
          console.error('Classroom not loaded!');
          location.reload();
        }
      });
    });
  }, 1500); // 1.5s delay ensures the page and buttons are fully loaded
});
