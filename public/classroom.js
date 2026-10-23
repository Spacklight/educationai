/* ============================================================
   classroom.js — Live classroom with free-form chalk drawing
   ============================================================ */

(function () {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  window.classLang = 'en';

  const cs = {
    session: null, playing: false, paused: false,
    speaking: false, fetching: false,
    chalkTimeouts: [], currentSegIndex: -1
  };

  function hooks() { return window.__classroom || {}; }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  const CHAR_DELAY = 38;
  const ELEMENT_GAP = 140;

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
    return document.querySelector(`.chalk-section[data-section="${section}"]`);
  }

  function updateHeader() {
    if (!cs.session) return;
    $('classroomSubject').textContent = cs.session.subject || 'Class';
    $('classroomTopic').textContent = cs.session.topic || '';
    const shown = Math.max(0, cs.currentSegIndex + 1);
    const total = cs.session.segments.length;
    $('classroomProgress').textContent = `${shown} / ${total}`;
  }

  function clearChalkTimeouts() {
    cs.chalkTimeouts.forEach(clearTimeout);
    cs.chalkTimeouts = [];
  }

  // ==================================================
  //  SVG BUILDING
  // ==================================================
  function svgEl(tag, attrs = {}) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function addText(parent, x, y, text, color = '#f5f5dc', size = 11, anchor = 'middle') {
    const t = svgEl('text', {
      x, y, fill: color, 'font-family': 'Kalam, cursive',
      'font-size': size, 'text-anchor': anchor, 'font-weight': '700'
    });
    t.textContent = text;
    parent.appendChild(t);
    return t;
  }

  function addArrowHead(parent, fromX, fromY, toX, toY, color = '#a3e635') {
    const ang = Math.atan2(toY - fromY, toX - fromX);
    const len = 10;
    const a = { x: toX - len * Math.cos(ang - Math.PI / 6), y: toY - len * Math.sin(ang - Math.PI / 6) };
    const b = { x: toX - len * Math.cos(ang + Math.PI / 6), y: toY - len * Math.sin(ang + Math.PI / 6) };
    const p = svgEl('path', {
      d: `M${a.x},${a.y} L${toX},${toY} L${b.x},${b.y}`,
      stroke: color, 'stroke-width': 2, fill: 'none',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    parent.appendChild(p);
  }

  function buildDrawing(el) {
    const svg = svgEl('svg', {
      viewBox: '0 0 300 200',
      class: 'chalk-drawing',
      preserveAspectRatio: 'xMidYMid meet'
    });

    const stroke = '#f5f5dc';
    const accent = '#a3e635';
    const yellow = '#fbbf24';

    switch (el.shape) {
      case 'ruler': {
        const min = el.min, max = el.max;
        const x0 = 20, x1 = 280, y = 100, span = x1 - x0;
        svg.appendChild(svgEl('rect', { x: x0, y: y - 15, width: span, height: 30, fill: 'rgba(255,255,255,0.1)', stroke: stroke, 'stroke-width': 1 }));
        for (let i = min; i <= max; i++) {
          const x = x0 + ((i - min) / (max - min)) * span;
          svg.appendChild(svgEl('line', { x1: x, y1: y - 15, x2: x, y2: y + (i % 5 === 0 ? 5 : -5), stroke: yellow, 'stroke-width': 1 }));
          if (i % 5 === 0) addText(svg, x, y + 18, String(i), yellow, 8);
        }
        break;
      }
      case 'protractor': {
        const cx = 150, cy = 140, r = 90;
        svg.appendChild(svgEl('path', { d: `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} Z`, fill: 'rgba(255,255,255,0.1)', stroke: stroke, 'stroke-width': 1 }));
        for (let a = 0; a <= 180; a += 10) {
          const rad = (a - 180) * Math.PI / 180;
          const x1 = cx + Math.cos(rad) * r, y1 = cy + Math.sin(rad) * r;
          const x2 = cx + Math.cos(rad) * (r - (a % 30 === 0 ? 10 : 5)), y2 = cy + Math.sin(rad) * (r - (a % 30 === 0 ? 10 : 5));
          svg.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: yellow, 'stroke-width': 1 }));
          if (a % 30 === 0) {
            const tx = cx + Math.cos(rad) * (r - 20), ty = cy + Math.sin(rad) * (r - 20) + 3;
            addText(svg, tx, ty, String(a), yellow, 8);
          }
        }
        // Draw the angle
        if (el.angle) {
          const rad = (el.angle - 180) * Math.PI / 180;
          const ex = cx + Math.cos(rad) * r, ey = cy + Math.sin(rad) * r;
          svg.appendChild(svgEl('line', { x1: cx, y1: cy, x2: ex, y2: ey, stroke: accent, 'stroke-width': 2 }));
          addText(svg, cx + 30, cy - 10, el.angle + '°', accent, 12);
        }
        break;
      }
      case 'line':
      case 'arrow': {
        const [x1, y1] = el.from, [x2, y2] = el.to;
        const lineAttrs = {
          x1, y1, x2, y2,
          stroke: el.shape === 'arrow' ? accent : stroke,
          'stroke-width': 2, 'stroke-linecap': 'round'
        };
        if (el.dashed) lineAttrs['stroke-dasharray'] = '5 5';
        svg.appendChild(svgEl('line', lineAttrs));
        if (el.shape === 'arrow') addArrowHead(svg, x1, y1, x2, y2, accent);
        if (el.label) addText(svg, (x1 + x2) / 2, (y1 + y2) / 2 - 8, el.label, accent, 11);
        break;
      }
      case 'circle': {
        svg.appendChild(svgEl('circle', {
          cx: el.cx, cy: el.cy, r: el.r,
          fill: el.fill ? 'rgba(251,191,36,0.15)' : 'none',
          stroke: yellow, 'stroke-width': 2
        }));
        if (el.label) addText(svg, el.cx, Number(el.cy) + 5, el.label, yellow, 13);
        break;
      }
      case 'ellipse': {
        svg.appendChild(svgEl('ellipse', {
          cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry,
          fill: 'none', stroke: yellow, 'stroke-width': 2
        }));
        if (el.label) addText(svg, el.cx, Number(el.cy) - Number(el.ry) - 6, el.label, yellow, 12);
        break;
      }
      case 'curve': {
        svg.appendChild(svgEl('path', {
          d: el.path, stroke: accent, 'stroke-width': 2,
          fill: 'none', 'stroke-linecap': 'round'
        }));
        if (el.label) addText(svg, 150, 190, el.label, accent, 12);
        break;
      }
      case 'polygon': {
        const pts = el.points.map(([x, y]) => `${x},${y}`).join(' ');
        svg.appendChild(svgEl('polygon', {
          points: pts, fill: 'none', stroke: yellow,
          'stroke-width': 2, 'stroke-linejoin': 'round'
        }));
        if (el.label) {
          const cx = el.points.reduce((a, [x]) => a + x, 0) / el.points.length;
          const cy = el.points.reduce((a, [, y]) => a + y, 0) / el.points.length;
          addText(svg, cx, cy + 4, el.label, yellow, 12);
        }
        break;
      }
      case 'axes': {
        const ox = 40, oy = 160;
        svg.appendChild(svgEl('line', { x1: ox, y1: oy, x2: 280, y2: oy, stroke, 'stroke-width': 2, 'stroke-linecap': 'round' }));
        addArrowHead(svg, ox, oy, 280, oy, stroke);
        svg.appendChild(svgEl('line', { x1: ox, y1: oy, x2: ox, y2: 20, stroke, 'stroke-width': 2, 'stroke-linecap': 'round' }));
        addArrowHead(svg, ox, oy, ox, 20, stroke);
        if (el.xLabel) addText(svg, 268, oy + 20, el.xLabel, accent, 11, 'end');
        if (el.yLabel) addText(svg, ox - 10, 30, el.yLabel, accent, 11, 'end');
        addText(svg, ox - 8, oy + 16, '0', '#a3a3a3', 10, 'end');
        break;
      }
      case 'numberline': {
        const min = Number(el.min), max = Number(el.max), marks = el.marks || [];
        const x0 = 30, x1 = 270, y = 100, span = x1 - x0;
        const v2x = v => x0 + ((v - min) / (max - min || 1)) * span;
        svg.appendChild(svgEl('line', { x1: x0, y1: y, x2: x1, y2: y, stroke, 'stroke-width': 2 }));
        addArrowHead(svg, x1 - 5, y, x1, y, stroke);
        addArrowHead(svg, x0 + 5, y, x0, y, stroke);
        marks.forEach(v => {
          const x = v2x(v);
          svg.appendChild(svgEl('line', { x1: x, y1: y - 6, x2: x, y2: y + 6, stroke: yellow, 'stroke-width': 2 }));
          addText(svg, x, y + 22, String(v), yellow, 11);
        });
        if (el.title) addText(svg, 150, 45, el.title, accent, 12);
        break;
      }
      case 'venn': {
        const labels = el.labels || ['A', 'B'];
        if (labels.length === 2) {
          const cy = 100, r = 55, c1x = 115, c2x = 185;
          [c1x, c2x].forEach(cx => {
            svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: yellow, 'stroke-width': 2 }));
          });
          addText(svg, c1x - 20, cy - 65, labels[0], yellow, 13);
          addText(svg, c2x + 20, cy - 65, labels[1], yellow, 13);
          if (el.overlap) addText(svg, 150, cy + 4, el.overlap, accent, 12);
        } else {
          const r = 45;
          const pos = [[150, 72], [108, 128], [192, 128]];
          pos.forEach(([cx, cy], i) => {
            svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: yellow, 'stroke-width': 2 }));
            addText(svg, cx, cy + 4, labels[i], yellow, 12);
          });
          if (el.overlap) addText(svg, 150, 100, el.overlap, accent, 11);
        }
        break;
      }
      case 'cycle': {
        const nodes = el.nodes || [];
        const cx = 150, cy = 100, r = 70, n = nodes.length;
        svg.appendChild(svgEl('circle', {
          cx, cy, r, fill: 'none',
          stroke: 'rgba(163,230,53,0.28)', 'stroke-width': 1.5,
          'stroke-dasharray': '4 4'
        }));
        // Arcs between nodes
        for (let i = 0; i < n; i++) {
          const a1 = -Math.PI / 2 + (i / n) * Math.PI * 2;
          const a2 = -Math.PI / 2 + ((i + 1) / n) * Math.PI * 2;
          const sx = cx + Math.cos(a1) * r, sy = cy + Math.sin(a1) * r;
          const ex = cx + Math.cos(a2) * r, ey = cy + Math.sin(a2) * r;
          const midA = (a1 + a2) / 2;
          const cxArc = cx + Math.cos(midA) * (r + 12);
          const cyArc = cy + Math.sin(midA) * (r + 12);
          svg.appendChild(svgEl('path', {
            d: `M${sx},${sy} Q${cxArc},${cyArc} ${ex},${ey}`,
            stroke: accent, 'stroke-width': 1.5, fill: 'none', 'stroke-linecap': 'round'
          }));
        }
        // Nodes + labels
        nodes.forEach((label, i) => {
          const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
          const nx = cx + Math.cos(ang) * r;
          const ny = cy + Math.sin(ang) * r;
          svg.appendChild(svgEl('circle', { cx: nx, cy: ny, r: 4, fill: yellow }));
          const tx = cx + Math.cos(ang) * (r + 22);
          const ty = cy + Math.sin(ang) * (r + 22) + 4;
          addText(svg, tx, ty, label, yellow, 10);
        });
        break;
      }
    }
    return svg;
  }

  // ==================================================
  //  ELEMENT BUILDING
  // ==================================================
  function buildElementNode(el) {
    if (el.type === 'tool' && el.name === 'calculator') {
      setTimeout(() => { if (window.openCalculator) window.openCalculator(); }, 500);
      const n = document.createElement('div');
      n.className = 'chalk-el chalk-title';
      n.textContent = '🧮 Calculator Opened';
      n.style.color = '#fbbf24';
      return n;
    }
    if (el.type === 'divider') {
      const d = document.createElement('div');
      d.className = 'chalk-divider';
      return d;
    }
    if (el.type === 'note') {
      const n = document.createElement('div');
      n.className = 'chalk-note chalk-note-' + (el.accent || 'info');
      n.textContent = el.text;
      return n;
    }
    if (el.type === 'arrow') {
      const a = document.createElement('div');
      a.className = 'chalk-arrow';
      a.innerHTML = `<span class="arrow-line"></span><span class="arrow-label">${esc(el.label || '')}</span>`;
      return a;
    }
    if (el.type === 'diagram') {
      const d = document.createElement('div');
      d.className = 'chalk-diagram ' + (el.shape === 'tree' ? 'diagram-tree' : 'diagram-flow');
      return d;
    }
    if (el.type === 'draw') {
      const d = document.createElement('div');
      d.className = 'chalk-el chalk-draw';
      return d;
    }
    const n = document.createElement('div');
    n.className = 'chalk-el chalk-' + el.type;
    n.innerHTML = '<span class="chalk-char-holder"></span>';
    return n;
  }

  // ==================================================
  //  ANIMATIONS
  // ==================================================
  function animateText(node, text, baseDelay) {
    const holder = node.querySelector('.chalk-char-holder');
    holder.innerHTML = '';
    [...text].forEach((ch, i) => {
      const span = document.createElement('span');
      span.className = 'chalk-char';
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      span.style.animationDelay = `${baseDelay + i * CHAR_DELAY}ms`;
      holder.appendChild(span);
    });
    return text.length * CHAR_DELAY + 320;
  }

  function animateArrow(node, baseDelay) {
    const line = node.querySelector('.arrow-line');
    const label = node.querySelector('.arrow-label');
    if (line) line.style.animationDelay = `${baseDelay}ms`;
    if (label) label.style.animationDelay = `${baseDelay + 250}ms`;
    return 650;
  }

  function animateDivider(node, baseDelay) {
    node.style.animationDelay = `${baseDelay}ms`;
    return 400;
  }

  function animateNote(node, baseDelay) {
    node.style.opacity = '0';
    node.style.animation = `chalk-note-in 0.45s ease-out ${baseDelay}ms forwards`;
    return 500;
  }

  function animateFlowDiagram(node, el, baseDelay) {
    const nodes = el.nodes, isTree = el.shape === 'tree';
    let t = baseDelay;
    node.classList.add(isTree ? 'tree-stack' : 'flow-stack');
    nodes.forEach((label, i) => {
      const box = document.createElement('div');
      box.className = 'chalk-node';
      box.textContent = label;
      box.style.animationDelay = `${t}ms`;
      node.appendChild(box);
      t += 320;
      if (i < nodes.length - 1) {
        const a = document.createElement('div');
        a.className = isTree ? 'chalk-node-arrow-down' : 'chalk-node-arrow';
        a.innerHTML = isTree
          ? '<svg width="18" height="24" viewBox="0 0 18 24"><path d="M9 2 L9 18 M3 14 L9 20 L15 14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '<svg width="26" height="14" viewBox="0 0 26 14"><path d="M2 7 L22 7 M16 3 L22 7 L16 11" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        a.style.animationDelay = `${t}ms`;
        node.appendChild(a);
        t += 200;
      }
    });
    return t - baseDelay + 200;
  }

  function animateDraw(node, el, baseDelay) {
    const svg = buildDrawing(el);
    node.appendChild(svg);

    // Animate stroke reveal for line shapes
    svg.querySelectorAll('path, line, circle, ellipse, polygon, polyline').forEach((shape, i) => {
      let len = 100;
      try { if (shape.getTotalLength) len = shape.getTotalLength(); } catch {}
      if (!Number.isFinite(len) || len < 1) len = 100;
      shape.style.strokeDasharray = `${len}`;
      shape.style.strokeDashoffset = `${len}`;
      const dur = Math.min(1400, Math.max(280, len * 4));
      shape.style.animation = `chalk-draw ${dur}ms ease-out ${baseDelay + i * 60}ms forwards`;
    });

    // Fade-in labels after the drawing
    svg.querySelectorAll('text').forEach(t => {
      t.style.opacity = '0';
      t.style.animation = `chalk-fade-in 0.4s ease-out ${baseDelay + 700}ms forwards`;
    });

    return 1600;
  }

  // ==================================================
  //  SEGMENT RENDERING
  // ==================================================
  function renderSegment(seg, onComplete) {
    const sectionEl = getSectionEl(seg.section) || getSectionEl(1);
    if (!sectionEl) { onComplete(); return; }

    if (seg.kind === 'break') {
      container.innerHTML = `
        <div class="chalk-break-card">
          <div class="break-icon">☕</div>
          <h2>Break Time!</h2>
          <p>${esc(seg.speech || 'Take a quick stretch and rest your eyes.')}</p>
          <p class="break-hint">Click "Skip" when you are ready to continue.</p>
        </div>
      `;
      return;
    }

    if (!seg.elements || !seg.elements.length) {
      const t = setTimeout(onComplete, 150);
      cs.chalkTimeouts.push(t);
      return;
    }

    const container = document.createElement('div');
    container.className = 'chalk-segment kind-' + seg.kind;
    sectionEl.appendChild(container);

    let runningTime = 0;
    seg.elements.forEach(el => {
      const node = buildElementNode(el);
      container.appendChild(node);

      let elTime = 0;
      if (el.type === 'draw')                       elTime = animateDraw(node, el, runningTime);
      else if (el.type === 'diagram')                elTime = animateFlowDiagram(node, el, runningTime);
      else if (el.type === 'note')                   elTime = animateNote(node, runningTime);
      else if (el.type === 'arrow')                  elTime = animateArrow(node, runningTime);
      else if (el.type === 'divider')                elTime = animateDivider(node, runningTime);
      else if (el.text)                              elTime = animateText(node, el.text, runningTime);

      runningTime += elTime + ELEMENT_GAP;
    });

    const scroll = () => { sectionEl.scrollTop = sectionEl.scrollHeight; };
    cs.chalkTimeouts.push(setTimeout(scroll, 200));
    cs.chalkTimeouts.push(setTimeout(scroll, runningTime));
    cs.chalkTimeouts.push(setTimeout(scroll, runningTime + 400));

    const t = setTimeout(onComplete, runningTime + 400);
    cs.chalkTimeouts.push(t);
  }

  // ==================================================
  //  TTS
  // ==================================================
  function speakClassSpeech(text, onEnd) {
    if (!('speechSynthesis' in window)) return onEnd();
    const enabled = hooks().ttsEnabled ? hooks().ttsEnabled() : true;
    if (!enabled) return onEnd();
    try { window.speechSynthesis.cancel(); } catch {}
    const clean = String(text).replace(/[`*#_]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return onEnd();

    const chunks = [];
    let rem = clean;
    const MAX = 220;
    while (rem.length > MAX) {
      let cut = rem.lastIndexOf('. ', MAX);
      if (cut < MAX * 0.5) cut = rem.lastIndexOf(', ', MAX);
      if (cut < MAX * 0.3) cut = rem.lastIndexOf(' ', MAX);
      if (cut < 0) cut = MAX; else cut += 1;
      chunks.push(rem.slice(0, cut).trim());
      rem = rem.slice(cut).trim();
    }
    if (rem) chunks.push(rem);

    let idx = 0;
    const speakNext = () => {
      if (idx >= chunks.length) return onEnd();
      const u = new SpeechSynthesisUtterance(chunks[idx]);
      const voices = window.speechSynthesis.getVoices();
      let pref = null;
      
      if (window.classLang === 'ny') {
        // Look for any African/Bantu voice first, then fallback to default
        pref = voices.find(v => v.lang.includes('ny') || v.lang.includes('MW') || v.lang.includes('sw') || v.lang.includes('zu'));
        u.lang = 'ny-MW'; // Tell browser to use Chichewa phonetics if possible
        
        // If no native Chichewa voice, just let the default voice read the Chichewa text
        if (!pref) {
          pref = voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
        }
      } else {
        pref = voices.find(v => /Google UK English Female|Google US English|Samantha|Karen/i.test(v.name))
            || voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
      }
      
      if (pref) u.voice = pref;
      u.rate = 0.65; // Very slow, deliberate teaching pace // Much slower // Slower for understanding u.pitch = 1.0;
      u.onend = () => { idx++; speakNext(); };
      u.onerror = () => onEnd();
      window.speechSynthesis.speak(u);
    };
    speakNext();
  }

  function cancelClassSpeech() { try { window.speechSynthesis.cancel(); } catch {} }

  // ==================================================
  //  PLAYBACK
  // ==================================================
  async function playSegment(index) {
    if (!cs.session) return;
    if (index >= cs.session.segments.length) {
      const ok = await fetchNextSegment();
      if (!ok) {
        if (cs.session.isComplete) finishClass();
        else { $('chalkStatus').textContent = 'Paused — click Skip to retry'; $('chalkStatus').className = 'chalk-status'; }
        return;
      }
    }
    const seg = cs.session.segments[index];
    if (!seg) return;

    cs.currentSegIndex = index;
    updateHeader();

    $('chalkKind').textContent = seg.kind || 'point';
    $('chalkKind').className = 'chalk-kind kind-' + (seg.kind || 'point');
    
    if (seg.kind === 'break') {
      $('chalkKind').textContent = '☕ Break Time';
      $('chalkKind').style.color = '#fbbf24';
    } else {
      $('chalkKind').style.color = ''; // reset
    }
    $('chalkStatus').textContent = 'Writing…';
    $('chalkStatus').className = 'chalk-status writing';

    clearChalkTimeouts();

    renderSegment(seg, () => {
      $('chalkStatus').textContent = 'Speaking…';
      $('chalkStatus').className = 'chalk-status speaking';
      cs.speaking = true;

      prefetchNext(index + 1);

      speakClassSpeech(seg.speech, () => {
        cs.speaking = false;
        $('chalkStatus').textContent = '';
        $('chalkStatus').className = 'chalk-status';
        if (cs.playing && !cs.paused) {
          if (seg.isFinal) finishClass();
          else setTimeout(() => playSegment(index + 1), 400);
        }
      });
    });
  }

  async function prefetchNext(target) {
    if (!cs.session || cs.session.segments[target]) return;
    if (cs.fetching) return;
    await fetchNextSegment();
  }

  async function fetchNextSegment(retried = false) {
    if (cs.fetching) return false;
    const pid = hooks().profileId ? hooks().profileId() : null;
    if (!pid) return false;
    cs.fetching = true;
    try {
      const r = await fetch('/api/classroom/next', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: pid, language: window.classLang })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed.');
      if (!d.segment) {
        cs.session.isComplete = true;
        if (d.session) cs.session = d.session;
        return false;
      }
      cs.session.segments.push(d.segment);
      updateHeader();
      if (d.isFinal) {
        cs.session.segments[cs.session.segments.length - 1].isFinal = true;
        cs.session.isComplete = true;
      }
      return true;
    } catch (e) {
      if (!retried) {
        cs.fetching = false;
        await new Promise(r => setTimeout(r, 1200));
        return fetchNextSegment(true);
      }
      if (hooks().showToast) hooks().showToast('Could not fetch next: ' + e.message);
      return false;
    } finally {
      cs.fetching = false;
    }
  }

  function finishClass() {
    cs.playing = false; cs.paused = false; updateControls();
    $('classroomCompletePanel').style.display = 'flex';
    $('chalkStatus').textContent = 'Class complete ✓';
    $('chalkStatus').className = 'chalk-status done';
    $('classDoneTopic').textContent = cs.session?.topic || 'today\'s topic';
    if (hooks().refreshExBadge) hooks().refreshExBadge();
  }

  function updateControls() {
    const btn = $('classPlayBtn');
    if (!btn) return;
    if (!cs.playing) btn.textContent = '▶ Start';
    else if (cs.paused) btn.textContent = '▶ Resume';
    else btn.textContent = '⏸ Pause';
  }

  async function startClass() {
    showClassroomView();
    cs.session = null; cs.currentSegIndex = -1;
    cs.playing = false; cs.paused = false; cs.speaking = false;
    clearChalkTimeouts(); cancelClassSpeech();
    $('chalkContent').innerHTML = '';
    $('chalkKind').textContent = '';
    $('chalkStatus').textContent = '';
    $('classroomCompletePanel').style.display = 'none';
    $('classroomIntroCard').style.display = 'none';
    $('classroomLoading').style.display = 'flex';
    $('classroomBoard').style.display = 'none';
    $('classroomControls').style.display = 'none';

    const pid = hooks().profileId ? hooks().profileId() : null;
    if (!pid) { if (hooks().showToast) hooks().showToast('Complete your profile first.'); return; }
    try { const w = new SpeechSynthesisUtterance(''); w.volume = 0; window.speechSynthesis.speak(w); } catch {}

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      
      const r = await fetch('/api/classroom/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: pid, language: window.classLang || 'en' }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed.');

      cs.session = d.session;
      $('classroomLoading').style.display = 'none';
      $('classroomBoard').style.display = 'flex';
      buildBoardLayout(cs.session.layout || 'single');
      updateHeader(); updateControls();

      const ttsOn = hooks().ttsEnabled ? hooks().ttsEnabled() : false;
      const layoutLabel = { single: 'Single board', two: 'Two-column board', three: 'Three-column board' }[cs.session.layout] || 'Single board';

      $('classroomIntroCard').innerHTML = `
        <div class="intro-icon">🎓</div>
        <h2>Today's class</h2>
        <h3>${esc(cs.session.subject)}</h3>
        <p class="intro-topic">${esc(cs.session.topic)}</p>
        ${cs.session.reasoning ? `<p class="intro-reason">"${esc(cs.session.reasoning)}"</p>` : ''}
        <p class="intro-layout">📐 ${layoutLabel}</p>
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
    } catch (e) {
      $('classroomLoading').style.display = 'none';
      alert('START CLASS ERROR: ' + e.message); // This will pop up
      if (hooks().showToast) hooks().showToast('Could not start class: ' + e.message);
    }
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
      cs.paused = true; cancelClassSpeech(); clearChalkTimeouts(); updateControls();
    }
  }

  async function skipSegment() {
    if (!cs.session) return;
    cancelClassSpeech(); clearChalkTimeouts();
    const next = cs.currentSegIndex + 1;
    if (next < cs.session.segments.length) playSegment(next);
    else { const ok = await fetchNextSegment(); if (ok) playSegment(next); else if (cs.session.isComplete) finishClass(); }
  }

  function clearBoard() {
    clearChalkTimeouts(); cancelClassSpeech();
    document.querySelectorAll('.chalk-section').forEach(sec => {
      const tab = sec.querySelector('.section-tab');
      sec.innerHTML = ''; if (tab) sec.appendChild(tab);
    });
    $('chalkKind').textContent = ''; $('chalkStatus').textContent = '';
    if (hooks().showToast) hooks().showToast('Board cleared');
  }

  function endClass() {
    cs.playing = false; cs.paused = false;
    cancelClassSpeech(); clearChalkTimeouts(); updateControls();
    if (hooks().showView) hooks().showView('upload');
  }

  document.addEventListener('DOMContentLoaded', () => {

    $('liveClassBtn')?.addEventListener('click', async () => {
      const pid = hooks().profileId ? hooks().profileId() : null;
      if (!pid) { if (hooks().showToast) hooks().showToast('Complete your profile first.'); return; }
      await startClass();
    });
    $('classPlayBtn')?.addEventListener('click', pauseResume);
    $('classSkipBtn')?.addEventListener('click', skipSegment);
    $('classClearBtn')?.addEventListener('click', clearBoard);
    $('classEndBtn')?.addEventListener('click', endClass);
    $('classPracticeBtn')?.addEventListener('click', () => {
      if (hooks().showView) hooks().showView('exercises');
      setTimeout(() => { if (hooks().loadExerciseList) hooks().loadExerciseList(); }, 150);
    });
    $('classAnotherBtn')?.addEventListener('click', async () => { await startClass(); });
  });

  window.__classroomStart = startClass;
})();

// ============================================================
// RAISE HAND (Speech to Text) & CALCULATOR
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  const handBtn = document.getElementById('classHandBtn');
  let recognition = null;
  let isListening = false;

  // --- 1. Raise Hand Logic (Web Speech API) ---
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US'; // You can change this to 'ny-MW' for Chichewa if supported

    recognition.onstart = () => {
      isListening = true;
      if(handBtn) { handBtn.textContent = '🔴 Listening...'; handBtn.style.background = '#ef4444'; handBtn.style.color = 'white'; }
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if(handBtn) handBtn.textContent = '✋ Raise Hand';
      isListening = false;
      
      // Pause the class and inject the student's question
      if (cs.playing) pauseResume(); 
      
      // Put the text in the composer and send it
      const input = document.getElementById('input');
      if (input) {
        input.value = "✋ [Student asked]: " + transcript;
        if (window.hooks && window.hooks().showToast) window.hooks().showToast('Microphone captured!');
        
        // We'll use a quick prompt to the AI to answer the question directly
        const chatBtn = document.getElementById('sendBtn');
        // We don't actually switch views, we just alert the student to continue
        alert("You asked: " + transcript + "\n\n(Close this and type it in the chat to get an answer!)");
        input.value = transcript;
      }
    };

    recognition.onerror = () => {
      if(handBtn) handBtn.textContent = '✋ Raise Hand';
      isListening = false;
    };
    
    recognition.onend = () => {
      if(handBtn) handBtn.textContent = '✋ Raise Hand';
      isListening = false;
    };
  }

  if (handBtn) {
    handBtn.addEventListener('click', () => {
      if (!recognition) return alert('Speech recognition not supported on this browser.');
      if (isListening) {
        recognition.stop();
      } else {
        recognition.start();
      }
    });
  }

  // --- 2. Calculator Logic ---
  const calc = document.getElementById('liveCalculator');
  const display = document.getElementById('calcDisplay');
  let currentInput = '';

  window.openCalculator = () => {
    if (calc) calc.style.display = 'block';
  };

  document.getElementById('closeCalcBtn')?.addEventListener('click', () => {
    if (calc) calc.style.display = 'none';
  });

  calc?.querySelectorAll('.calc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      if (val === 'C') {
        currentInput = '';
        display.textContent = '0';
      } else if (val === '=') {
        try {
          // Safe eval substitute
          const result = Function('"use strict";return (' + currentInput + ')')();
          display.textContent = result;
          currentInput = String(result);
        } catch {
          display.textContent = 'Error';
          currentInput = '';
        }
      } else {
        currentInput += val;
        display.textContent = currentInput;
      }
    });
  });
});
