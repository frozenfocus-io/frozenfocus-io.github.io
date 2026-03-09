// lab.notes — Netlify Function API v2
// KB + Docs as real markdown files in GitHub repo

const OWNER   = 'frozenfocus-io';
const REPO    = 'quartz';
const CONTENT = 'content';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

// ── GitHub helpers ──────────────────────────────────────────

function ghHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'labnotes-app'
  };
}

async function ghGet(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const res = await fetch(url, { headers: ghHeaders() });
  return res;
}

async function ghPut(path, content, sha, message) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const body = {
    message: message || `lab.notes: update ${path.split('/').pop()}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res;
}

async function ghDelete(path, sha, message) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || `lab.notes: delete ${path}`, sha })
  });
  return res;
}

// ── JSON data helpers (for projects) ───────────────────────

async function readJsonFile(relPath) {
  const res = await ghGet(`${CONTENT}/lab-data/${relPath}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const json = await res.json();
  const text = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  return { data: JSON.parse(text), sha: json.sha };
}

async function writeJsonFile(relPath, data, sha) {
  const content = JSON.stringify(data, null, 2);
  const fullPath = `${CONTENT}/lab-data/${relPath}`;
  const res = await ghPut(fullPath, content, sha, `lab.notes: update ${relPath}`);
  if (!res.ok) { const t = await res.text(); throw new Error(`GitHub write ${res.status}: ${t}`); }
  return true;
}

// ── Permissions ─────────────────────────────────────────────

function getPermissions() {
  try { return JSON.parse(process.env.PERMISSIONS_JSON || '{}'); }
  catch { return {}; }
}

function hasPerm(email, projectId, level) {
  if (!email) return false;
  if (email === process.env.OWNER_EMAIL) return true;
  const userPerms = getPermissions()[email] || {};
  const perm = userPerms[projectId] || userPerms['*'];
  if (!perm) return false;
  return level === 'r' ? ['r','rw'].includes(perm) : perm === 'rw';
}

// ── Handler ──────────────────────────────────────────────────

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const method = event.httpMethod;
  const qs = event.queryStringParameters || {};
  const user = context.clientContext && context.clientContext.user;
  const email = user ? user.email : null;
  const isOwner = email === process.env.OWNER_EMAIL;

  try {

    // ── GET ?action=me ──
    if (method === 'GET' && qs.action === 'me') {
      const perms = getPermissions();
      return ok({ email, isOwner, permissions: email ? (perms[email] || {}) : {} });
    }

    // ── GET ?action=list&path=Knowledge-Base → list folders ──
    if (method === 'GET' && qs.action === 'list') {
      const dirPath = `${CONTENT}/${qs.path || ''}`;
      const res = await ghGet(dirPath);
      if (res.status === 404) return ok({ items: [] });
      if (!res.ok) throw new Error(`list failed ${res.status}`);
      const items = await res.json();
      const folders = items.filter(i => i.type === 'dir').map(i => ({ name: i.name, path: i.path }));
      return ok({ items: folders });
    }

    // ── GET ?action=listfiles&path=Knowledge-Base/Category → list .md files ──
    if (method === 'GET' && qs.action === 'listfiles') {
      const dirPath = `${CONTENT}/${qs.path}`;
      const res = await ghGet(dirPath);
      if (res.status === 404) return ok({ items: [] });
      if (!res.ok) throw new Error(`listfiles failed ${res.status}`);
      const items = await res.json();
      const files = items
        .filter(i => i.type === 'file' && i.name.endsWith('.md') && i.name !== '.gitkeep')
        .map(i => ({ name: i.name, path: i.path, sha: i.sha }));
      return ok({ items: files });
    }

    // ── GET ?action=readfile&path=... → read file content + sha ──
    if (method === 'GET' && qs.action === 'readfile') {
      const res = await ghGet(qs.path);
      if (res.status === 404) return ok({ content: null, sha: null });
      if (!res.ok) throw new Error(`readfile failed ${res.status}`);
      const json = await res.json();
      const content = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf-8');
      return ok({ content, sha: json.sha });
    }

    // ── GET ?key=projects → legacy JSON read ──
    if (method === 'GET' && qs.key) {
      const result = await readJsonFile(`${qs.key}.json`);
      return ok({ data: result ? result.data : null });
    }

    // ── POST → write operations (auth required) ──
    if (method === 'POST') {
      if (!email) return err(401, 'Login erforderlich');
      const body = JSON.parse(event.body || '{}');
      const { action } = body;

      // Write JSON file (projects)
      if (!action || action === 'writejson') {
        const { key, data, projectId } = body;
        if (!key || data === undefined) return err(400, 'key und data erforderlich');
        if (!isOwner && !hasPerm(email, projectId || '*', 'rw')) return err(403, 'Kein Schreibzugriff');
        const existing = await readJsonFile(`${key}.json`);
        await writeJsonFile(`${key}.json`, data, existing ? existing.sha : null);
        return ok({ ok: true });
      }

      // Write markdown file
      if (action === 'writefile') {
        const { path, content, sha, projectId } = body;
        if (!path || content === undefined) return err(400, 'path und content erforderlich');
        if (!isOwner && !hasPerm(email, projectId || '*', 'rw')) return err(403, 'Kein Schreibzugriff');
        const res = await ghPut(path, content, sha || null);
        if (!res.ok) { const t = await res.text(); throw new Error(`writefile ${res.status}: ${t}`); }
        const json = await res.json();
        return ok({ ok: true, sha: json.content.sha });
      }

      // Delete file
      if (action === 'deletefile') {
        const { path, sha, projectId } = body;
        if (!path || !sha) return err(400, 'path und sha erforderlich');
        if (!isOwner && !hasPerm(email, projectId || '*', 'rw')) return err(403, 'Kein Schreibzugriff');
        const res = await ghDelete(path, sha);
        if (!res.ok && res.status !== 404) { const t = await res.text(); throw new Error(`deletefile ${res.status}: ${t}`); }
        return ok({ ok: true });
      }

      // Create folder (via .gitkeep)
      if (action === 'createfolder') {
        const { path, projectId } = body;
        if (!path) return err(400, 'path erforderlich');
        if (!isOwner && !hasPerm(email, projectId || '*', 'rw')) return err(403, 'Kein Schreibzugriff');
        const keepPath = `${path}/.gitkeep`;
        const res = await ghPut(keepPath, '', null, `lab.notes: create folder ${path}`);
        // 422 = already exists, that's fine
        return ok({ ok: true });
      }

      // Delete folder (delete all files in it)
      if (action === 'deletefolder') {
        const { path, projectId } = body;
        if (!path) return err(400, 'path erforderlich');
        if (!isOwner && !hasPerm(email, projectId || '*', 'rw')) return err(403, 'Kein Schreibzugriff');
        const listRes = await ghGet(path);
        if (listRes.ok) {
          const items = await listRes.json();
          for (const item of items) {
            if (item.type === 'file') await ghDelete(item.path, item.sha, `lab.notes: delete ${item.name}`);
          }
        }
        return ok({ ok: true });
      }

      return err(400, 'Unbekannte action');
    }

    return err(404, 'Not found');

  } catch (e) {
    console.error('API error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

function ok(data) { return { statusCode: 200, headers: CORS, body: JSON.stringify(data) }; }
function err(code, msg) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }
