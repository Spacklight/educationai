/* ============================================================
   classroom.js — Clean Rebuild (Bulletproof)
   ============================================================ */

(function () {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const cs = {
    session: null, playing: false, paused: false,
    speaking: false, fetching: false, currentSegIndex: -1
  };

  function hooks() { return window.__classroom || {}; }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function showClassroomView() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('classroomView').classList.add('active');
    window.scrollTo(0, 0);
  }

  function buildBoardLayout(layout) {
    const board = $('chalkContent');
    board.innerHTML = '';
    const n = layout === 'three' ? 3 : layout === 'two' ? 2 : 1;
    board.className = 'chalk-content layout-' + layout;
    for (let i = 1; i <= n; i++) {
      const col = document.createElement('div');
      col.className = 'chalk-section';
      col.dataset.section = String(i);
      col.innerHTML = `<div class="section-tab">${i}</div>`;
      board.appendChild(col);
    }
  }

  function getSectionEl(section) {
    return document.querySelector(`.chalk-section[data-section="${section}"]`) || document.querySelector('.chalk-section');
  }

  function updateHeader() {
    if (!cs.session) return;
    $('classroomSubject').textContent = cs.session.subject || 'Class';
    $('classroomTopic').textContent = cs.session.topic || '';
    const shown = Math.max(0, cs.currentSegIndex + 1);
    const total = cs.session.segments.length;
    $('classroomProgress').textContent = `${shown} / ${total}`;
  }

  function updateControls() {
    const btn = $('classPlayBtn');
    if (!btn) return;
    if (!cs.playing) btn.textContent = '▶ Start';
    else if (cs.paused) btn.textContent = '▶ Resume';
    else btn.textContent = '⏸ Pause';
  }

  // TTS
  function speakClassSpeech(text, onEnd) {
    if (!('speechSynthesis' in window)) return onEnd();
    try { window.speechSynthesis.cancel(); } catch {}
    const clean = String(text).replace(/[`*#_]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return onEnd();

    const u = new SpeechSynthesisUtterance(clean);
    const voices = window.speechSynthesis.getVoices();
    let pref = null;
    if (window.classLang === 'ny') {
      pref = voices.find(v => v.lang.includes('ny') || v.lang.includes('MW'));
      u.lang = 'ny-MW'; 
    }
    if (!pref) {
      pref = voices.find(v => /Google UK English Female|Google US English|Samantha|Karen/i.test(v.name)) || voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
    }
    if (pref) u.voice = pref;
    u.rate = 0.75; // Slow, deliberate teaching pace
    u.onend = onEnd;
    u.onerror = onEnd;
    window.speechSynthesis.speak(u);
  }

  function cancelClassSpeech() { try { window.speechSynthesis.cancel(); } catch {} }

  // Render Segment (Simplified for reliability)
  function renderSegment(seg, onComplete) {
    const sectionEl = getSectionEl(seg.section);
    if (!sectionEl) return onComplete();

    const container = document.createElement('div');
    container.className = 'chalk-segment kind-' + (seg.kind || 'point');
    sectionEl.appendChild(container);

    let delay = 0;
    seg.elements.forEach(el => {
      const node = document.createElement('div');
      node.className = 'chalk-el chalk-' + (el.type || 'text');
      
      if (el.type === 'draw' || el.type === 'diagram') {
        node.textContent = `[Drawing: ${el.shape || el.name || 'Visual'}]`;
        node.style.color = '#fbbf24';
      } else if (el.type === 'note') {
        node.textContent = `📝 ${el.text}`;
        node.style.color = '#a3e635';
      } else {
        node.textContent = el.text || '';
      }

      node.style.opacity = '0';
      node.style.animation = `chalk-appear 0.35s ease-out ${delay}ms forwards`;
      container.appendChild(node);
      delay += 300;
    });

    sectionEl.scrollTop = sectionEl.scrollHeight;
    setTimeout(onComplete, delay + 400);
  }

  async function playSegment(index) {
    if (!cs.session) return;
    
    // If we run out of segments, try to fetch more
    if (index >= cs.session.segments.length) {
      const ok = await fetchNextSegment();
      if (!ok) {
        if (cs.session.isComplete) finishClass();
        else { $('chalkStatus').textContent = 'Paused — click Skip to retry'; }
        return;
      }
    }

    const seg = cs.session.segments[index];
    if (!seg) return;

    cs.currentSegIndex = index;
    updateHeader();

    $('chalkKind').textContent = seg.kind || 'point';
    $('chalkStatus').textContent = 'Writing…';
    
    renderSegment(seg, () => {
      $('chalkStatus').textContent = 'Speaking…';
      cs.speaking = true;
      fetchNextSegment(); // Prefetch next segment

      speakClassSpeech(seg.speech, () => {
        cs.speaking = false;
        $('chalkStatus').textContent = '';
        if (cs.playing && !cs.paused) {
          if (seg.isFinal) finishClass();
          else setTimeout(() => playSegment(index + 1), 400);
        }
      });
    });
  }

  async function fetchNextSegment() {
    if (cs.fetching || !cs.session) return false;
    if (cs.session.segments.length > cs.currentSegIndex + 1) return true; // Already have it

    cs.fetching = true;
    try {
      const pid = hooks().profileId ? hooks().profileId() : null;
      const r = await fetch('/api/classroom/next', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: pid, language: window.classLang || 'en' })
      });
      const d = await r.json();
      if (d.segment) {
        cs.session.segments.push(d.segment);
        if (d.isFinal) {
          cs.session.segments[cs.session.segments.length - 1].isFinal = true;
          cs.session.isComplete = true;
        }
        return true;
      }
      return false;
    } catch (e) {
      return false;
    } finally {
      cs.fetching = false;
    }
  }

  function finishClass() {
    cs.playing = false; cs.paused = false; updateControls();
    $('classroomCompletePanel').style.display = 'flex';
    $('chalkStatus').textContent = 'Class complete ✓';
    $('classDoneTopic').textContent = cs.session?.topic || 'today\'s topic';
  }

  async function startClass() {
    showClassroomView();
    
    // Reset UI
    cs.session = null; cs.currentSegIndex = -1; cs.playing = false; cs.paused = false; cs.speaking = false;
    cancelClassSpeech();
    $('chalkContent').innerHTML = '';
    $('classroomCompletePanel').style.display = 'none';
    $('classroomIntroCard').style.display = 'none';
    $('classroomBoard').style.display = 'none';
    $('classroomControls').style.display = 'none';
    $('classroomLoading').style.display = 'flex'; // Show loading

    const pid = hooks().profileId ? hooks().profileId() : null;
    if (!pid) { alert('Please log in first.'); return; }
    
    try { const w = new SpeechSynthesisUtterance(''); w.volume = 0; window.speechSynthesis.speak(w); } catch {}

    let sessionData = null;

    try {
      // 10 second timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const r = await fetch('/api/classroom/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: pid, language: window.classLang || 'en' }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const d = await r.json();
      if (d.session && d.session.segments && d.session.segments.length) {
        sessionData = d.session;
      }
    } catch (e) {
      console.error('Fetch failed:', e);
    }

    // Fallback if server times out or errors
    if (!sessionData) {
      sessionData = {
        subject: 'General', topic: 'Welcome to Class', layout: 'single', isComplete: false,
        segments: [{ kind: 'title', section: 1, elements: [{ type: 'text', text: 'Welcome to class!' }], speech: 'Welcome. Let us begin.' }]
      };
    }

    cs.session = sessionData;
    
    // Hide loading, show board
    $('classroomLoading').style.display = 'none';
    $('classroomBoard').style.display = 'flex';
    buildBoardLayout(cs.session.layout || 'single');
    updateHeader();
    updateControls();

    // Show Intro Card
    const ttsOn = hooks().ttsEnabled ? hooks().ttsEnabled() : false;
    $('classroomIntroCard').innerHTML = `
      <div class="intro-icon">🎓</div>
      <h2>Today's class</h2>
      <h3>${esc(cs.session.subject)}</h3>
      <p class="intro-topic">${esc(cs.session.topic)}</p>
      ${!ttsOn ? `<p class="intro-warn">🔇 Reading aloud is off. Click 🔊 in the header to hear.</p>` : ''}
      <button class="btn-primary-inline" id="classBeginBtn">▶ Begin class</button>
    `;
    $('classroomIntroCard').style.display = 'flex';

    $('classBeginBtn').addEventListener('click', () => {
      try { const w = new SpeechSynthesisUtterance(''); w.volume = 0; window.speechSynthesis.speak(w); } catch {}
      $('classroomIntroCard').style.display = 'none';
      $('classroomControls').style.display = 'flex';
      cs.playing = true; cs.paused = false; updateControls();
      playSegment(0);
    });
  }

  function pauseResume() {
    if (!cs.session) return;
    if (!cs.playing) {
      cs.playing = true; cs.paused = false;
      if (cs.currentSegIndex < 0) playSegment(0);
      else if (!cs.speaking) playSegment(cs.currentSegIndex + 1);
      updateControls(); return;
    }
    if (cs.paused) {
      cs.paused = false; updateControls();
      if (!cs.speaking) playSegment(cs.currentSegIndex);
    } else {
      cs.paused = true; cancelClassSpeech(); updateControls();
    }
  }

  async function skipSegment() {
    if (!cs.session) return;
    cancelClassSpeech();
    const next = cs.currentSegIndex + 1;
    if (next < cs.session.segments.length) playSegment(next);
    else { const ok = await fetchNextSegment(); if (ok) playSegment(next); else if (cs.session.isComplete) finishClass(); }
  }

  function endClass() {
    cs.playing = false; cs.paused = false;
    cancelClassSpeech(); updateControls();
    if (hooks().showView) hooks().showView('upload');
  }

  // Export globally so app.js can call it
  window.__classroomStart = startClass;

  document.addEventListener('DOMContentLoaded', () => {
    $('classPlayBtn')?.addEventListener('click', pauseResume);
    $('classSkipBtn')?.addEventListener('click', skipSegment);
    $('classEndBtn')?.addEventListener('click', endClass);
    $('classPracticeBtn')?.addEventListener('click', () => {
      if (hooks().showView) hooks().showView('exercises');
    });
    $('classAnotherBtn')?.addEventListener('click', startClass);
  });
})();
