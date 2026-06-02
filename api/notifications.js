import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { get, list, put } from '@vercel/blob';

const MAX_BODY_BYTES = 512 * 1024;
const FAMILY_RE = /^[a-f0-9]{32,64}$/;
const DEVICE_RE = /^[a-z0-9_-]{8,96}$/;
const NOTIFICATION_PREFIX = 'bblog/v1/notifications';
const MIN_ACCESS_KEY_LENGTH = 18;
const MAX_REMINDERS_PER_DEVICE = 100;
const MAX_DEVICES_PER_FAMILY = 25;
const MAX_REMINDER_LOOKAHEAD_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_REMINDER_STALE_MS = 3 * 24 * 60 * 60 * 1000;
const DEVICE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PUSH_TTL_SECONDS = 24 * 60 * 60;

const INSTANCE_ACCESS_KEY =
  process.env.BBLOG_FAMILY_ACCESS_KEY || process.env.BBLOG_ACCESS_KEY || '';
const INSTANCE_FAMILY_ID = familyIdForAccessKey(INSTANCE_ACCESS_KEY);
const VAPID_PUBLIC_KEY =
  process.env.BBLOG_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY =
  process.env.BBLOG_VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT =
  process.env.BBLOG_VAPID_SUBJECT ||
  process.env.VAPID_SUBJECT ||
  'mailto:notifications@bblog.local';

let vapidKeyObject = null;

function notificationPath(familyId) {
  return `${NOTIFICATION_PREFIX}/${familyId}.json`;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function normalizeAccessKey(accessKey) {
  return String(accessKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function familyIdForAccessKey(accessKey) {
  const normalized = normalizeAccessKey(accessKey);
  if (normalized.length < MIN_ACCESS_KEY_LENGTH) return '';
  return createHash('sha256')
    .update(`bblog-family-v1:${normalized}`)
    .digest('hex');
}

function validateInstanceFamily(res, familyId) {
  if (!INSTANCE_FAMILY_ID) {
    sendJson(res, 428, {
      error: 'instance_key_required',
      message:
        'This bblog deployment is not configured. Set BBLOG_FAMILY_ACCESS_KEY before joining.',
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

function pushConfigured() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function storageConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function notificationStatus() {
  const instanceKeyConfigured = Boolean(INSTANCE_FAMILY_ID);
  const pushReady = pushConfigured();
  const storageReady = storageConfigured();
  const available = instanceKeyConfigured && pushReady && storageReady;
  const missing = [];
  if (!instanceKeyConfigured) missing.push('BBLOG_FAMILY_ACCESS_KEY');
  if (!pushReady) {
    if (!VAPID_PUBLIC_KEY) missing.push('BBLOG_VAPID_PUBLIC_KEY');
    if (!VAPID_PRIVATE_KEY) missing.push('BBLOG_VAPID_PRIVATE_KEY');
  }
  if (!storageReady) missing.push('BLOB_READ_WRITE_TOKEN');

  return {
    ok: true,
    available,
    instanceKeyConfigured,
    pushConfigured: pushReady,
    storageConfigured: storageReady,
    vapidPublicKey: pushReady ? VAPID_PUBLIC_KEY : '',
    message: available
      ? 'Background medication reminders are available.'
      : `Background medication reminders need ${missing.join(', ')}.`,
  };
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

async function readNotificationConfig(pathname, familyId) {
  try {
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return emptyConfig(familyId);
    return normalizeConfig(JSON.parse(await streamToText(result.stream)), familyId);
  } catch (error) {
    if (isBlobMissing(error)) return emptyConfig(familyId);
    throw error;
  }
}

async function writeNotificationConfig(config) {
  await put(notificationPath(config.familyId), JSON.stringify(config), {
    access: 'private',
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: 'application/json; charset=utf-8',
  });
}

function emptyConfig(familyId) {
  return {
    version: 1,
    familyId,
    updatedAt: new Date().toISOString(),
    devices: {},
  };
}

function normalizeConfig(value, familyId = value?.familyId) {
  const config = emptyConfig(familyId);
  const devices = value?.devices && typeof value.devices === 'object'
    ? value.devices
    : {};

  for (const [deviceId, device] of Object.entries(devices)) {
    if (!DEVICE_RE.test(deviceId)) continue;
    const subscription = normalizeSubscription(device?.subscription);
    if (!subscription) continue;
    config.devices[deviceId] = {
      subscription,
      reminders: normalizeReminders(device?.reminders),
      updatedAt: normalizeTimestamp(device?.updatedAt) || config.updatedAt,
    };
  }

  pruneConfig(config);
  return config;
}

function normalizeTimestamp(value) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeSubscription(subscription) {
  const endpoint =
    typeof subscription?.endpoint === 'string' ? subscription.endpoint : '';
  const p256dh =
    typeof subscription?.keys?.p256dh === 'string'
      ? subscription.keys.p256dh
      : '';
  const auth =
    typeof subscription?.keys?.auth === 'string' ? subscription.keys.auth : '';

  if (!endpoint || !/^https:\/\//i.test(endpoint)) return null;
  if (!p256dh || !auth) return null;

  return {
    endpoint,
    expirationTime: subscription.expirationTime || null,
    keys: { p256dh, auth },
  };
}

function normalizeReminder(reminder, now = Date.now()) {
  const key =
    typeof reminder?.key === 'string' ? reminder.key.slice(0, 160) : '';
  const remindAt = Number(reminder?.remindAt);
  if (!key || !Number.isFinite(remindAt)) return null;
  if (remindAt < now - MAX_REMINDER_STALE_MS) return null;
  if (remindAt > now + MAX_REMINDER_LOOKAHEAD_MS) return null;

  return {
    key,
    remindAt: Math.round(remindAt),
  };
}

function normalizeReminders(reminders) {
  if (!Array.isArray(reminders)) return [];
  const unique = new Map();
  for (const reminder of reminders) {
    const normalized = normalizeReminder(reminder);
    if (normalized) unique.set(normalized.key, normalized);
  }
  return [...unique.values()]
    .sort((left, right) => left.remindAt - right.remindAt)
    .slice(0, MAX_REMINDERS_PER_DEVICE);
}

function pruneConfig(config, now = Date.now()) {
  const deviceEntries = Object.entries(config.devices)
    .map(([deviceId, device]) => {
      const updatedAt = new Date(device.updatedAt || '').getTime();
      return {
        deviceId,
        device: {
          ...device,
          reminders: normalizeReminders(device.reminders),
        },
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      };
    })
    .filter(({ updatedAt }) => updatedAt >= now - DEVICE_RETENTION_MS)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DEVICES_PER_FAMILY);

  config.devices = Object.fromEntries(
    deviceEntries.map(({ deviceId, device }) => [deviceId, device]),
  );
  config.updatedAt = new Date().toISOString();
  return config;
}

function base64UrlToBuffer(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(
    padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='),
    'base64',
  );
}

function bufferToBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function vapidPrivateKey() {
  if (vapidKeyObject) return vapidKeyObject;

  const publicKey = base64UrlToBuffer(VAPID_PUBLIC_KEY);
  const privateKey = base64UrlToBuffer(VAPID_PRIVATE_KEY);
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error('BBLOG_VAPID_PUBLIC_KEY must be an uncompressed P-256 key.');
  }
  if (privateKey.length !== 32) {
    throw new Error('BBLOG_VAPID_PRIVATE_KEY must be a P-256 private key.');
  }

  vapidKeyObject = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: bufferToBase64Url(publicKey.subarray(1, 33)),
      y: bufferToBase64Url(publicKey.subarray(33, 65)),
      d: bufferToBase64Url(privateKey),
    },
  });
  return vapidKeyObject;
}

function readDerLength(buffer, offset) {
  let length = buffer[offset];
  offset += 1;
  if ((length & 0x80) === 0) return { length, offset };

  const octets = length & 0x7f;
  length = 0;
  for (let i = 0; i < octets; i += 1) {
    length = (length << 8) | buffer[offset + i];
  }
  return { length, offset: offset + octets };
}

function fixedIntegerBytes(bytes) {
  let value = Buffer.from(bytes);
  while (value.length > 0 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) value = value.subarray(value.length - 32);
  if (value.length === 32) return value;
  return Buffer.concat([Buffer.alloc(32 - value.length), value]);
}

function derToJoseSignature(der) {
  let offset = 0;
  if (der[offset] !== 0x30) throw new Error('Invalid ECDSA signature.');
  offset += 1;
  const sequence = readDerLength(der, offset);
  offset = sequence.offset;
  if (der[offset] !== 0x02) throw new Error('Invalid ECDSA signature.');
  offset += 1;
  const rLength = readDerLength(der, offset);
  offset = rLength.offset;
  const r = der.subarray(offset, offset + rLength.length);
  offset += rLength.length;
  if (der[offset] !== 0x02) throw new Error('Invalid ECDSA signature.');
  offset += 1;
  const sLength = readDerLength(der, offset);
  offset = sLength.offset;
  const s = der.subarray(offset, offset + sLength.length);
  return Buffer.concat([fixedIntegerBytes(r), fixedIntegerBytes(s)]);
}

function signVapidJwt(audience) {
  const header = bufferToBase64Url(
    Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  );
  const claims = bufferToBase64Url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: VAPID_SUBJECT,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = derToJoseSignature(signer.sign(vapidPrivateKey()));
  return `${unsigned}.${bufferToBase64Url(signature)}`;
}

async function sendWebPush(subscription) {
  const audience = new URL(subscription.endpoint).origin;
  const authorization = `vapid t=${signVapidJwt(audience)}, k=${VAPID_PUBLIC_KEY}`;
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      TTL: String(PUSH_TTL_SECONDS),
      Urgency: 'normal',
    },
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    expired: response.status === 404 || response.status === 410,
    status: response.status,
  };
}

async function dispatchDueNotifications() {
  if (!pushConfigured() || !storageConfigured()) {
    return {
      ...notificationStatus(),
      ok: false,
      sent: 0,
    };
  }

  const now = Date.now();
  const blobs = [];
  let cursor;
  do {
    const page = await list({
      prefix: `${NOTIFICATION_PREFIX}/`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  let sent = 0;
  let expired = 0;
  let failed = 0;

  for (const blob of blobs) {
    const familyId = blob.pathname.split('/').pop()?.replace(/\.json$/, '');
    if (!FAMILY_RE.test(familyId || '')) continue;

    const config = await readNotificationConfig(blob.pathname, familyId);
    let changed = false;

    for (const [deviceId, device] of Object.entries(config.devices)) {
      const due = device.reminders.filter((reminder) => reminder.remindAt <= now);
      if (!due.length) continue;

      const result = await sendWebPush(device.subscription).catch((error) => ({
        ok: false,
        expired: false,
        status: 0,
        error,
      }));

      if (result.ok || result.expired) {
        changed = true;
        const dueKeys = new Set(due.map((reminder) => reminder.key));
        if (result.ok) {
          sent += 1;
          config.devices[deviceId] = {
            ...device,
            reminders: device.reminders.filter(
              (reminder) => !dueKeys.has(reminder.key),
            ),
            updatedAt: new Date().toISOString(),
          };
        } else {
          expired += 1;
          delete config.devices[deviceId];
        }
      } else {
        failed += 1;
      }
    }

    if (changed) {
      pruneConfig(config);
      await writeNotificationConfig(config);
    }
  }

  return { ok: true, sent, expired, failed };
}

async function upsertDevice(req, res) {
  const status = notificationStatus();
  if (!status.available) {
    sendJson(res, 503, {
      error: 'background_notifications_unavailable',
      ...status,
    });
    return;
  }

  const body = await readRequestJson(req);
  const { familyId, deviceId } = body;
  if (!FAMILY_RE.test(familyId || '') || !DEVICE_RE.test(deviceId || '')) {
    sendJson(res, 400, { error: 'invalid_notification_device' });
    return;
  }
  if (!validateInstanceFamily(res, familyId)) return;

  const subscription = normalizeSubscription(body.subscription);
  if (!subscription) {
    sendJson(res, 400, { error: 'invalid_push_subscription' });
    return;
  }

  const config = await readNotificationConfig(
    notificationPath(familyId),
    familyId,
  );
  config.devices[deviceId] = {
    subscription,
    reminders: normalizeReminders(body.reminders),
    updatedAt: new Date().toISOString(),
  };
  pruneConfig(config);
  await writeNotificationConfig(config);
  sendJson(res, 200, {
    ok: true,
    reminders: config.devices[deviceId]?.reminders.length || 0,
  });
}

async function deleteDevice(req, res) {
  const body = await readRequestJson(req);
  const { familyId, deviceId } = body;
  if (!FAMILY_RE.test(familyId || '') || !DEVICE_RE.test(deviceId || '')) {
    sendJson(res, 400, { error: 'invalid_notification_device' });
    return;
  }
  if (!validateInstanceFamily(res, familyId)) return;
  if (!storageConfigured()) {
    sendJson(res, 503, {
      error: 'background_notifications_unavailable',
      ...notificationStatus(),
    });
    return;
  }

  const config = await readNotificationConfig(
    notificationPath(familyId),
    familyId,
  );
  delete config.devices[deviceId];
  pruneConfig(config);
  await writeNotificationConfig(config);
  sendJson(res, 200, { ok: true });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://bblog.local');
      if (url.searchParams.get('status') === '1') {
        sendJson(res, 200, notificationStatus());
        return;
      }

      sendJson(res, 200, await dispatchDueNotifications());
      return;
    }

    if (req.method === 'PUT') {
      await upsertDevice(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      await deleteDevice(req, res);
      return;
    }

    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: 'notification_error',
      message: error.message || 'Unexpected notification error.',
    });
  }
}
