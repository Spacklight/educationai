export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
    const err = (msg, status = 400) => json({ error: msg }, status);

    try {
      if (path.startsWith('/api/')) {
        
        // --- TEST ENV VARIABLES ---
        if (path === '/api/test-env') {
          return json({ 
            hasGemini: !!env.GEMINI_API_KEY, 
            hasGithub: !!env.GITHUB_TOKEN,
            owner: env.GITHUB_OWNER,
            repo: env.GITHUB_REPO
          });
        }

        // --- AUTH ---
        if (path === '/api/auth/register' && method === 'POST') {
          const body = await request.json();
          const profiles = await readGitHub(env, 'data/profiles.json', []);
          if (profiles.find(p => p.username && p.username.toLowerCase() === body.username.toLowerCase())) {
            return err('Username already exists.');
          }
          const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
          const newProfile = { ...body, id, passwordHash: await hashPassword(body.password) };
          delete newProfile.password;
          profiles.push(newProfile);
          await writeGitHub(env, 'data/profiles.json', profiles);
          return json({ id, profile: newProfile });
        }

        if (path === '/api/auth/login' && method === 'POST') {
          const body = await request.json();
          const profiles = await readGitHub(env, 'data/profiles.json', []);
          const profile = profiles.find(p => p.username && p.username.toLowerCase() === body.username.toLowerCase());
          if (!profile || profile.passwordHash !== await hashPassword(body.password)) {
            return err('Invalid username or password.', 401);
          }
          return json({ id: profile.id, profile });
        }

        // --- PROFILE ---
        if (path === '/api/profile' && method === 'POST') {
          const body = await request.json();
          const profiles = await readGitHub(env, 'data/profiles.json', []);
          const id = body.id || Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
          const record = { ...body, id, updatedAt: new Date().toISOString() };
          if (!record.createdAt) record.createdAt = record.updatedAt;
          
          const idx = profiles.findIndex(p => p.id === id);
          if (idx >= 0) profiles[idx] = record; else profiles.push(record);
          await writeGitHub(env, 'data/profiles.json', profiles);
          return json({ id, profile: record });
        }

        if (path.startsWith('/api/profile/') && path.endsWith('/avatar') && method === 'POST') {
          const id = path.split('/')[3];
          const formData = await request.formData();
          const file = formData.get('file');
          if (!file) return err('No file');
          const buffer = await file.arrayBuffer();
          await writeGitHubBinary(env, `avatars/${id}.png`, buffer);
          return json({ ok: true, avatarUrl: `/api/profile/${id}/avatar?v=${Date.now()}` });
        }

        if (path.startsWith('/api/profile/') && path.endsWith('/avatar') && method === 'GET') {
          const id = path.split('/')[3];
          const res = await fetchGitHubFile(env, `avatars/${id}.png`);
          if (!res) return new Response('Not found', { status: 404 });
          return new Response(res, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' } });
        }

        if (path.match(/^\/api\/profile\/[^\/]+$/) && method === 'GET') {
          const id = path.split('/')[3];
          const profiles = await readGitHub(env, 'data/profiles.json', []);
          const p = profiles.find(x => x.id === id);
          if (!p) return err('Not found', 404);
          return json(p);
        }

        // --- MATERIALS ---
        if (path === '/api/materials/upload' && method === 'POST') {
          const formData = await request.formData();
          const profileId = formData.get('profileId');
          const files = formData.getAll('files');
          if (!profileId || !files.length) return err('Missing data.');

          const parsedDocs = [];
          for (const file of files) {
            const buffer = await file.arrayBuffer();
            const base64 = b64EncodeUnicode(new TextDecoder().decode(buffer));
            
            const prompt = `Extract the main topics and subtopics from this document. Return ONLY JSON: {"subject":"...","title":"${file.name}","topics":[{"name":"...","subtopics":["..."]}]}`;
            const aiResp = await callGemini(env, prompt, { mimeType: file.type, data: base64 }, true);
            parsedDocs.push(aiResp);
          }

          const all = await readGitHub(env, 'data/materials.json', []);
          let rec = all.find(m => m.profileId === profileId);
          if (!rec) { rec = { profileId, materials: [] }; all.push(rec); }
          
          const newMaterials = parsedDocs.map(d => ({
            id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
            name: d.title || 'Document',
            subject: d.subject || 'General',
            title: d.title || 'Document',
            topics: d.topics || [],
            textLength: 0,
            uploadedAt: new Date().toISOString()
          }));

          rec.materials.push(...newMaterials);
          await writeGitHub(env, 'data/materials.json', all);
          return json({ materials: newMaterials });
        }

        if (path.match(/^\/api\/materials\/[^\/]+$/) && method === 'GET') {
          const profileId = path.split('/')[3];
          const all = await readGitHub(env, 'data/materials.json', []);
          const rec = all.find(m => m.profileId === profileId);
          return json({ materials: rec ? rec.materials : [] });
        }

        // --- CHAT ---
        if (path === '/api/chat' && method === 'POST') {
          const body = await request.json();
          const { profileId, message, history } = body;
          const profiles = await readGitHub(env, 'data/profiles.json', []);
          const profile = profiles.find(p => p.id === profileId);
          
          const teacherPrompt = `You are a warm, patient, expert teacher.\nStudent: ${JSON.stringify(profile)}\nSpeak clearly. Use markdown.`;
          const contents = (history || []).map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
          contents.push({ role: 'user', parts: [{ text: message }] });

          const aiResp = await callGemini(env, null, null, false, contents, teacherPrompt);
          
          const suggestClass = message.toLowerCase().includes('live class') || message.toLowerCase().includes('deep dive');
          if (suggestClass) {
            const ts = await readGitHub(env, 'data/teacher-states.json', []);
            let state = ts.find(t => t.profileId === profileId);
            if (!state) { state = { profileId, announcements: [] }; ts.push(state); }
            state.pendingClassSuggestion = {
              topic: "Deep Dive",
              message: "I've prepared a live class based on our chat.",
              at: new Date().toISOString(),
              scheduledAt: Date.now() + 5 * 60 * 1000
            };
            await writeGitHub(env, 'data/teacher-states.json', ts);
          }

          return json({ reply: aiResp });
        }

        // --- CLASSROOM ---
        if (path === '/api/classroom/start' && method === 'POST') {
          const body = await request.json();
          const { profileId, language } = body;
          const profiles = await readGitHub(env, 'data/profiles.json', []);
          const profile = profiles.find(p => p.id === profileId);
          
          let prompt = `Start a live class for ${profile.name}. Return JSON: {"subject":"...","topic":"...","layout":"single","segments":[{"kind":"title","section":1,"elements":[{"type":"text","text":"..."}],"speech":"..."}]}`;
          if (language === 'ny') prompt += `\nCRITICAL: Teach entirely in Chichewa.`;

          const parsed = await callGemini(env, prompt, null, true);
          
          const session = {
            id: Math.random().toString(36).slice(2, 10),
            profileId,
            subject: parsed.subject || 'General',
            topic: parsed.topic || 'Topic',
            layout: parsed.layout || 'single',
            segments: parsed.segments || [],
            isComplete: false
          };
          
          const rooms = await readGitHub(env, 'data/classrooms.json', []);
          const updated = rooms.filter(r => r.profileId !== profileId);
          updated.push(session);
          await writeGitHub(env, 'data/classrooms.json', updated);
          return json({ session });
        }

        if (path === '/api/classroom/next' && method === 'POST') {
          const body = await request.json();
          const { profileId, language } = body;
          const rooms = await readGitHub(env, 'data/classrooms.json', []);
          const session = rooms.find(r => r.profileId === profileId);
          if (!session || session.isComplete) return json({ segment: null, isFinal: true });

          let prompt = `Continue live class on ${session.topic}. Return JSON: {"segment":{"kind":"point","section":1,"elements":[{"type":"text","text":"..."}],"speech":"..."},"isFinal":false}`;
          if (language === 'ny') prompt += `\nCRITICAL: Teach entirely in Chichewa.`;

          const parsed = await callGemini(env, prompt, null, true);
          if (parsed.segment) {
            session.segments.push(parsed.segment);
            if (parsed.isFinal) session.isComplete = true;
          }

          const updated = rooms.filter(r => r.profileId !== profileId);
          updated.push(session);
          await writeGitHub(env, 'data/classrooms.json', updated);
          return json({ segment: parsed.segment, isFinal: parsed.isFinal, session });
        }

        if (path === '/api/classroom/dismiss-suggestion' && method === 'POST') {
          const body = await request.json();
          const { profileId } = body;
          const ts = await readGitHub(env, 'data/teacher-states.json', []);
          const state = ts.find(t => t.profileId === profileId);
          if (state) {
            delete state.pendingClassSuggestion;
            await writeGitHub(env, 'data/teacher-states.json', ts);
          }
          return json({ ok: true });
        }

        // --- USAGE / MISC ---
        if (path === '/api/usage') return json({ used: 10, limit: 500 });
        
        return err('API Route Not Found', 404);
      }

      return env.ASSETS.fetch(request);

    } catch (e) {
      console.error(e);
      return err('Server Error: ' + e.message, 500);
    }
  }
};

// ============================================================
// HELPERS
// ============================================================
function b64EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1)));
}
function b64DecodeUnicode(str) {
  return decodeURIComponent(Array.prototype.map.call(atob(str), (c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

async function hashPassword(pass) {
  const msgBuffer = new TextEncoder().encode(pass);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function callGemini(env, prompt, fileData = null, jsonMode = false, contents = null, systemPrompt = null) {
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`;
  let body;
  if (contents) {
    body = { contents };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  } else {
    const parts = [{ text: prompt }];
    if (fileData) parts.push({ inlineData: fileData });
    body = { contents: [{ role: 'user', parts }] };
  }
  if (jsonMode) body.generationConfig = { responseMimeType: 'application/json', temperature: 0.7 };

  const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (jsonMode) {
    try { return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim()); } 
    catch { return {}; }
  }
  return text;
}

async function fetchGitHubFile(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'CF-Worker' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub Fetch Error');
  const data = await res.json();
  return { content: data.content, sha: data.sha };
}

async function readGitHub(env, path, fallback) {
  const file = await fetchGitHubFile(env, path);
  if (!file) return fallback;
  const decoded = b64DecodeUnicode(file.content.replace(/\n/g, ''));
  return JSON.parse(decoded);
}

async function writeGitHub(env, path, data) {
  const file = await fetchGitHubFile(env, path);
  const content = b64EncodeUnicode(JSON.stringify(data, null, 2));
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const body = { message: `update ${path}`, content, branch: 'main' };
  if (file) body.sha = file.sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'CF-Worker', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error('GitHub Write Failed: ' + errorText);
  }
}

async function writeGitHubBinary(env, path, arrayBuffer) {
  const file = await fetchGitHubFile(env, path);
  const b64 = b64EncodeUnicode(new TextDecoder().decode(arrayBuffer));
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const body = { message: `update ${path}`, content: b64, branch: 'main' };
  if (file) body.sha = file.sha;

  await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'CF-Worker', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
