const crypto = require('crypto');
require("dns").setDefaultResultOrder("ipv4first");
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!API_KEY) { console.error('❌ Missing GEMINI_API_KEY'); process.exit(1); }

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ Storage ============
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  profiles:      path.join(DATA_DIR, 'profiles.json'),
  timetables:    path.join(DATA_DIR, 'timetables.json'),
  visions:       path.join(DATA_DIR, 'visions.json'),
  exercises:     path.join(DATA_DIR, 'exercises.json'),
  submissions:   path.join(DATA_DIR, 'submissions.json'),
  materials:     path.join(DATA_DIR, 'materials.json'),
  teacherStates: path.join(DATA_DIR, 'teacher-states.json')
};
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of Object.values(FILES)) if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');

const store = require('./github-store');
const readJSON  = (f) => {
  try {
    const rel = 'data/' + require('path').basename(f);
    const c = store.getCache(rel);
    if (c !== undefined) return c;
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const writeJSON = (f, v) => {
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
  const rel = 'data/' + require('path').basename(f);
  store.setCache(rel, v);
  store.queuePush(rel, v);
};
const readProfiles    = () => readJSON(FILES.profiles);
const writeProfiles   = (v) => writeJSON(FILES.profiles, v);
const readTimetables  = () => readJSON(FILES.timetables);
const writeTimetables = (v) => writeJSON(FILES.timetables, v);
const readVisions     = () => readJSON(FILES.visions);
const writeVisions    = (v) => writeJSON(FILES.visions, v);
const readExercises   = () => readJSON(FILES.exercises);
const writeExercises  = (v) => writeJSON(FILES.exercises, v);
const readSubmissions = () => readJSON(FILES.submissions);
const writeSubmissions = (v) => writeJSON(FILES.submissions, v);
const readMaterials   = () => readJSON(FILES.materials);
const writeMaterials  = (v) => writeJSON(FILES.materials, v);
const readTeacherStates = () => readJSON(FILES.teacherStates);
const writeTeacherStates = (v) => writeJSON(FILES.teacherStates, v);

function getTeacherState(profileId) {
  const all = readTeacherStates();
  let s = all.find(x => x.profileId === profileId);
  if (!s) {
    s = { profileId, learnedTopics: [], announcements: [], lastExerciseAt: null, notes: '' };
    all.push(s); writeTeacherStates(all);
  }
  return s;
}
function saveTeacherState(state) {
  const all = readTeacherStates().filter(x => x.profileId !== state.profileId);
  all.push(state); writeTeacherStates(all);
}

function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ============ Rate limits ============
let lastGenTime = 0;
const MIN_GEN_INTERVAL = 4000;
function canGenerate() {
  const now = Date.now();
  if (now - lastGenTime < MIN_GEN_INTERVAL) return false;
  lastGenTime = now; return true;
}
const LOG_FILE = path.join(__dirname, 'requests.log');
const todayKey = () => new Date().toISOString().slice(0, 10);
function readCount() { try { const d = JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); return d.date === todayKey() ? d.count : 0; } catch { return 0; } }
function bumpCount() { const c = readCount() + 1; fs.writeFileSync(LOG_FILE, JSON.stringify({ date: todayKey(), count: c })); return c; }
const DAILY_LIMIT = 500;

// ============ Doc store ============
const documents = new Map();
const MAX_DOC_CHARS = 120000;
const DOC_TTL = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, doc] of documents) if (now - doc.createdAt > DOC_TTL) documents.delete(id);
}, 10 * 60 * 1000);

async function extractText(buffer, name) {
  const ext = path.extname(name).toLowerCase();
  let text = '';
  if (ext === '.pdf')      { const d = await pdfParse(buffer); text = d.text || ''; }
  else if (ext === '.docx'){ const r = await mammoth.extractRawText({ buffer }); text = r.value || ''; }
  else if (ext === '.txt' || ext === '.md') { text = buffer.toString('utf8'); }
  else if (ext === '.doc') throw new Error('Old .doc not supported.');
  else throw new Error(`Unsupported: ${ext}`);
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function getCurrentContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const hour = now.getHours();
  let timeOfDay = 'night';
  if (hour >= 5 && hour < 12) timeOfDay = 'morning';
  else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
  else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
  
  return `CURRENT DATE & TIME: ${dateStr} at ${timeStr} (${timeOfDay})\nINSTRUCTION: Adapt your tone to the time. If it's late at night, suggest a brief review and remind them to rest. If it's morning, be energetic and start fresh.`;
}

function formatProfile(profile) {
  if (!profile) return 'STUDENT PROFILE: (unknown)';
  const l = [];
  if (profile.name) l.push(`- Name: ${profile.name}`);
  if (profile.age) l.push(`- Age: ${profile.age}`);
  if (profile.level) l.push(`- Level: ${profile.level}`);
  if (profile.grade) l.push(`- Grade: ${profile.grade}`);
  if (profile.subjects) l.push(`- Subjects: ${profile.subjects.join(', ')}`);
  if (profile.goal) l.push(`- Goal: ${profile.goal}`);
  if (profile.examDate) l.push(`- Exam: ${profile.examDate}`);
  if (profile.notes) l.push(`- Notes: ${profile.notes}`);
  return 'STUDENT PROFILE:\n' + l.join('\n');
}

function formatLearned(state) {
  if (!state.learnedTopics || !state.learnedTopics.length) return '(nothing yet — this may be the first lesson)';
  return state.learnedTopics.slice(-15).map(t =>
    `- ${t.subject}: ${t.topic}${t.subtopic ? ` → ${t.subtopic}` : ''}`
  ).join('\n');
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// ============ CHAT PROMPT — returns reply + decision ============
function buildTeacherChatPrompt({ profile, teacherState, moduleText, moduleTitle, history, message }) {
  const lastEx = timeAgo(teacherState.lastExerciseAt);
  return `You are an expert teacher conducting a lesson with ${profile?.name || 'the student'}.

${getCurrentContext()}

${formatProfile(profile)}

CURRENT MODULE:
${moduleTitle ? `"${moduleTitle}" — use its content to answer, and to choose exercise topics.` : '(Free chat — no specific module loaded.)'}

STUDY MATERIAL FROM CURRENT MODULE:
${moduleText ? moduleText.slice(0, 12000) : '(none)'}

WHAT THE STUDENT HAS LEARNED SO FAR (from previous lessons):
${formatLearned(teacherState)}

LAST EXERCISE ASSIGNED: ${lastEx}

CONVERSATION SO FAR:
${(history || []).map(h => `${h.role === 'user' ? 'STUDENT' : 'YOU'}: ${h.content.slice(0, 400)}`).join('\n') || '(new conversation)'}

STUDENT'S NEW MESSAGE:
${message}

YOUR TASK:
1. Teach your reply clearly, using markdown (**bold**, numbered lists, code blocks). Aim for 150–350 words.
2. Decide whether to assign an exercise based on these RULES.
3. Track what got taught this turn as learnedTopics.
4. If assigning, also produce a short announcement.

EXERCISE ASSIGNMENT RULES (be strict):
- Assign ONLY if the student has just learned something substantive (a real concept, method, or fact) — not a trivial single-sentence answer.
- Do NOT assign if the last exercise was assigned less than 10 minutes ago.
- Match type to what was taught:
  • factual recall → "quiz" (multiple choice, 5 questions)
  • concept understanding → "short_answer" (4 questions)
  • deep exploration → "research" (2-3 essay questions)
- Choose duration:
  • quiz → 15–30 min (short)
  • short_answer → 45–60 min (medium)
  • research → 1440–2880 min = 24–48h (long)
- If assigning, naturally say in your reply: "📝 I've set a [type] exercise on [topic] — check Exercises."
- If NOT assigning, set assignExercise=false, exerciseParams=null.

LIVE CLASS RULES:
- If the student asks for a "live class", "deep dive", "drawing", "diagram", or if the topic is highly visual (e.g., network topologies, math, anatomy), you MUST trigger a live class.
- To trigger it, set decision.suggestLiveClass = { "suggest": true, "topic": "The specific topic", "message": "A friendly intro message" }.
- If not triggering, set suggestLiveClass = null.

DURATION LABEL must be "short" | "medium" | "long" — matching durationMinutes above.

If you learned any topics this turn, include them in decision.learnedTopics.

Return ONLY valid JSON (no markdown fences):
{
  "reply": "markdown text shown to the student",
  "decision": {
    "learnedTopics": [{"subject":"...","topic":"...","subtopic":"..."}],
    "assignExercise": true|false,
    "exerciseParams": {
      "type": "quiz|short_answer|research|mixed",
      "difficulty": "easy|medium|hard",
      "count": 5,
      "durationMinutes": 20,
      "durationLabel": "short|medium|long",
      "focusTopic": "specific topic to test",
      "reason": "why assigning now"
    } | null,
    "announcement": "short one-line notification OR null",
    "suggestLiveClass": {
      "suggest": true | false,
      "topic": "topic to teach (only if suggest is true)",
      "message": "friendly notification message"
    } | null
  },
  "teacherNote": "internal note about student's understanding (not shown to student)"
}`;
}

// ============ Exercise generation prompt ============
function buildExercisePrompt({ profile, document, subject, type, difficulty, count, focusTopic }) {
  const typeGuide = {
    quiz: 'All questions multiple_choice with 4 options each.',
    short_answer: 'All questions short_answer (2–4 sentence answers).',
    research: 'All questions essay or research (200+ words each).',
    mixed: 'Mix: 40% multiple_choice, 30% short_answer, 30% essay/research.'
  }[type] || 'Mix.';
  return `You are an expert teacher creating a graded exercise.

${formatProfile(profile)}
Subject: ${subject}
${focusTopic ? `Focus topic: ${focusTopic}` : ''}
Type: ${type} · Difficulty: ${difficulty} · Count: ${count}
${typeGuide}

${document ? `--- SOURCE MATERIAL ---\n${document.slice(0, 25000)}\n--- END ---\n` : ''}

Rules:
- Exactly ${count} questions (q1..qN).
- multiple_choice: include "options" (4) + "correctIndex" (0-3).
- short_answer: include "expectedAnswer".
- essay/research: include "markingGuide".
- Points must sum to exactly 100.
- Specific to ${subject}${focusTopic ? ` and "${focusTopic}"` : ''}, ${difficulty} level.
- Do NOT leak answers inside the question text.

Return ONLY JSON:
{
  "title":"...","instructions":"...",
  "questions":[
    {"id":"q1","type":"...","question":"...","options":["..."],"correctIndex":0,"expectedAnswer":"...","markingGuide":"...","points":10}
  ],
  "totalPoints":100
}`;
}

function buildTypedGradingPrompt({ profile, exercise, answers }) {
  const q = exercise.questions.map(x => ({ id:x.id,type:x.type,question:x.question,options:x.options,correctIndex:x.correctIndex,expectedAnswer:x.expectedAnswer,markingGuide:x.markingGuide,points:x.points }));
  return `Grade this exercise fairly.

${formatProfile(profile)}
Exercise: ${exercise.title}

QUESTIONS:
${JSON.stringify(q, null, 2)}

STUDENT ANSWERS:
${JSON.stringify(answers, null, 2)}

Return ONLY JSON:
{"totalScore":<num>,"percentage":<num>,"letterGrade":"A+|A|A-|B+|B|B-|C+|C|C-|D|F","overallFeedback":"...","questionResults":[{"questionId":"q1","score":<num>,"maxScore":<num>,"feedback":"..."}],"strengths":["..."],"improvements":["..."]}`;
}

function buildFileGradingPrompt({ profile, exercise, extractedText }) {
  const q = exercise.questions.map(x => ({ id:x.id,type:x.type,question:x.question,options:x.options,correctIndex:x.correctIndex,expectedAnswer:x.expectedAnswer,markingGuide:x.markingGuide,points:x.points }));
  return `Grade this student's uploaded answer sheet.

${formatProfile(profile)}
Exercise: ${exercise.title}

QUESTIONS:
${JSON.stringify(q, null, 2)}

EXTRACTED ANSWER SHEET:
---BEGIN---
${extractedText}
---END---

Match each answer (labels like "Q1:", "1.", or sequential). Missing = 0 pts, note "Answer not found".

Return ONLY JSON:
{"totalScore":<num>,"percentage":<num>,"letterGrade":"...","overallFeedback":"...","questionResults":[{"questionId":"q1","score":<num>,"maxScore":<num>,"feedback":"..."}],"strengths":["..."],"improvements":["..."]}`;
}

function buildTimetablePrompt(profile, materials) {
  const today = new Date().toISOString().slice(0, 10);
  const mats = (materials && materials.length) ? `\nSTUDY MATERIALS:\n${materials.map(m => `- ${m.subject} "${m.title}": ${m.topics.map(t => t.name).join(' | ')}`).join('\n')}` : '';
  return `You are an expert study planner.

${formatProfile(profile)}
Today: ${today}
${profile.examDate ? `Exam: ${profile.examDate}` : ''}${mats}

Create a realistic weekly timetable.
- Total = ${profile.hours || 10}h.
- Preferred time: ${profile.time || 'evening'}.
${materials && materials.length ? '- Each session must use a specific topic (and subtopic when possible) from materials.' : ''}
- Add "period" field to each session: "Period 1"/"Period 2"/"Period 3".
- 30–90 min each. Max 3/day. Min 2 rest days.

Return ONLY JSON:
{"weekSummary":"...","totalHours":<num>,"subjectBreakdown":[{"subject":"...","hours":<num>}],"days":[{"day":"Monday","sessions":[{"period":"Period 1","subject":"...","topic":"...","subtopic":"...","durationMinutes":<30-90>,"timeOfDay":"<morning|afternoon|evening|night>"}]}]}
All 7 days.`;
}

function buildVisionPrompt(profile, timetable) {
  const today = new Date().toISOString().slice(0, 10);
  const days = profile.examDate ? Math.round((new Date(profile.examDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000) : null;
  return `You are an expert academic mentor.

${formatProfile(profile)}
Today: ${today}
${days !== null ? `Days until exam: ${days}` : 'No exam date.'}

Write a realistic, honest projection. Specific, not generic.

Return ONLY JSON:
{"headline":"<15 words>","confidence":"high|medium|low","daysUntilExam":<num|null>,"bestCase":{"score":"...","description":"..."},"likelyCase":{"score":"...","description":"..."},"worstCase":{"score":"...","description":"..."},"milestones":[{"period":"...","focus":"...","target":"..."}],"risks":[{"risk":"...","mitigation":"..."}],"todayFocus":{"subject":"...","action":"..."}}`;
}

function buildTopicExtractionPrompt(docs) {
  return `Analyze these study documents and extract their structure.

${docs.map((d, i) => `=== DOC ${i+1}: ${d.fileName} ===\n${d.text.slice(0, 15000)}\n=== END DOC ${i+1} ===`).join('\n\n')}

Return ONLY JSON:
{
  "documents": [
    {"fileName":"<exact>","subject":"<short subject>","title":"<doc title>","topics":[{"name":"<topic>","subtopics":["<sub1>"]}]}
  ]
}
3–10 topics per doc. Only real content.`;
}

function parseGeminiJSON(raw) {
  try { return JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Invalid JSON in response');
    return JSON.parse(m[0]);
  }
}

// ============ Profile endpoints ============

// ============================================================
// ============ AUTHENTICATION ================================
// ============================================================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

app.post('/api/auth/register', (req, res) => {
  const { username, password, name, age, level, grade, school, subjects, goal, examDate, hours, style, time, notes } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: 'Username, password, and name are required.' });

  const profiles = readProfiles();
  if (profiles.find(p => p.username && p.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Username already exists.' });
  }

  const id = newId();
  const newProfile = {
    id, username, passwordHash: hashPassword(password),
    name, age: Number(age), level, grade, school, subjects, goal, examDate,
    hours: Number(hours), style, time, notes,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  profiles.push(newProfile);
  writeProfiles(profiles);
  getTeacherState(id); // Initialize teacher state

  res.json({ id, profile: newProfile });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const profiles = readProfiles();
  const profile = profiles.find(p => p.username && p.username.toLowerCase() === username.toLowerCase());

  if (!profile || profile.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  res.json({ id: profile.id, profile });
});

app.post('/api/profile', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Name required.' });
    const all = readProfiles();
    const id = b.id || newId();
    const rec = { ...b, id, createdAt: b.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    const i = all.findIndex(p => p.id === id);
    if (i >= 0) all[i] = rec; else all.push(rec);
    writeProfiles(all);
    getTeacherState(id);
    res.json({ id, profile: rec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/profile/:id', (req, res) => {
  const p = readProfiles().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  res.json(p);
});

// ============ Teacher state + announcements ============
app.get('/api/teacher-state/:profileId', (req, res) => {
  res.json(getTeacherState(req.params.profileId));
});
app.post('/api/announcements/:profileId/seen', (req, res) => {
  const s = getTeacherState(req.params.profileId);
  s.announcements = s.announcements.map(a => ({ ...a, seen: true }));
  saveTeacherState(s);
  res.json({ ok: true });
});

// ============ Materials ============
app.post('/api/materials/upload', upload.array('files', 6), async (req, res) => {
  try {
    const { profileId } = req.body || {};
    if (!profileId) return res.status(400).json({ error: 'profileId required.' });
    if (!req.files?.length) return res.status(400).json({ error: 'No files.' });
    const profile = readProfiles().find(p => p.id === profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found.' });
    if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });

    const parsed = [], errors = [];
    for (const f of req.files) {
      try {
        const text = await extractText(f.buffer, f.originalname);
        if (text.length < 20) { errors.push({ file: f.originalname, error: 'No readable text.' }); continue; }
        parsed.push({ fileName: f.originalname, text });
      } catch (e) { errors.push({ file: f.originalname, error: e.message }); }
    }
    if (!parsed.length) return res.status(400).json({ error: 'Could not read any files.', errors });

    if (!canGenerate()) await new Promise(r => setTimeout(r, MIN_GEN_INTERVAL));
    const r = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildTopicExtractionPrompt(parsed) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4000, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Gemini error', details: e }); }
    const d = await r.json();
    const raw = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return res.status(500).json({ error: 'Empty response.' });
    const ai = parseGeminiJSON(raw);
    const docs = ai.documents || [];
    bumpCount();

    const materials = parsed.map(p => {
      const meta = docs.find(x => x.fileName === p.fileName) || {};
      return {
        id: newId(), name: p.fileName,
        subject: meta.subject || 'General',
        title: meta.title || p.fileName,
        topics: Array.isArray(meta.topics) ? meta.topics : [],
        textLength: p.text.length,
        text: p.text.slice(0, 50000),
        uploadedAt: new Date().toISOString()
      };
    });

    const all = readMaterials();
    let rec = all.find(m => m.profileId === profileId);
    if (!rec) { rec = { profileId, materials: [] }; all.push(rec); }
    rec.materials.push(...materials);
    writeMaterials(all);
    res.json({ materials, errors });
  } catch (e) {
    console.error('Materials upload:', e);
    res.status(500).json({ error: 'Upload failed.', details: e.message });
  }
});
app.get('/api/materials/:profileId', (req, res) => {
  const rec = readMaterials().find(m => m.profileId === req.params.profileId);
  res.json({ materials: rec ? rec.materials.map(m => ({ ...m, text: undefined })) : [] });
});
app.delete('/api/materials/:profileId/:id', (req, res) => {
  const all = readMaterials();
  const rec = all.find(m => m.profileId === req.params.profileId);
  if (!rec) return res.status(404).json({ error: 'Not found.' });
  rec.materials = rec.materials.filter(m => m.id !== req.params.id);
  writeMaterials(all);
  res.json({ ok: true });
});

// ============ Timetable ============
app.get('/api/timetable/:profileId', (req, res) => {
  const t = readTimetables().find(x => x.profileId === req.params.profileId);
  if (!t) return res.status(404).json({ error: 'None yet.' });
  res.json(t);
});
app.post('/api/timetable', async (req, res) => {
  const { profileId } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });
  const profile = readProfiles().find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
  if (!canGenerate()) return res.status(429).json({ error: 'Please wait.' });
  const matRec = readMaterials().find(m => m.profileId === profileId);
  try {
    const r = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildTimetablePrompt(profile, matRec?.materials || []) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 3500, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Gemini error', details: e }); }
    const d = await r.json();
    const tt = parseGeminiJSON(d?.candidates?.[0]?.content?.parts?.[0]?.text);
    if (!Array.isArray(tt.days) || !tt.days.length) throw new Error('Missing days.');
    const all = readTimetables().filter(t => t.profileId !== profileId);
    const rec = { profileId, generatedAt: new Date().toISOString(), timetable: tt };
    all.push(rec); writeTimetables(all);
    bumpCount();
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ Vision ============
app.get('/api/vision/:profileId', (req, res) => {
  const v = readVisions().find(x => x.profileId === req.params.profileId);
  if (!v) return res.status(404).json({ error: 'None yet.' });
  res.json(v);
});
app.post('/api/vision', async (req, res) => {
  const { profileId } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });
  const profile = readProfiles().find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
  if (!canGenerate()) return res.status(429).json({ error: 'Please wait.' });
  const tt = readTimetables().find(t => t.profileId === profileId);
  try {
    const r = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildVisionPrompt(profile, tt?.timetable || null) }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 2500, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Gemini error', details: e }); }
    const d = await r.json();
    const vision = parseGeminiJSON(d?.candidates?.[0]?.content?.parts?.[0]?.text);
    const all = readVisions().filter(v => v.profileId !== profileId);
    const rec = { profileId, generatedAt: new Date().toISOString(), vision };
    all.push(rec); writeVisions(all);
    bumpCount();
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ Exercises ============
function computeExerciseStatus(ex, submissions) {
  const subs = submissions.filter(s => s.exerciseId === ex.id);
  if (subs.length) {
    const best = Math.max(...subs.map(s => s.grading?.percentage ?? 0));
    const last = subs.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0];
    return { status: 'submitted', bestScore: best, lastAt: last.submittedAt, attemptCount: subs.length };
  }
  if (ex.dueAt) {
    const msLeft = new Date(ex.dueAt).getTime() - Date.now();
    if (msLeft <= 0) return { status: 'overdue', bestScore: null, lastAt: null, attemptCount: 0, msLeft: 0 };
    return { status: 'active', bestScore: null, lastAt: null, attemptCount: 0, msLeft };
  }
  return { status: 'active', bestScore: null, lastAt: null, attemptCount: 0, msLeft: null };
}

function publicExercise(ex) {
  return {
    id: ex.id, profileId: ex.profileId, subject: ex.subject, type: ex.type, difficulty: ex.difficulty,
    title: ex.title, instructions: ex.instructions, totalPoints: ex.totalPoints,
    durationMinutes: ex.durationMinutes || null, durationLabel: ex.durationLabel || null,
    dueAt: ex.dueAt || null, createdAt: ex.createdAt, assignedByAI: !!ex.assignedByAI,
    focusTopic: ex.focusTopic || null,
    questions: ex.questions.map(q => ({
      id: q.id, type: q.type, question: q.question, options: q.options, points: q.points
    }))
  };
}

async function generateExerciseForDecision({ profile, materialText, subject, params, focusTopic }) {
  const prompt = buildExercisePrompt({
    profile, document: materialText,
    subject, type: params.type, difficulty: params.difficulty,
    count: params.count, focusTopic
  });
  const r = await fetch(`${API_URL}?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens: 4000, responseMimeType: 'application/json' }
    })
  });
  if (!r.ok) throw new Error('Gemini exercise generation failed.');
  const d = await r.json();
  const parsed = parseGeminiJSON(d?.candidates?.[0]?.content?.parts?.[0]?.text);
  if (!Array.isArray(parsed.questions) || !parsed.questions.length) throw new Error('No questions returned.');

  const totalPts = parsed.questions.reduce((s, q) => s + (Number(q.points) || 0), 0);
  if (totalPts && totalPts !== 100) {
    const scale = 100 / totalPts;
    parsed.questions.forEach(q => q.points = Math.round((Number(q.points) || 0) * scale));
    const drift = 100 - parsed.questions.reduce((s, q) => s + q.points, 0);
    parsed.questions[parsed.questions.length - 1].points += drift;
  }

  const now = Date.now();
  const dueAt = params.durationMinutes ? new Date(now + params.durationMinutes * 60000).toISOString() : null;

  return {
    id: newId(), profileId: profile.id, subject, type: params.type, difficulty: params.difficulty,
    title: parsed.title || `${subject} — exercise`,
    instructions: parsed.instructions || 'Answer all questions.',
    questions: parsed.questions.map((q, i) => ({
      id: q.id || `q${i+1}`, type: q.type, question: q.question,
      options: q.options || null,
      correctIndex: typeof q.correctIndex === 'number' ? q.correctIndex : null,
      expectedAnswer: q.expectedAnswer || null,
      markingGuide: q.markingGuide || '',
      points: Number(q.points) || 0
    })),
    totalPoints: 100,
    durationMinutes: params.durationMinutes || null,
    durationLabel: params.durationLabel || null,
    dueAt,
    assignedByAI: true,
    focusTopic: focusTopic || null,
    createdAt: new Date().toISOString()
  };
}

app.get('/api/exercises/:profileId', (req, res) => {
  const exs = readExercises().filter(e => e.profileId === req.params.profileId);
  const subs = readSubmissions().filter(s => s.profileId === req.params.profileId);
  const list = exs
    .map(e => {
      const meta = computeExerciseStatus(e, subs);
      return {
        id: e.id, subject: e.subject, type: e.type, difficulty: e.difficulty,
        title: e.title, totalPoints: e.totalPoints, createdAt: e.createdAt,
        durationLabel: e.durationLabel, durationMinutes: e.durationMinutes,
        dueAt: e.dueAt, assignedByAI: e.assignedByAI,
        questionCount: e.questions.length,
        attemptCount: meta.attemptCount, bestScore: meta.bestScore,
        status: meta.status, msLeft: meta.msLeft ?? null
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ exercises: list });
});

app.get('/api/exercise/:id', (req, res) => {
  const ex = readExercises().find(e => e.id === req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found.' });
  res.json({ exercise: publicExercise(ex) });
});

app.post('/api/exercise/submit', async (req, res) => {
  const { exerciseId, answers } = req.body || {};
  if (!exerciseId || !answers) return res.status(400).json({ error: 'exerciseId and answers required.' });
  const exercise = readExercises().find(e => e.id === exerciseId);
  if (!exercise) return res.status(404).json({ error: 'Not found.' });
  const profile = readProfiles().find(p => p.id === exercise.profileId);
  if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
  if (!canGenerate()) return res.status(429).json({ error: 'Please wait.' });
  try {
    const r = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildTypedGradingPrompt({ profile, exercise, answers }) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Gemini error', details: e }); }
    const d = await r.json();
    const grading = parseGeminiJSON(d?.candidates?.[0]?.content?.parts?.[0]?.text);
    const rec = {
      id: newId(), exerciseId, profileId: exercise.profileId,
      submittedAt: new Date().toISOString(),
      answers, source: 'typed', grading
    };
    const all = readSubmissions(); all.push(rec); writeSubmissions(all);
    bumpCount();
    res.json({ submission: rec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exercise/submit-file', upload.single('file'), async (req, res) => {
  try {
    const { exerciseId } = req.body || {};
    if (!exerciseId || !req.file) return res.status(400).json({ error: 'exerciseId and file required.' });
    const exercise = readExercises().find(e => e.id === exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Not found.' });
    const profile = readProfiles().find(p => p.id === exercise.profileId);
    const extracted = await extractText(req.file.buffer, req.file.originalname);
    if (extracted.length < 20) return res.status(400).json({ error: 'No readable text.' });
    if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
    if (!canGenerate()) return res.status(429).json({ error: 'Please wait.' });
    const r = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildFileGradingPrompt({ profile, exercise, extractedText: extracted.slice(0, 40000) }) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 3000, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Gemini error', details: e }); }
    const d = await r.json();
    const grading = parseGeminiJSON(d?.candidates?.[0]?.content?.parts?.[0]?.text);
    const rec = {
      id: newId(), exerciseId, profileId: exercise.profileId,
      submittedAt: new Date().toISOString(),
      answers: null, source: 'upload', uploadedFileName: req.file.originalname, grading
    };
    const all = readSubmissions(); all.push(rec); writeSubmissions(all);
    bumpCount();
    res.json({ submission: rec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/submissions/:profileId', (req, res) => {
  res.json({ submissions: readSubmissions()
    .filter(s => s.profileId === req.params.profileId)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)) });
});

// ============ CHAT (teacher decision engine) ============
app.post('/api/chat', async (req, res) => {
  const { docId, materialId, message, history, profileId } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Message required.' });
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });

  const profile = readProfiles().find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
  if (!canGenerate()) return res.status(429).json({ error: 'Please wait a few seconds.' });

  // Resolve module text
  let moduleText = '', moduleTitle = '';
  if (docId) {
    const doc = documents.get(docId);
    if (doc) { moduleText = doc.text; moduleTitle = doc.name; }
  } else if (materialId) {
    const rec = readMaterials().find(m => m.profileId === profileId);
    const mat = rec?.materials.find(m => m.id === materialId);
    if (mat) { moduleText = mat.text; moduleTitle = mat.title; }
  }

  const teacherState = getTeacherState(profileId);
  const prompt = buildTeacherChatPrompt({
    profile, teacherState, moduleText, moduleTitle,
    history: history || [], message
  });

  try {
    const r = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 4000, responseMimeType: 'application/json' }
      })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Gemini error', details: e }); }
    const d = await r.json();
    const raw = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return res.status(500).json({ error: 'Empty response.' });

    let parsed;
    try { parsed = parseGeminiJSON(raw); }
    catch (e) {
      // Fallback: treat entire response as reply
      parsed = { reply: raw, decision: { learnedTopics: [], assignExercise: false, exerciseParams: null, announcement: null }, teacherNote: '' };
    }
    bumpCount();

    const reply = parsed.reply || '';
    const decision = parsed.decision || {};
    const teacherNote = parsed.teacherNote || '';

    // Update learned topics
    if (Array.isArray(decision.learnedTopics) && decision.learnedTopics.length) {
      for (const t of decision.learnedTopics) {
        if (!t.subject || !t.topic) continue;
        teacherState.learnedTopics.push({
          subject: t.subject, topic: t.topic, subtopic: t.subtopic || null,
          learnedAt: new Date().toISOString(),
          moduleId: materialId || null
        });
      }
    }
    if (teacherNote) teacherState.notes = teacherNote;

    // Announcement
    // Suggest Live Class
    if (decision.suggestLiveClass && decision.suggestLiveClass.suggest) {
      teacherState.pendingClassSuggestion = {
        topic: decision.suggestLiveClass.topic,
        message: decision.suggestLiveClass.message || "I think it's time for a deep dive. Let's do a live class!",
        at: new Date().toISOString(),
        scheduledAt: Date.now() + 5 * 60 * 1000 // 5 minutes from now
      };
    }

    let createdAnnouncement = null;
    if (decision.announcement && decision.announcement.trim()) {
      createdAnnouncement = {
        id: newId(),
        text: decision.announcement.trim(),
        at: new Date().toISOString(),
        seen: false
      };
      teacherState.announcements.push(createdAnnouncement);
      if (teacherState.announcements.length > 50) {
        teacherState.announcements = teacherState.announcements.slice(-50);
      }
    }

    // Auto-assign exercise if decided
    let createdExercise = null;
    if (decision.assignExercise && decision.exerciseParams) {
      const params = decision.exerciseParams;
      // Guard: must have learned something before assigning
      const hasLearned = teacherState.learnedTopics.length > 0;
      const lastExMs = teacherState.lastExerciseAt ? (Date.now() - new Date(teacherState.lastExerciseAt).getTime()) : Infinity;
      const cooldownOk = lastExMs > 10 * 60 * 1000;

      if (hasLearned && cooldownOk && params.type && params.durationMinutes) {
        try {
          const subject = params.subject || (teacherState.learnedTopics.at(-1)?.subject) || (profile.subjects?.[0]) || 'General';
          const ex = await generateExerciseForDecision({
            profile, materialText: moduleText,
            subject,
            params: {
              type: params.type,
              difficulty: params.difficulty || 'medium',
              count: params.count || 5,
              durationMinutes: params.durationMinutes,
              durationLabel: params.durationLabel || 'short'
            },
            focusTopic: params.focusTopic || null
          });
          const allEx = readExercises(); allEx.push(ex); writeExercises(allEx);
          teacherState.lastExerciseAt = new Date().toISOString();
          createdExercise = publicExercise(ex);
        } catch (e) {
          console.error('Auto exercise generation failed:', e);
        }
      }
    }

    saveTeacherState(teacherState);

    res.json({
      reply,
      decision: {
        learnedTopics: decision.learnedTopics || [],
        assignExercise: !!createdExercise,
        announcement: createdAnnouncement ? createdAnnouncement.text : null
      },
      exercise: createdExercise,
      announcements: teacherState.announcements.slice(-5)
    });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: 'Chat failed.', details: e.message });
  }
});

app.get('/api/usage', (req, res) => res.json({ used: readCount(), limit: DAILY_LIMIT }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));


// ============================================================
// ============ AVATARS ======================================
// ============================================================
app.post('/api/profile/:id/avatar', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const profile = readProfiles().find(p => p.id === id);
    if (!profile) return res.status(404).json({ error: 'Profile not found.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 2 MB).' });

    const mt = (req.file.mimetype || '').toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(mt)) {
      return res.status(400).json({ error: 'Please upload a PNG, JPG, or WebP image.' });
    }

    await store.writeBinary('avatars/' + id + '.png', req.file.buffer, 'avatar ' + id);

    const all = readProfiles();
    const idx = all.findIndex(p => p.id === id);
    if (idx >= 0) {
      all[idx].avatarUpdatedAt = new Date().toISOString();
      writeProfiles(all);
    }

    res.json({ ok: true, avatarUrl: '/api/profile/' + id + '/avatar?v=' + Date.now() });
  } catch (e) {
    console.error('Avatar upload error:', e);
    res.status(500).json({ error: 'Avatar upload failed.', details: e.message });
  }
});

app.get('/api/profile/:id/avatar', async (req, res) => {
  try {
    const buf = await store.readBinary('avatars/' + req.params.id + '.png');
    if (!buf) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch {
    res.status(500).end();
  }
});

app.delete('/api/profile/:id/avatar', async (req, res) => {
  try {
    await store.deleteBinary('avatars/' + req.params.id + '.png', 'remove avatar ' + req.params.id);
    const all = readProfiles();
    const idx = all.findIndex(p => p.id === req.params.id);
    if (idx >= 0) {
      delete all[idx].avatarUpdatedAt;
      writeProfiles(all);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ============ GITHUB BOOTSTRAP =============================
// ============================================================
async function bootstrapFromGitHub() {
  if (!store.ENABLED) {
    console.log('⚠️  GitHub sync disabled — missing GITHUB_TOKEN / OWNER / REPO.');
    return;
  }
  console.log('🔄 Bootstrapping from GitHub (' + store.OWNER + '/' + store.REPO + ')...');

  // Quick probe using our new curl wrapper
  try {
    const probe = await store.readFile('README.md').catch(() => null);
    // If it returns null (404) or a string, the API call succeeded
    console.log('   Token and repo verified.');
  } catch (e) {
    if (e.message.includes('401')) {
      console.error('❌ GitHub 401 — token is invalid or expired.');
      return;
    }
    if (e.message.includes('404')) {
      console.error('❌ GitHub 404 — token cannot see ' + store.OWNER + '/' + store.REPO);
      return;
    }
    console.error('⚠️  Could not verify token (network issue?):', e.message);
    console.error('   Proceeding with local cache — sync will retry in background.');
  }

  const files = ['profiles.json','materials.json','timetables.json','visions.json','exercises.json','submissions.json','teacher-states.json','classrooms.json'];
  let pulled = 0, pushed = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const rel = 'data/' + file;
    const localPath = path.join(DATA_DIR, file);
    try {
      const remote = await store.readFile(rel);
      const localRaw = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '[]';
      let localArr = [];
      try { localArr = JSON.parse(localRaw); } catch {}
      const localEmpty = !Array.isArray(localArr) || localArr.length === 0;

      if (remote && localEmpty) {
        fs.writeFileSync(localPath, remote);
        try { store.setCache(rel, JSON.parse(remote)); } catch {}
        pulled++;
      } else if (!remote && !localEmpty) {
        store.setCache(rel, localArr);
        store.queuePush(rel, localArr);
        pushed++;
      } else if (remote && !localEmpty) {
        store.setCache(rel, localArr);
        store.queuePush(rel, localArr);
        pushed++;
      } else {
        skipped++;
      }
    } catch (e) {
      failed++;
      console.error('   ⚠ ' + file + ': ' + e.message);
    }
  }

  await store.flush();
  console.log(`   Pulled: ${pulled}, Queued: ${pushed}, Empty: ${skipped}, Failed: ${failed}`);
  console.log('✅ Bootstrap complete.');
}

// ============================================================
// ============ LIVE CLASSROOM v3 (free-form drawing) =========
// ============================================================
const CLASSROOMS_FILE = path.join(DATA_DIR, 'classrooms.json');
if (!fs.existsSync(CLASSROOMS_FILE)) fs.writeFileSync(CLASSROOMS_FILE, '[]');
const readClassrooms  = () => readJSON(CLASSROOMS_FILE);
const writeClassrooms = (v) => writeJSON(CLASSROOMS_FILE, v);

const clamp = (v, min, max, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};
const safeStr = (v, max) => String(v || '').trim().slice(0, max);
const normPoint = (p, def) => {
  if (Array.isArray(p) && p.length === 2) return [clamp(p[0], 0, 300), clamp(p[1], 0, 200)];
  if (p && typeof p === 'object' && 'x' in p && 'y' in p) return [clamp(p.x, 0, 300), clamp(p.y, 0, 200)];
  return def;
};
const sanitizePath = (d) =>
  String(d || '').replace(/[^MLQCATZmlqcatz0-9eE,.\-\s]/g, '').slice(0, 500);

function normalizeSection(raw, layout) {
  const max = layout === 'three' ? 3 : layout === 'two' ? 2 : 1;
  const n = parseInt(raw, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), max);
}

function extractText(e) {
  if (!e || typeof e !== 'object') return '';
  for (const c of [e.text, e.content, e.label, e.body, e.line, e.lineText, e.value, e.title, e.caption]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function normalizeDraw(e) {
  const shape = (e.shape || '').toLowerCase();

  if (shape === 'line' || shape === 'arrow') {
    return {
      type: 'draw', shape,
      from: normPoint(e.from, [20, 100]),
      to: normPoint(e.to, [280, 100]),
      label: safeStr(e.label, 60),
      dashed: !!e.dashed
    };
  }

  if (shape === 'circle') {
    return {
      type: 'draw', shape: 'circle',
      cx: clamp(e.cx ?? e.x ?? 150, 0, 300, 150),
      cy: clamp(e.cy ?? e.y ?? 100, 0, 200, 100),
      r: clamp(e.r ?? 55, 15, 140, 55),
      label: safeStr(e.label, 40),
      fill: !!e.fill
    };
  }

  if (shape === 'ellipse') {
    return {
      type: 'draw', shape: 'ellipse',
      cx: clamp(e.cx ?? e.x ?? 150, 0, 300, 150),
      cy: clamp(e.cy ?? e.y ?? 100, 0, 200, 100),
      rx: clamp(e.rx ?? 70, 15, 140, 70),
      ry: clamp(e.ry ?? 40, 10, 100, 40),
      label: safeStr(e.label, 40)
    };
  }

  if (shape === 'curve') {
    const path = sanitizePath(e.path || e.d || '');
    if (!path) return null;
    return { type: 'draw', shape: 'curve', path, label: safeStr(e.label, 40) };
  }

  if (shape === 'polygon') {
    const points = Array.isArray(e.points) ? e.points.map(p => normPoint(p, [150, 100])) : [];
    if (points.length < 3) return null;
    return { type: 'draw', shape: 'polygon', points, label: safeStr(e.label, 40) };
  }

  if (shape === 'axes') {
    return {
      type: 'draw', shape: 'axes',
      xLabel: safeStr(e.xLabel || e.x, 20),
      yLabel: safeStr(e.yLabel || e.y, 20)
    };
  }

  if (shape === 'ruler') {
    return { type: 'draw', shape: 'ruler', min: clamp(e.min, 0, 50, 0), max: clamp(e.max, 0, 50, 15), unit: safeStr(e.unit, 5) };
  }

  if (shape === 'protractor') {
    return { type: 'draw', shape: 'protractor', angle: clamp(e.angle, 0, 180, 45) };
  }

  if (shape === 'numberline') {
    const min = clamp(e.min, -1000, 1000, 0);
    const max = clamp(e.max, -1000, 1000, 10);
    let marks = Array.isArray(e.marks) ? e.marks.slice(0, 12).map(n => clamp(n, min, max, min)) : [];
    if (!marks.length) {
      const step = (max - min) / 5;
      for (let i = 0; i <= 5; i++) marks.push(min + step * i);
    }
    return {
      type: 'draw', shape: 'numberline',
      min, max, marks,
      title: safeStr(e.title || e.label, 30)
    };
  }

  if (shape === 'venn') {
    const labels = Array.isArray(e.labels) ? e.labels.slice(0, 3).map(l => safeStr(l, 20)) : ['A', 'B'];
    return {
      type: 'draw', shape: 'venn',
      labels: labels.length >= 2 ? labels : ['A', 'B'],
      overlap: safeStr(e.overlap, 30)
    };
  }

  if (shape === 'cycle') {
    const rawNodes = e.nodes || e.items || [];
    const nodes = Array.isArray(rawNodes)
      ? rawNodes.slice(0, 6).map(n => typeof n === 'string' ? safeStr(n, 25) : safeStr(n.text || n.label, 25))
      : [];
    if (nodes.length < 2) return null;
    return { type: 'draw', shape: 'cycle', nodes };
  }

  return null;
}

function normalizeElement(e) {
  if (typeof e === 'string') {
    const t = e.trim().slice(0, 220);
    return t ? { type: 'text', text: t } : null;
  }
  if (!e || typeof e !== 'object') return null;

  const t = (e.type || 'text').toLowerCase();

  if (t === 'divider' || t === 'hr' || t === 'separator') return { type: 'divider' };

  if (t === 'draw' || t === 'shape' || t === 'sketch' || t === 'visual') {
    return normalizeDraw(e);
  }

  if (t === 'note' || t === 'caption' || t === 'annotation' || t === 'callout') {
    const text = extractText(e).slice(0, 120);
    if (!text) return null;
    return {
      type: 'note',
      text,
      accent: /warn|alert|danger/i.test(e.accent || '') ? 'warn' : 'info'
    };
  }

  if (t === 'diagram') {
    let nodes = e.nodes || e.items || e.steps || e.parts;
    if (!Array.isArray(nodes)) nodes = [];
    nodes = nodes
      .map(n => (typeof n === 'string' ? n : (n.text || n.label || n.name || '')))
      .map(n => String(n).trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 5);
    if (nodes.length < 2) return null;
    const shape = (e.shape || e.direction || '').toLowerCase() === 'tree' ? 'tree' : 'flow';
    return { type: 'diagram', shape, nodes };
  }

  if (t === 'arrow') {
    return { type: 'arrow', label: (extractText(e) || '').slice(0, 80) };
  }

  const text = extractText(e).slice(0, 220);
  if (!text) return null;
  let nt = 'text';
  if (t === 'title' || t === 'heading' || t === 'h1' || t === 'h2') nt = 'title';
  else if (t === 'underline' || t === 'emph' || t === 'emphasis' || t === 'highlight') nt = 'underline';
  else if (t === 'box' || t === 'key' || t === 'callout' || t === 'note') nt = 'box';
  return { type: nt, text };
}

function normalizeSegment(s, index, layout, isFinalHint) {
  if (!s) return null;
  if (typeof s === 'string') s = { kind: 'point', text: s };
  if (typeof s !== 'object') return null;

  const section = normalizeSection(s.section, layout);
  let elements = [];
  for (const arr of [s.elements, s.chalkLines, s.lines, s.items, s.content_array, s.bullets]) {
    if (Array.isArray(arr) && arr.length) {
      elements = arr.map(normalizeElement).filter(Boolean);
      if (elements.length) break;
    }
  }
  if (!elements.length) {
    const single = extractText(s);
    if (single) elements = [{ type: 'text', text: single.slice(0, 220) }];
  }
  const speech = String(s.speech || s.say || s.narration || s.explanation || s.commentary || '').slice(0, 800);
  if (!elements.length && speech) {
    const first = speech.split(/[.!?]/)[0].trim().slice(0, 60);
    if (first) elements = [{ type: 'text', text: first }];
  }

  const isFinal = !!isFinalHint || !!s.isFinal;

  if (!elements.length) {
    if (isFinal && speech) return { index, kind: 'summary', section, elements: [], speech, isFinal: true };
    return null;
  }

  const kind = ['title','point','example','diagram','summary'].includes(s.kind) ? s.kind : 'point';
  return { index, kind, section, elements, speech, isFinal };
}

function boardStateSummary(session) {
  if (!session) return '(empty board)';
  const layout = session.layout || 'single';
  const cols = layout === 'three' ? 3 : layout === 'two' ? 2 : 1;
  const lines = [];
  for (let s = 1; s <= cols; s++) {
    const segs = session.segments.filter(x => x.section === s);
    const count = segs.reduce((a, x) => a + x.elements.length, 0);
    const shapes = new Set();
    segs.forEach(x => x.elements.forEach(el => {
      if (el.type === 'draw') shapes.add(el.shape);
      else shapes.add(el.type);
    }));
    lines.push(`Section ${s}: ${count} element${count === 1 ? '' : 's'}${shapes.size ? ' (contains: ' + [...shapes].join(', ') + ')' : ''}`);
  }
  return lines.join('\n');
}

const DRAWING_KIT = `
DRAWING KIT — you can sketch real shapes (not just text):

{"type":"draw","shape":"circle","cx":150,"cy":100,"r":60,"label":"Cell","fill":false}
{"type":"draw","shape":"ellipse","cx":150,"cy":100,"rx":70,"ry":40,"label":"Orbit"}
{"type":"draw","shape":"arrow","from":[30,150],"to":[270,50],"label":"force","dashed":false}
{"type":"draw","shape":"line","from":[10,100],"to":[290,100],"dashed":true}
{"type":"draw","shape":"curve","path":"M10,100 Q75,20 150,100 T290,100","label":"sine wave"}
{"type":"draw","shape":"polygon","points":[[150,20],[280,180],[20,180]],"label":"triangle"}
{"type":"draw","shape":"axes","xLabel":"time","yLabel":"speed"}
{"type":"draw","shape":"ruler","min":0,"max":15,"unit":"cm"}
{"type":"draw","shape":"protractor","angle":45}
{"type":"draw","shape":"numberline","min":0,"max":10,"marks":[0,2,4,6,8,10],"title":"Number line"}
{"type":"draw","shape":"venn","labels":["A","B"],"overlap":"A∩B"}
{"type":"draw","shape":"cycle","nodes":["Evaporation","Condensation","Precipitation","Collection"]}
{"type":"note","text":"Key insight!","accent":"info"}

COORDINATE SYSTEM: 300 wide × 200 tall. (0,0) = top-left, (300,200) = bottom-right.
WHEN TO USE WHICH SHAPE:
- Water cycle / photosynthesis / rock cycle / nutrient cycles → "cycle"
- Set theory / comparisons / overlapping categories → "venn"
- Force, direction, motion, flow between two objects → "arrow"
- Triangle types, angle classification, geometry → "polygon"
- Wave / sine / projectile / arcs / oscillation → "curve"
- Cell, atom, planetary orbit, solar system → "circle" or "ellipse"
- Number operations, sequences, sets of integers → "numberline"
- Graphs (velocity-time, distance-time) → "axes"
- Multi-shape diagrams: combine multiple "draw" elements in one segment

PREFER DRAW over plain text whenever a shape teaches better than words.
You may combine multiple draws (e.g., two circles for comparison, a curve + arrows for direction).
`;

function buildAutoSchedulePrompt(profile, teacherState) {
  const now = new Date();
  const hour = now.getHours();
  let timeContext = "";
  let delayMins = 10; // Default: 10 mins from now

  if (hour >= 12 && hour < 14) {
    timeContext = "It is currently LUNCH TIME. Schedule the class to start in 60 minutes so they can eat.";
    delayMins = 60;
  } else if (hour >= 17 && hour < 19) {
    timeContext = "It is currently DINNER TIME. Schedule the class to start in 60 minutes.";
    delayMins = 60;
  } else if (hour >= 22 || hour < 6) {
    timeContext = "It is late at night. Schedule a brief review class for tomorrow morning (in 8 hours).";
    delayMins = 8 * 60;
  } else {
    timeContext = "Schedule the class to start in 10 minutes.";
  }

  return `You are an AI teacher. Determine the topic for the student's next Live Class.

${formatProfile(profile)}
${timeContext}
${getCurrentContext()}

Based on their materials and what they've learned, choose ONE specific topic.
Return ONLY JSON:
{
  "topic": "...",
  "reasoning": "...",
  "message": "A short, friendly notification message (e.g., 'I've prepared a Math class. Go grab a quick snack, we start soon!')"
}`;
}

function buildClassroomStartPrompt(profile, materials, teacherState, language) {
  const learned = (teacherState.learnedTopics || []).slice(-20).map(t =>
    `- ${t.subject}: ${t.topic}${t.subtopic ? ' → ' + t.subtopic : ''}`).join('\n') || '(nothing yet)';
  const mats = (materials || []).map(m =>
    `- ${m.subject} · "${m.title}" — topics: ${m.topics.map(t => t.name).join(', ')}`).join('\n') || '(no materials)';
  const examInfo = profile.examDate
    ? `Exam: ${profile.examDate} (${Math.round((new Date(profile.examDate + 'T00:00:00') - new Date()) / 86400000)} days away)`
    : 'No exam date.';

  const langRule = (language === 'ny') ? "!!! CRITICAL INSTRUCTION: YOU MUST OUTPUT ALL CHALKBOARD TEXT AND SPEECH IN CHICHEWA. DO NOT USE ENGLISH. TRANSLATE EVERYTHING. !!!\n\n" : "";
  return langRule + `You are starting a LIVE CLASS on a chalkboard. You decide the topic AND the board layout.

${formatProfile(profile)}

${getCurrentContext()}

STUDY MATERIALS:
${mats}

TOPICS ALREADY LEARNED:
${learned}

Today: ${new Date().toISOString().slice(0, 10)}
${examInfo}

STEP 1 — CHOOSE A TOPIC (specific, not vague).
STEP 2 — CHOOSE LAYOUT: "single" | "two" | "three"
STEP 3 — WRITE THE FIRST TWO SEGMENTS.
LANGUAGE RULE: If the user requests "Chichewa", you MUST write all chalk text and speech in Chichewa.

LANGUAGE & TOOLS:
- If the student asks for "Chichewa", you MUST write the chalkboard text and speech in Chichewa.
- You have a LIVE CALCULATOR tool. If you need to calculate something, add this element to your board: {"type":"tool","name":"calculator"}. The student will see it open on their screen. Teach them how to use it.

TEACHING STYLE (CRITICAL):
- Assume the student knows NOTHING about this topic. 
- Break down every concept into the absolute smallest steps.
- Explain *WHY* it works, not just *WHAT* it is.
- Use everyday analogies (e.g., "Think of an IP address like a house address").
- Write out definitions and important steps on the board; do not just speak them.
- End each segment with a gentle check-in question in the speech (e.g., "Does that make sense so far?").

TEXT ELEMENT TYPES (basic):
{"type":"title","text":"..."}
{"type":"text","text":"..."}
{"type":"underline","text":"..."}
{"type":"box","text":"..."}
{"type":"arrow","label":"..."}
{"type":"divider"}
{"type":"diagram","shape":"flow","nodes":["A","B","C"]}

${DRAWING_KIT}

CRITICAL RULES:
- "elements" array MUST have 3–6 items.
- MUST include at least one text or title element, plus any draws that help.
- DO NOT return an empty elements array.
- USE DRAWINGS AGGRESSIVELY for anything visual.
- LESSON LENGTH: A complete lesson should last at least 15 minutes. Do not summarize too early. Aim for 10 to 15 segments total.
- EXAMPLES: You MUST include a minimum of 3 and a maximum of 5 concrete, worked examples spread throughout the lesson.
- BREAKS: If the lesson is long, you may include exactly ONE segment with "kind": "break" in the middle (e.g., after 5 segments). The speech for this segment should be something like "Let's take a quick 2-minute stretch break, then we'll continue." The elements for a break can just be a title saying "Break Time!".

Return ONLY JSON (no markdown, no fences):
{
  "subject": "...",
  "topic": "...",
  "reasoning": "one sentence why you chose this",
  "layout": "single" | "two" | "three",
  "segments": [
    {"kind": "title", "section": 1, "elements": [ ... ], "speech": "..."},
    {"kind": "point", "section": 1, "elements": [ ... ], "speech": "..."}
  ]
}`;
}

function buildClassroomContinuePrompt(profile, session, language) {
  const past = session.segments.map((s, i) => {
    const els = s.elements.map(e => {
      if (e.text) return e.text;
      if (e.type === 'arrow') return `→[${e.label}]`;
      if (e.type === 'divider') return '—';
      if (e.type === 'diagram') return `[${e.shape}: ${e.nodes.join(' → ')}]`;
      if (e.type === 'draw') {
        if (e.shape === 'circle') return `[circle: ${e.label || ''}]`;
        if (e.shape === 'cycle') return `[cycle: ${e.nodes.join(' → ')}]`;
        if (e.shape === 'venn') return `[venn: ${e.labels.join(' ∩ ')}]`;
        return `[${e.shape}]`;
      }
      if (e.type === 'note') return `[note: ${e.text}]`;
      return '';
    }).filter(Boolean).join(' | ');
    return `Seg ${i + 1} (${s.kind}, sec ${s.section}): ${els} — said: "${(s.speech || '').slice(0, 100)}"`;
  }).join('\n');

  const langRule = (language === 'ny') ? "!!! CRITICAL INSTRUCTION: YOU MUST OUTPUT ALL CHALKBOARD TEXT AND SPEECH IN CHICHEWA. DO NOT USE ENGLISH. !!!\n\n" : "";
  return langRule + `You are continuing a LIVE CLASS.

${formatProfile(profile)}

${getCurrentContext()}

CLASS: ${session.subject} → ${session.topic}
LAYOUT: ${session.layout}

BOARD STATE:
${boardStateSummary(session)}

SEGMENTS SO FAR:
${past}

YOUR TASK:
Produce the NEXT segment. It should build on the existing content.

TEACHING STYLE (CRITICAL):
- Continue at a SLOW, deliberate pace. Do not rush to the end.
- Use simple language. Explain jargon immediately when you use it.
- Add a concrete example or analogy in every other segment.
- Check for understanding at the end of the spoken text.

TEXT ELEMENT TYPES:
{"type":"title","text":"..."}
{"type":"text","text":"..."}
{"type":"underline","text":"..."}
{"type":"box","text":"..."}
{"type":"arrow","label":"..."}
{"type":"divider"}
{"type":"diagram","shape":"flow","nodes":["A","B","C"]}

${DRAWING_KIT}

CRITICAL RULES:
- "elements" array MUST have 3–6 items.
- MUST include at least one text or title element.
- DO NOT return an empty elements array.
- Use drawings whenever a shape will teach better than words.
- LESSON LENGTH: A complete lesson should last at least 15 minutes (10 to 15 segments). Keep teaching thoroughly.
- EXAMPLES: Make sure you have provided at least 3-5 examples by the end.
- If the topic is thoroughly covered AND you have used multiple examples, set isFinal: true and make this a "summary" segment.

Return ONLY JSON (no markdown fences):
{
  "segment": {
    "kind": "title" | "point" | "example" | "diagram" | "summary",
    "section": 1,
    "elements": [ ... 3-6 elements ... ],
    "speech": "1-3 spoken sentences"
  },
  "isFinal": true | false
}`;
}

function buildSimpleContinuePrompt(session) {
  const lastMsg = session.segments.length ? (session.segments[session.segments.length - 1].speech || '') : '';
  return `Continue this lesson briefly.

Topic: ${session.topic}
Last: "${lastMsg.slice(0, 150)}"

Return this exact JSON shape (nothing else):
{"segment":{"kind":"point","section":1,"elements":[{"type":"text","text":"line 1"},{"type":"text","text":"line 2"},{"type":"text","text":"line 3"}],"speech":"One or two sentences."},"isFinal":false}`;
}

async function callGemini(prompt, maxTokens = 2000) {
  const r = await fetch(`${API_URL}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens: maxTokens, responseMimeType: 'application/json' }
    })
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Gemini ' + r.status + ': ' + e.slice(0, 200)); }
  const d = await r.json();
  return { raw: d?.candidates?.[0]?.content?.parts?.[0]?.text || '', parsed: parseGeminiJSON(d?.candidates?.[0]?.content?.parts?.[0]?.text || '') };
}

app.post('/api/classroom/start', async (req, res) => {
  const { profileId, language } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });
  const profile = readProfiles().find(p => p.id === profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
  if (!canGenerate()) return res.status(429).json({ error: 'Please wait a few seconds.' });

  const matRec = readMaterials().find(m => m.profileId === profileId);
  const materials = matRec ? matRec.materials : [];
  const teacherState = getTeacherState(profileId);

  try {
    const { parsed } = await callGemini(buildClassroomStartPrompt(profile, materials, teacherState, language), 3000);
    if (!Array.isArray(parsed.segments) || !parsed.segments.length) throw new Error('No segments.');
    const layout = ['single','two','three'].includes(parsed.layout) ? parsed.layout : 'single';
    const segments = parsed.segments.map((s, i) => normalizeSegment(s, i, layout)).filter(Boolean);
    if (!segments.length) throw new Error('No valid segments.');

    const session = {
      id: newId(), profileId, startedAt: new Date().toISOString(),
      subject: parsed.subject || 'General', topic: parsed.topic || 'Introduction',
      reasoning: parsed.reasoning || '', layout, segments, isComplete: false
    };
    bumpCount();
    const all = readClassrooms().filter(c => c.profileId !== profileId);
    all.push(session); writeClassrooms(all);
    res.json({ session });
  } catch (e) {
    console.error('Classroom start error:', e);
    res.status(500).json({ error: 'Failed to start class.', details: e.message });
  }
});

app.post('/api/classroom/next', async (req, res) => {
  const { profileId, language } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required.' });
  const all = readClassrooms();
  const session = all.find(c => c.profileId === profileId);
  if (!session) return res.status(404).json({ error: 'No active class.' });
  if (session.isComplete) return res.json({ segment: null, isFinal: true, session, gracefulEnd: true });
  if (readCount() >= DAILY_LIMIT) return res.status(429).json({ error: 'Daily limit reached (500).' });
  if (!canGenerate()) return res.status(429).json({ error: 'Please wait a few seconds.' });

  const profile = readProfiles().find(p => p.id === profileId);
  let seg = null, wasFinal = false;

  try {
    const { raw, parsed } = await callGemini(buildClassroomContinuePrompt(profile, session, language), 2500);
    wasFinal = !!parsed.isFinal;
    if (parsed.segment) seg = normalizeSegment(parsed.segment, session.segments.length, session.layout, wasFinal);
    if (!seg) console.error('[classroom/next] attempt 1 no usable segment. Raw:', raw.slice(0, 400));
  } catch (e) { console.error('[classroom/next] attempt 1 error:', e.message); }

  if (!seg) {
    try {
      const { raw, parsed } = await callGemini(buildSimpleContinuePrompt(session), 1200);
      if (parsed.segment) seg = normalizeSegment(parsed.segment, session.segments.length, session.layout, wasFinal);
      if (!seg) console.error('[classroom/next] attempt 2 no usable segment. Raw:', raw.slice(0, 400));
    } catch (e) { console.error('[classroom/next] attempt 2 error:', e.message); }
  }

  if (!seg) {
    session.isComplete = true;
    const updated = all.filter(c => c.profileId !== profileId);
    updated.push(session); writeClassrooms(updated);
    return res.json({ segment: null, isFinal: true, session, gracefulEnd: true });
  }

  session.segments.push(seg);
  if (seg.isFinal || wasFinal) {
    session.segments[session.segments.length - 1].isFinal = true;
    session.isComplete = true;
    const ts = getTeacherState(profileId);
    ts.learnedTopics.push({
      subject: session.subject, topic: session.topic, subtopic: null,
      learnedAt: new Date().toISOString(), moduleId: null, fromClassroom: true
    });
    saveTeacherState(ts);
  }

  const updated = all.filter(c => c.profileId !== profileId);
  updated.push(session); writeClassrooms(updated);
  bumpCount();
  res.json({
    segment: session.segments[session.segments.length - 1],
    isFinal: session.segments[session.segments.length - 1].isFinal,
    session
  });
});

app.get('/api/classroom/:profileId', (req, res) => {
  const s = readClassrooms().find(c => c.profileId === req.params.profileId);
  if (!s) return res.status(404).json({ error: 'No class.' });
  res.json({ session: s });
});

// ============================================================
// ============ GITHUB BOOTSTRAP =============================
// ============================================================
async function bootstrapFromGitHub() {
  if (!store.ENABLED) {
    console.log('⚠️  GitHub sync disabled — missing GITHUB_TOKEN / OWNER / REPO.');
    return;
  }
  console.log('🔄 Bootstrapping from GitHub (' + store.OWNER + '/' + store.REPO + ')...');

  try {
    const probe = await store.readFile('README.md').catch(() => null);
    console.log('   Token and repo verified.');
  } catch (e) {
    if (e.message.includes('401')) {
      console.error('❌ GitHub 401 — token is invalid or expired.');
      return;
    }
    if (e.message.includes('404')) {
      console.error('❌ GitHub 404 — token cannot see ' + store.OWNER + '/' + store.REPO);
      return;
    }
    console.error('⚠️  Could not verify token (network issue?):', e.message);
    console.error('   Proceeding with local cache — sync will retry in background.');
  }

  const files = ['profiles.json','materials.json','timetables.json','visions.json','exercises.json','submissions.json','teacher-states.json','classrooms.json'];
  let pulled = 0, pushed = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const rel = 'data/' + file;
    const localPath = path.join(DATA_DIR, file);
    try {
      const remote = await store.readFile(rel);
      const localRaw = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '[]';
      let localArr = [];
      try { localArr = JSON.parse(localRaw); } catch {}
      const localEmpty = !Array.isArray(localArr) || localArr.length === 0;

      if (remote && localEmpty) {
        fs.writeFileSync(localPath, remote);
        try { store.setCache(rel, JSON.parse(remote)); } catch {}
        pulled++;
      } else if (!remote && !localEmpty) {
        store.setCache(rel, localArr);
        store.queuePush(rel, localArr);
        pushed++;
      } else if (remote && !localEmpty) {
        store.setCache(rel, localArr);
        store.queuePush(rel, localArr);
        pushed++;
      } else {
        skipped++;
      }
    } catch (e) {
      failed++;
      console.error('   ⚠ ' + file + ': ' + e.message);
    }
  }

  await store.flush();
  console.log(`   Pulled: ${pulled}, Queued: ${pushed}, Empty: ${skipped}, Failed: ${failed}`);
  console.log('✅ Bootstrap complete.');
}

bootstrapFromGitHub().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Study Helper at http://localhost:${PORT}`);
    console.log(`   Model: ${MODEL}`);
    console.log(`   Data mirror: ${store.ENABLED ? store.OWNER + '/' + store.REPO : 'local only'}`);
  });
}).catch(e => {
  console.error('Bootstrap error:', e);
  app.listen(PORT, () => console.log(`✅ Study Helper (local only) at http://localhost:${PORT}`));
});

setInterval(() => store.flush().catch(() => {}), 15000);
process.on('SIGINT',  async () => { try { await store.flush(); } catch {} process.exit(0); });
process.on('SIGTERM', async () => { try { await store.flush(); } catch {} process.exit(0); });
