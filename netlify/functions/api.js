// lab.notes — Netlify Function API
// Proxies read/write to GitHub repo with auth + permissions

const OWNER     = 'frozenfocus-io';
const REPO      = 'quartz';
const DATA_BASE = 'content/lab-data';
const GH_TOKEN  = process.env.GITHUB_TOKEN;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ── GitHub helpers ──────────────────────────────────────────

async function ghFetch(path, opts = {}) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'labnotes-app',
      ...(opts.headers || {})
    }
  });
}

async function readFile(relPath) {
  const res = await ghFetch(`${DATA_BASE}/${relPath}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const json = await res.json();
  const text = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  return { data: JSON.parse(text), sha: json.sha };
}

async function writeFile(relPath, data, sha, msg) {
  const res = await ghFetch(`${DATA_BASE}/${relPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: msg || `lab.notes: update ${relPath}`,
      content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
      ...(sha ? { sha } : {})
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub write ${res.status}: ${txt}`);
  }
  return true;
}

// ── Permissions ─────────────────────────────────────────────
// Stored as env var PERMISSIONS_JSON:
// {
//   "friend@example.com": { "proj-esc": "r", "proj-rc": "rw" },
//   "teammate@example.com": { "*": "rw" }
// }

function getPermissions() {
  try { return JSON.parse(process.env.PERMISSIONS_JSON || '{}'); }
  catch { return {}; }
}

function hasPerm(perms, email, projectId, level) {
  if (!email) return false;
  if (email === OWNER_EMAIL) return true; // owner has everything
  const userPerms = perms[email] || {};
  const perm = userPerms[projectId] || userPerms['*'];
  if (!perm) return false;
  return level === 'r' ? ['r','rw'].includes(perm) : perm === 'rw';
}

// ── Handler ──────────────────────────────────────────────────

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const method = event.httpMethod;
  const qs = event.queryStringParameters || {};

  // Get Netlify Identity user
  const user = context.clientContext && context.clientContext.user;
  const email = user ? user.email : null;

  try {

    // ── GET ?action=me → user info & permissions ──
    if (method === 'GET' && qs.action === 'me') {
      const perms = getPermissions();
      const userPerms = email ? (perms[email] || {}) : {};
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          email,
          isOwner: email === OWNER_EMAIL,
          permissions: userPerms
        })
      };
    }

    // ── GET ?key=<name> → read data file ──
    if (method === 'GET' && qs.key) {
      const result = await readFile(`${qs.key}.json`);
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ data: result ? result.data : null })
      };
    }

    // ── POST → write data file (auth required) ──
    if (method === 'POST') {
      if (!email) return {
        statusCode: 401, headers: CORS,
        body: JSON.stringify({ error: 'Login erforderlich' })
      };

      const body = JSON.parse(event.body || '{}');
      const { key, data, projectId } = body;

      if (!key || data === undefined) return {
        statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: 'key und data erforderlich' })
      };

      const perms = getPermissions();

      // Project-specific write: check project permission
      if (projectId) {
        if (!hasPerm(perms, email, projectId, 'rw')) return {
          statusCode: 403, headers: CORS,
          body: JSON.stringify({ error: `Kein Schreibzugriff auf Projekt ${projectId}` })
        };
      } else {
        // Global data (projects list, docs list, kb): only owner or wildcard rw
        if (email !== OWNER_EMAIL && !hasPerm(perms, email, '*', 'rw')) return {
          statusCode: 403, headers: CORS,
          body: JSON.stringify({ error: 'Kein Schreibzugriff' })
        };
      }

      const existing = await readFile(`${key}.json`);
      await writeFile(`${key}.json`, data, existing ? existing.sha : null);

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Not found' }) };

  } catch (err) {
    console.error('API error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
