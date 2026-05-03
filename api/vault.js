import { createHash } from 'node:crypto';
import { get, list, put } from '@vercel/blob';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FAMILY_RE = /^[a-f0-9]{32,64}$/;
const VAULT_PREFIX = 'bblog/v1/vaults';
const MIN_ACCESS_KEY_LENGTH = 18;
const INSTANCE_ACCESS_KEY = process.env.BBLOG_FAMILY_ACCESS_KEY || process.env.BBLOG_ACCESS_KEY || '';
const INSTANCE_FAMILY_ID = familyIdForAccessKey(INSTANCE_ACCESS_KEY);

function vaultPath(familyId) {
  return `${VAULT_PREFIX}/${familyId}.json`;
}

function snapshotPrefix(familyId) {
  return `${VAULT_PREFIX}/${familyId}/devices/`;
}

function snapshotPath(familyId, deviceId) {
  return `${snapshotPrefix(familyId)}${deviceId}.json`;
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

function validateDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[a-z0-9_-]{8,96}$/.test(deviceId);
}

function normalizeAccessKey(accessKey) {
  return String(accessKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function familyIdForAccessKey(accessKey) {
  const normalized = normalizeAccessKey(accessKey);
  if (normalized.length < MIN_ACCESS_KEY_LENGTH) return '';
  return createHash('sha256').update(`bblog-family-v1:${normalized}`).digest('hex');
}

function validateInstanceFamily(res, familyId) {
  if (!INSTANCE_FAMILY_ID) {
    sendJson(res, 428, {
      error: 'instance_key_required',
      message: 'This bblog deployment is not configured. Set BBLOG_FAMILY_ACCESS_KEY before joining.',
    });
    return false;
  }

  if (familyId !== INSTANCE_FAMILY_ID) {
    sendJson(res, 403, {
      error: 'instance_key_mismatch',
      message: 'That access key does not match this deployed bblog instance.',
    });
    return false;
  }

  return true;
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

async function readVaultBlob(pathname, source) {
  const result = await get(pathname, { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200) return null;
  const text = await streamToText(result.stream);
  return {
    source,
    pathname,
    etag: result.blob.etag,
    uploadedAt: result.blob.uploadedAt,
    vault: JSON.parse(text),
  };
}

async function listSnapshotBlobs(familyId) {
  const blobs = [];
  let cursor;

  do {
    const page = await list({
      prefix: snapshotPrefix(familyId),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  return blobs;
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
    error?.status === 409 ||
    error?.statusCode === 412 ||
    error?.statusCode === 409 ||
    /already exists/i.test(error?.message ?? '') ||
    /conflict/i.test(error?.message ?? '') ||
    /overwrite/i.test(error?.message ?? '') ||
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
        const instanceKeyConfigured = Boolean(INSTANCE_FAMILY_ID);
        const blobConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
        sendJson(res, 200, {
          ok: true,
          instanceKeyConfigured,
          blobConfigured,
          syncConfigured: instanceKeyConfigured && blobConfigured,
          mode: !instanceKeyConfigured ? 'setup-required' : blobConfigured ? 'cloud' : 'local-only',
          storage: 'vercel-blob',
        });
        return;
      }

      const familyId = url.searchParams.get('familyId');
      if (!validateFamilyId(familyId)) {
        sendJson(res, 400, { error: 'invalid_family_id' });
        return;
      }
      if (!validateInstanceFamily(res, familyId)) return;

      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 200, {
          exists: false,
          syncDisabled: true,
          message: 'Cloud storage is not configured. This bblog instance can be used on one device; connect Vercel Blob before sharing.',
        });
        return;
      }

      try {
        const vaults = [];
        const legacyVault = await readVaultBlob(vaultPath(familyId), 'legacy');
        if (legacyVault) vaults.push(legacyVault);

        const snapshots = await listSnapshotBlobs(familyId);
        const snapshotVaults = await Promise.all(
          snapshots.map((blob) => readVaultBlob(blob.pathname, 'device').catch(() => null)),
        );
        vaults.push(...snapshotVaults.filter(Boolean));

        vaults.sort((a, b) => new Date(a.uploadedAt || 0) - new Date(b.uploadedAt || 0));

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
      } catch (error) {
        if (isBlobMissing(error)) {
          sendJson(res, 200, { exists: false, vaults: [] });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const { familyId, baseEtag, deviceId, vault } = body;
      if (!validateFamilyId(familyId) || !vault || typeof vault !== 'object') {
        sendJson(res, 400, { error: 'invalid_vault' });
        return;
      }
      if (!validateInstanceFamily(res, familyId)) return;

      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 200, {
          ok: false,
          syncDisabled: true,
          message: 'Cloud storage is not configured. This bblog instance can be used on one device; connect Vercel Blob before sharing.',
        });
        return;
      }

      if (deviceId) {
        if (!validateDeviceId(deviceId)) {
          sendJson(res, 400, { error: 'invalid_device_id' });
          return;
        }

        const blob = await put(snapshotPath(familyId, deviceId), JSON.stringify(vault), {
          access: 'private',
          allowOverwrite: true,
          cacheControlMaxAge: 60,
          contentType: 'application/json; charset=utf-8',
        });

        sendJson(res, 200, { ok: true, etag: blob.etag, snapshot: true });
        return;
      }

      const blob = await put(vaultPath(familyId), JSON.stringify(vault), {
        access: 'private',
        allowOverwrite: Boolean(baseEtag),
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
