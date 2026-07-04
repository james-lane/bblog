const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FAMILY_RE = /^[a-f0-9]{32,64}$/;
const DEVICE_RE = /^[a-z0-9_-]{8,96}$/;
const VAULT_PREFIX = 'bblog/v1/vaults';
const MIN_ACCESS_KEY_LENGTH = 18;

function vaultPath(familyId) {
  return `${VAULT_PREFIX}/${familyId}.json`;
}

function snapshotPrefix(familyId) {
  return `${VAULT_PREFIX}/${familyId}/devices/`;
}

function snapshotPath(familyId, deviceId) {
  return `${snapshotPrefix(familyId)}${deviceId}.json`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function emptyResponse(status = 204, headers = {}) {
  return new Response(null, { status, headers });
}

function normalizeAccessKey(accessKey) {
  return String(accessKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(digest);
}

async function familyIdForAccessKey(accessKey) {
  const normalized = normalizeAccessKey(accessKey);
  if (normalized.length < MIN_ACCESS_KEY_LENGTH) return '';
  return sha256Hex(`bblog-family-v1:${normalized}`);
}

async function instanceFamilyId(env) {
  return familyIdForAccessKey(
    env.BBLOG_FAMILY_ACCESS_KEY || env.BBLOG_ACCESS_KEY || '',
  );
}

async function validateInstanceFamily(env, familyId) {
  const configuredFamilyId = await instanceFamilyId(env);
  if (!configuredFamilyId) {
    return jsonResponse(
      {
        error: 'instance_key_required',
        message:
          'This bblog deployment is not configured. Set BBLOG_FAMILY_ACCESS_KEY before joining.',
      },
      428,
    );
  }

  if (familyId !== configuredFamilyId) {
    return jsonResponse(
      {
        error: 'instance_key_mismatch',
        message: 'That access key does not match this deployed bblog instance.',
      },
      403,
    );
  }

  return null;
}

async function readRequestJson(request) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    const error = new Error('Request body is too large.');
    error.statusCode = 413;
    throw error;
  }
  return body.byteLength
    ? JSON.parse(new TextDecoder().decode(body))
    : {};
}

function storageConfigured(env) {
  return Boolean(env.BBLOG_BUCKET);
}

async function readVaultObject(bucket, key, source) {
  const object = await bucket.get(key);
  if (!object) return null;
  return {
    source,
    pathname: key,
    etag: object.httpEtag,
    uploadedAt: object.uploaded ? object.uploaded.toISOString() : null,
    vault: JSON.parse(await object.text()),
  };
}

async function listSnapshotObjects(bucket, familyId) {
  const objects = [];
  let cursor;

  do {
    const page = await bucket.list({
      prefix: snapshotPrefix(familyId),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  return objects;
}

async function handleVaultGet(request, env) {
  const url = new URL(request.url);
  const configuredFamilyId = await instanceFamilyId(env);
  const bucketReady = storageConfigured(env);

  if (url.searchParams.get('status') === '1') {
    return jsonResponse({
      ok: true,
      instanceKeyConfigured: Boolean(configuredFamilyId),
      blobConfigured: bucketReady,
      r2Configured: bucketReady,
      syncConfigured: Boolean(configuredFamilyId && bucketReady),
      mode: !configuredFamilyId ? 'setup-required' : bucketReady ? 'cloud' : 'local-only',
      storage: 'cloudflare-r2',
    });
  }

  const familyId = url.searchParams.get('familyId');
  if (!FAMILY_RE.test(familyId || '')) {
    return jsonResponse({ error: 'invalid_family_id' }, 400);
  }

  const gate = await validateInstanceFamily(env, familyId);
  if (gate) return gate;

  if (!bucketReady) {
    return jsonResponse({
      exists: false,
      syncDisabled: true,
      message:
        'Cloud storage is not configured. This bblog instance can be used on one device; bind a Cloudflare R2 bucket before sharing.',
    });
  }

  const vaults = [];
  const legacyVault = await readVaultObject(env.BBLOG_BUCKET, vaultPath(familyId), 'legacy');
  if (legacyVault) vaults.push(legacyVault);

  const snapshots = await listSnapshotObjects(env.BBLOG_BUCKET, familyId);
  const snapshotVaults = await Promise.all(
    snapshots.map((object) =>
      readVaultObject(env.BBLOG_BUCKET, object.key, 'device').catch(() => null),
    ),
  );
  vaults.push(...snapshotVaults.filter(Boolean));
  vaults.sort((a, b) => new Date(a.uploadedAt || 0) - new Date(b.uploadedAt || 0));

  if (!vaults.length) return jsonResponse({ exists: false, vaults: [] });

  const latest = vaults.at(-1);
  return jsonResponse({
    exists: true,
    etag: latest.etag,
    vault: latest.vault,
    vaults,
  });
}

async function handleVaultPut(request, env) {
  const body = await readRequestJson(request);
  const { familyId, baseEtag, deviceId, vault } = body;

  if (!FAMILY_RE.test(familyId || '') || !vault || typeof vault !== 'object') {
    return jsonResponse({ error: 'invalid_vault' }, 400);
  }

  const gate = await validateInstanceFamily(env, familyId);
  if (gate) return gate;

  if (!storageConfigured(env)) {
    return jsonResponse({
      ok: false,
      syncDisabled: true,
      message:
        'Cloud storage is not configured. This bblog instance can be used on one device; bind a Cloudflare R2 bucket before sharing.',
    });
  }

  if (deviceId) {
    if (!DEVICE_RE.test(deviceId)) {
      return jsonResponse({ error: 'invalid_device_id' }, 400);
    }

    const object = await env.BBLOG_BUCKET.put(
      snapshotPath(familyId, deviceId),
      JSON.stringify(vault),
      {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'max-age=60',
        },
      },
    );
    return jsonResponse({ ok: true, etag: object.httpEtag, snapshot: true });
  }

  const key = vaultPath(familyId);
  const existing = await env.BBLOG_BUCKET.head(key);
  if (baseEtag && existing && existing.httpEtag !== baseEtag) {
    return jsonResponse({ error: 'vault_conflict' }, 409);
  }
  if (!baseEtag && existing) {
    return jsonResponse({ error: 'vault_conflict' }, 409);
  }

  const object = await env.BBLOG_BUCKET.put(key, JSON.stringify(vault), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'max-age=60',
    },
  });
  return jsonResponse({ ok: true, etag: object.httpEtag });
}

async function handleVault(request, env) {
  if (request.method === 'OPTIONS') {
    return emptyResponse(204, {
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }

  try {
    if (request.method === 'GET') return handleVaultGet(request, env);
    if (request.method === 'PUT') return handleVaultPut(request, env);
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  } catch (error) {
    return jsonResponse(
      {
        error: 'vault_error',
        message: error.message || 'Unexpected vault storage error.',
      },
      error.statusCode || 500,
    );
  }
}

async function handleNotifications(request, env) {
  if (request.method === 'OPTIONS') {
    return emptyResponse(204, {
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }

  const configuredFamilyId = await instanceFamilyId(env);
  const status = {
    ok: true,
    available: false,
    instanceKeyConfigured: Boolean(configuredFamilyId),
    pushConfigured: false,
    storageConfigured: storageConfigured(env),
    vapidPublicKey: '',
    message:
      'Background Web Push reminders are not available on the Cloudflare deployment yet. In-app medication reminders still work while bblog is open.',
  };

  if (request.method === 'GET') {
    return jsonResponse(
      new URL(request.url).searchParams.get('status') === '1'
        ? status
        : { ...status, sent: 0 },
    );
  }

  if (request.method === 'PUT' || request.method === 'DELETE') {
    await readRequestJson(request).catch(() => ({}));
    return jsonResponse(
      { error: 'background_notifications_unavailable', ...status },
      503,
    );
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}

async function serveAsset(request, env) {
  if (!env.ASSETS) {
    return new Response('Cloudflare Assets binding is not configured.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (new URL(request.url).pathname === '/sw.js') {
    headers.set('Cache-Control', 'no-cache');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/vault') return handleVault(request, env);
    if (url.pathname === '/api/notifications') {
      return handleNotifications(request, env);
    }
    return serveAsset(request, env);
  },
};
