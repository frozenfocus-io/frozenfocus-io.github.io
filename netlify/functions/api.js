const https = require('https');

const OWNER = 'frozenfocus-io';
const REPO  = 'quartz';
const BRANCH = 'main';
const TOKEN  = process.env.GITHUB_TOKEN;
const OWNER_EMAIL = process.env.OWNER_EMAIL || '';

// ── GitHub API helper ──────────────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/contents/${path}`,
      method,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'User-Agent':    'lab-notes-api',
        'Accept':        'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function ghList(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${TOKEN}`,
        'User-Agent':    'lab-notes-api',
        'Accept':        'application/vnd.github.v3+json'
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: [] }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Auth helper ────────────────────────────────────────────────────
async function getUser(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  // Decode JWT payload (no verification needed — Netlify Identity already validated it)
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return { email: payload.email, sub: payload.sub };
  } catch(e) { return null; }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

// ── Main handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});

  const user = await getUser(event);
  const isOwner = !!(user && OWNER_EMAIL && user.email === OWNER_EMAIL);

  // ── GET actions ──
  if (event.httpMethod === 'GET') {
    const { action, path, key } = event.queryStringParameters || {};

    // /api?action=me
    if (action === 'me') {
      return respond(200, { email: user?.email || null, isOwner, permissions: {} });
    }

   
    // /api?key=<anything>

if (key) {
  const res = await ghRequest('GET', `content/lab-data/${key}.json?ref=${BRANCH}`);
  if (res.status === 200 && res.body.content) {
    const data = JSON.parse(Buffer.from(res.body.content, 'base64').toString());
    return respond(200, { data, sha: res.body.sha });
  }
  return respond(200, { data: null, sha: null });
}

    // /api?action=list&path=Knowledge-Base
    if (action === 'list') {
      const res = await ghList(`content/${path}`);
      if (res.status !== 200 || !Array.isArray(res.body)) return respond(200, { items: [] });
      const items = res.body
        .filter(f => f.type === 'dir' && !f.name.startsWith('.'))
        .map(f => ({ name: f.name, path: f.path }));
      return respond(200, { items });
    }

    // /api?action=listfiles&path=Knowledge-Base/Kategorie
    if (action === 'listfiles') {
      const res = await ghList(`content/${path}`);
      if (res.status !== 200 || !Array.isArray(res.body)) return respond(200, { items: [] });
      const items = res.body
        .filter(f => f.type === 'file')
        .map(f => ({ name: f.name, path: f.path, sha: f.sha }));
      return respond(200, { items });
    }

    // /api?action=readfile&path=content/...
    if (action === 'readfile') {
      const res = await ghRequest('GET', `${path}?ref=${BRANCH}`);
      if (res.status === 200 && res.body.content) {
        const content = Buffer.from(res.body.content, 'base64').toString('utf8');
        return respond(200, { content, sha: res.body.sha });
      }
      return respond(200, { content: null, sha: null });
    }

    return respond(400, { error: 'Unknown action' });
  }

  // ── POST actions ──
  if (event.httpMethod === 'POST') {
    if (!isOwner) return respond(403, { error: 'Forbidden' });

    let body;
    try { body = JSON.parse(event.body); } catch(e) { return respond(400, { error: 'Invalid JSON' }); }

    const { action, path, content, sha, key, data, isBinary } = body;

    // writefile — supports both text (base64-encoded by GitHub) and binary (already base64)
    if (action === 'writefile') {
      let encodedContent;
      if (isBinary) {
        // content is already raw base64 (from FileReader.readAsDataURL, stripped prefix)
        encodedContent = content;
      } else {
        // text content — encode to base64 for GitHub API
        encodedContent = Buffer.from(content, 'utf8').toString('base64');
      }
      const payload = { message: `lab.notes: update ${path}`, content: encodedContent, branch: BRANCH };
      if (sha) payload.sha = sha;
      const res = await ghRequest('PUT', path, payload);
      if (res.status === 200 || res.status === 201) {
        return respond(200, { sha: res.body.content?.sha, ok: true });
      }
      return respond(500, { error: 'Write failed', detail: res.body });
    }

    // writejson
    if (action === 'writejson') {
      const filePath = key === 'projects' ? 'content/lab-data/projects.json' : `content/lab-data/${key}.json`;
      const encodedContent = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
      // get current sha
      const current = await ghRequest('GET', `${filePath}?ref=${BRANCH}`);
      const currentSha = current.status === 200 ? current.body.sha : null;
      const payload = { message: `lab.notes: update ${key}`, content: encodedContent, branch: BRANCH };
      if (currentSha) payload.sha = currentSha;
      const res = await ghRequest('PUT', filePath, payload);
      if (res.status === 200 || res.status === 201) return respond(200, { ok: true });
      return respond(500, { error: 'Write failed' });
    }

    // deletefile
    if (action === 'deletefile') {
      const payload = { message: `lab.notes: delete ${path}`, sha, branch: BRANCH };
      const res = await ghRequest('DELETE', path, payload);
      if (res.status === 200) return respond(200, { ok: true });
      return respond(500, { error: 'Delete failed' });
    }

    // createfolder — create a .gitkeep inside the folder
    if (action === 'createfolder') {
      const gitkeepPath = `${path}/.gitkeep`;
      const encodedContent = Buffer.from('', 'utf8').toString('base64');
      const payload = { message: `lab.notes: create folder ${path}`, content: encodedContent, branch: BRANCH };
      const res = await ghRequest('PUT', gitkeepPath, payload);
      if (res.status === 200 || res.status === 201) return respond(200, { ok: true });
      return respond(500, { error: 'Create folder failed' });
    }

    // deletefolder — list all files in folder and delete each
    if (action === 'deletefolder') {
      const res = await ghList(path);
      if (res.status !== 200 || !Array.isArray(res.body)) return respond(200, { ok: true });
      await Promise.all(res.body.map(async f => {
        if (f.type === 'file') {
          await ghRequest('DELETE', f.path, { message: `lab.notes: delete ${f.path}`, sha: f.sha, branch: BRANCH });
        }
      }));
      return respond(200, { ok: true });
    }

    return respond(400, { error: 'Unknown action' });
  }

  return respond(405, { error: 'Method not allowed' });
};
