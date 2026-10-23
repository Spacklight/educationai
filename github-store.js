/* ============================================================
   github-store.js — mirror local data files to a GitHub repo
   (uses system curl to avoid Node fetch/TLS issues in Termux)
   ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const TOKEN  = process.env.GITHUB_TOKEN;
const OWNER  = process.env.GITHUB_OWNER;
const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const ENABLED = !!(TOKEN && OWNER && REPO);
const API = 'https://api.github.com';

const cache = new Map();
const pending = new Map();
let flushing = false;

function getCache(relPath) { return cache.get(relPath); }
function setCache(relPath, value) { cache.set(relPath, value); }
function queuePush(relPath, value) {
  if (!ENABLED) return;
  pending.set(relPath, value);
  flush().catch(() => {});
}

// ---- curl wrapper ----
async function ghCurl(method, apiPath, bodyObj) {
  const url = `${API}${apiPath}`;
  const args = [
    '-sS', '-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: study-helper',
    '-w', '\n%{http_code}',
    '--retry', '3',
    '--tlsv1.2',
    '-4' // force IPv4
  ];

  let tmpPath = null;
  if (bodyObj) {
    args.push('-H', 'Content-Type: application/json');
    tmpPath = path.join(os.tmpdir(), `gh-payload-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(bodyObj));
    args.push('-d', `@${tmpPath}`);
  }

  try {
    const { stdout } = await execFileAsync('curl', [...args, url], { maxBuffer: 10 * 1024 * 1024 });
    const lines = stdout.trim().split('\n');
    const statusCode = parseInt(lines.pop(), 10);
    const bodyStr = lines.join('\n');
    let json = null;
    if (bodyStr) {
      try { json = JSON.parse(bodyStr); } catch {}
    }
    return { status: statusCode, ok: statusCode >= 200 && statusCode < 300, json, text: bodyStr };
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

// ---- API functions ----
async function getSha(relPath) {
  const res = await ghCurl('GET', `/repos/${OWNER}/${REPO}/contents/${relPath}?ref=${BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('getSha ' + res.status);
  return res.json.sha;
}

async function readFile(relPath) {
  const res = await ghCurl('GET', `/repos/${OWNER}/${REPO}/contents/${relPath}?ref=${BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('readFile ' + res.status);
  return Buffer.from(res.json.content, 'base64').toString('utf8');
}

async function writeFile(relPath, content, message) {
  const sha = await getSha(relPath);
  const body = {
    message: message || `update ${relPath}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {})
  };
  const res = await ghCurl('PUT', `/repos/${OWNER}/${REPO}/contents/${relPath}`, body);
  if (!res.ok) {
    throw new Error('writeFile ' + res.status + ' ' + (res.text || '').slice(0, 200));
  }
}

async function readBinary(relPath) {
  const res = await ghCurl('GET', `/repos/${OWNER}/${REPO}/contents/${relPath}?ref=${BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('readBinary ' + res.status);
  return Buffer.from(res.json.content, 'base64');
}

async function writeBinary(relPath, buffer, message) {
  const sha = await getSha(relPath);
  const body = {
    message: message || `update ${relPath}`,
    content: buffer.toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {})
  };
  const res = await ghCurl('PUT', `/repos/${OWNER}/${REPO}/contents/${relPath}`, body);
  if (!res.ok) {
    throw new Error('writeBinary ' + res.status + ' ' + (res.text || '').slice(0, 200));
  }
}

async function deleteBinary(relPath, message) {
  const sha = await getSha(relPath);
  if (!sha) return;
  const res = await ghCurl('DELETE', `/repos/${OWNER}/${REPO}/contents/${relPath}`, {
    message: message || `delete ${relPath}`,
    sha,
    branch: BRANCH
  });
  if (!res.ok) throw new Error('deleteBinary ' + res.status);
}

async function flush() {
  if (flushing || !ENABLED || pending.size === 0) return;
  flushing = true;
  try {
    for (const [relPath, value] of [...pending.entries()]) {
      try {
        await writeFile(relPath, JSON.stringify(value, null, 2), `sync ${relPath}`);
        pending.delete(relPath);
      } catch (e) {
        if (e.message === 'OFFLINE') {
          // Silent — we will retry later when connection is back
        } else {
          console.error('GitHub sync failed:', e.message);
        }
      }
    }
  } finally {
    flushing = false;
  }
}

module.exports = {
  ENABLED, OWNER, REPO, BRANCH,
  getCache, setCache, queuePush,
  readFile, writeFile, readBinary, writeBinary, deleteBinary,
  flush
};
