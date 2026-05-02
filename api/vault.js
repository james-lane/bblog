import { get, put } from '@vercel/blob';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FAMILY_RE = /^[a-f0-9]{32,64}$/;
const VAULT_PREFIX = 'bblog/v1/vaults';

function vaultPath(familyId) {
  return `${VAULT_PREFIX}/${familyId}.json`;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function validateFamilyId(familyId) {
  return typeof familyId === 'string' && FAMILY_RE.test(familyId);
}

async function readRequestJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body is too large.');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function streamToText(stream) {
  return new Response(stream).text();
}

function isBlobMissing(error) {
  return (
    error?.name === 'BlobNotFoundError' ||
    error?.status === 404 ||
    error?.statusCode === 404 ||
    /not found/i.test(error?.message ?? '')
  );
}

function isPreconditionFailed(error) {
  return (
    error?.name === 'BlobPreconditionFailedError' ||
    error?.status === 412 ||
    error?.statusCode === 412 ||
    /precondition/i.test(error?.message ?? '')
  );
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://bblog.local');
      if (url.searchParams.get('status') === '1') {
        sendJson(res, 200, {
          ok: true,
          syncConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
          mode: process.env.BLOB_READ_WRITE_TOKEN ? 'cloud' : 'local-only',
          storage: 'vercel-blob',
        });
        return;
      }

      const familyId = url.searchParams.get('familyId');
      if (!validateFamilyId(familyId)) {
        sendJson(res, 400, { error: 'invalid_family_id' });
        return;
      }

      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 200, {
          exists: false,
          syncDisabled: true,
          message: 'Cloud sync is not configured. The app is running in local-only mode.',
        });
        return;
      }

      try {
        const result = await get(vaultPath(familyId), { access: 'private' });
        if (!result || result.statusCode !== 200) {
          sendJson(res, 200, { exists: false });
          return;
        }

        const text = await streamToText(result.stream);
        sendJson(res, 200, {
          exists: true,
          etag: result.blob.etag,
          vault: JSON.parse(text),
        });
      } catch (error) {
        if (isBlobMissing(error)) {
          sendJson(res, 200, { exists: false });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const { familyId, baseEtag, vault } = body;
      if (!validateFamilyId(familyId) || !vault || typeof vault !== 'object') {
        sendJson(res, 400, { error: 'invalid_vault' });
        return;
      }

      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 200, {
          ok: false,
          syncDisabled: true,
          message: 'Cloud sync is not configured. The app is running in local-only mode.',
        });
        return;
      }

      const blob = await put(vaultPath(familyId), JSON.stringify(vault), {
        access: 'private',
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType: 'application/json; charset=utf-8',
        ...(baseEtag ? { ifMatch: baseEtag } : {}),
      });

      sendJson(res, 200, { ok: true, etag: blob.etag });
      return;
    }

    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    if (isPreconditionFailed(error)) {
      sendJson(res, 409, { error: 'vault_conflict' });
      return;
    }

    sendJson(res, error.statusCode || 500, {
      error: 'vault_error',
      message: error.message || 'Unexpected vault storage error.',
    });
  }
}
