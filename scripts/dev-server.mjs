import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const vaultDir = join(root, '.local', 'vaults');
const portFlag = process.argv.findIndex((arg) => arg === '--port');
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function familyPath(familyId) {
  return join(vaultDir, `${familyId}.json`);
}

function etagFor(text) {
  return `"${createHash('sha256').update(text).digest('hex')}"`;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function handleVault(req, res, url) {
  await mkdir(vaultDir, { recursive: true });

  if (req.method === 'GET') {
    const familyId = url.searchParams.get('familyId');
    const path = familyPath(familyId);
    if (!familyId || !/^[a-f0-9]{32,64}$/.test(familyId) || !existsSync(path)) {
      sendJson(res, 200, { exists: false });
      return;
    }
    const text = await readFile(path, 'utf8');
    sendJson(res, 200, {
      exists: true,
      etag: etagFor(text),
      vault: JSON.parse(text),
    });
    return;
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    const { familyId, baseEtag, vault } = body;
    if (!familyId || !/^[a-f0-9]{32,64}$/.test(familyId) || !vault) {
      sendJson(res, 400, { error: 'invalid_vault' });
      return;
    }
    const path = familyPath(familyId);
    if (baseEtag && existsSync(path)) {
      const current = await readFile(path, 'utf8');
      if (etagFor(current) !== baseEtag) {
        sendJson(res, 409, { error: 'vault_conflict' });
        return;
      }
    }
    const text = JSON.stringify(vault);
    await writeFile(path, text, 'utf8');
    sendJson(res, 200, { ok: true, etag: etagFor(text) });
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
}

async function serveStatic(req, res, url) {
  const cleanPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(cleanPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) filePath = join(publicDir, 'index.html');

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': cleanPath === '/sw.js' ? 'no-store' : 'public, max-age=60',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  } catch {
    const body = await readFile(join(publicDir, 'index.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/vault') {
      await handleVault(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: 'dev_server_error', message: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`bblog dev server running at http://${host}:${port}`);
});
