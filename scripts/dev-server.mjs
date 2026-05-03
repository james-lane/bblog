import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const vaultDir = join(root, '.local', 'vaults');
const portFlag = process.argv.findIndex((arg) => arg === '--port');
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const minAccessKeyLength = 18;
const instanceAccessKey = process.env.BBLOG_FAMILY_ACCESS_KEY || process.env.BBLOG_ACCESS_KEY || '';
const instanceFamilyId = familyIdForAccessKey(instanceAccessKey);

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

function deviceDir(familyId) {
  return join(vaultDir, familyId, 'devices');
}

function devicePath(familyId, deviceId) {
  return join(deviceDir(familyId), `${deviceId}.json`);
}

function etagFor(text) {
  return `"${createHash('sha256').update(text).digest('hex')}"`;
}

function normalizeAccessKey(accessKey) {
  return String(accessKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function familyIdForAccessKey(accessKey) {
  const normalized = normalizeAccessKey(accessKey);
  if (normalized.length < minAccessKeyLength) return '';
  return createHash('sha256').update(`bblog-family-v1:${normalized}`).digest('hex');
}

function validateInstanceFamily(res, familyId) {
  if (!instanceFamilyId) return true;

  if (familyId !== instanceFamilyId) {
    sendJson(res, 403, {
      error: 'instance_key_mismatch',
      message: 'That access key does not match this local bblog instance.',
    });
    return false;
  }

  return true;
}

async function readLocalVault(path, source) {
  if (!existsSync(path)) return null;
  const text = await readFile(path, 'utf8');
  return {
    source,
    pathname: path,
    etag: etagFor(text),
    uploadedAt: null,
    vault: JSON.parse(text),
  };
}

async function readDeviceVaults(familyId) {
  const dir = deviceDir(familyId);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const vaults = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readLocalVault(join(dir, name), 'device')),
  );
  return vaults.filter(Boolean);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function handleVault(req, res, url) {
  await mkdir(vaultDir, { recursive: true });

  if (req.method === 'GET') {
    if (url.searchParams.get('status') === '1') {
      sendJson(res, 200, {
        ok: true,
        instanceKeyConfigured: Boolean(instanceFamilyId),
        blobConfigured: true,
        syncConfigured: true,
        mode: 'local-dev',
        storage: '.local/vaults',
      });
      return;
    }

    const familyId = url.searchParams.get('familyId');
    const path = familyPath(familyId);
    if (!familyId || !/^[a-f0-9]{32,64}$/.test(familyId)) {
      sendJson(res, 200, { exists: false, vaults: [] });
      return;
    }
    if (!validateInstanceFamily(res, familyId)) return;

    const vaults = [
      await readLocalVault(path, 'legacy'),
      ...(await readDeviceVaults(familyId)),
    ].filter(Boolean);
    if (!vaults.length) {
      sendJson(res, 200, { exists: false, vaults: [] });
      return;
    }

    const latest = vaults.at(-1);
    sendJson(res, 200, {
      exists: true,
      etag: latest.etag,
      vault: latest.vault,
      vaults,
    });
    return;
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    const { familyId, baseEtag, deviceId, vault } = body;
    if (!familyId || !/^[a-f0-9]{32,64}$/.test(familyId) || !vault) {
      sendJson(res, 400, { error: 'invalid_vault' });
      return;
    }
    if (!validateInstanceFamily(res, familyId)) return;
    if (deviceId) {
      if (!/^[a-z0-9_-]{8,96}$/.test(deviceId)) {
        sendJson(res, 400, { error: 'invalid_device_id' });
        return;
      }
      await mkdir(deviceDir(familyId), { recursive: true });
      const text = JSON.stringify(vault);
      await writeFile(devicePath(familyId, deviceId), text, 'utf8');
      sendJson(res, 200, { ok: true, etag: etagFor(text), snapshot: true });
      return;
    }

    const path = familyPath(familyId);
    if (baseEtag && existsSync(path)) {
      const current = await readFile(path, 'utf8');
      if (etagFor(current) !== baseEtag) {
        sendJson(res, 409, { error: 'vault_conflict' });
        return;
      }
    } else if (!baseEtag && existsSync(path)) {
      sendJson(res, 409, { error: 'vault_conflict' });
      return;
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
