const DB_NAME = 'bblog-v1';
const DB_STORE = 'kv';
const DATA_KEY = 'vault-data';
const SESSION_KEY = 'vault-session';
const KDF_ITERATIONS = 210000;
const MILK_UNIT = 'ml';
const BABY_COLOURS = ['#007aff', '#ff6b00', '#34c759', '#ff2d55', '#af52de', '#5ac8fa'];

const formState = {
  user: null,
  baby: null,
  type: null,
  medication: null,
  amount: '',
};

let dbPromise = null;
let data = null;
let session = null;
let syncInFlight = null;
let syncTimer = null;
let _isOffline = false;
let _cloudSyncDisabled = false;
let _dashOffset = 0;
let _medEditId = null;
let _personEdit = null;
let _lastGeneratedKey = '';
let keyCache = null;

const enc = new TextEncoder();
const dec = new TextDecoder();

function appCrypto() {
  return globalThis.crypto;
}

function requireRandomCrypto() {
  const cryptoApi = appCrypto();
  if (!cryptoApi?.getRandomValues) {
    throw new Error('This browser does not support secure random values.');
  }
  return cryptoApi;
}

function requireVaultCrypto() {
  const cryptoApi = requireRandomCrypto();
  const subtle = cryptoApi.subtle || cryptoApi.webkitSubtle;
  if (!globalThis.isSecureContext || !subtle) {
    throw new Error('bblog needs a secure HTTPS browser context to create or unlock an encrypted vault.');
  }
  return { cryptoApi, subtle };
}

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + requireRandomCrypto().getRandomValues(new Uint32Array(1))[0].toString(36);
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kvDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBase64(byteCount) {
  const bytes = new Uint8Array(byteCount);
  requireRandomCrypto().getRandomValues(bytes);
  return bytesToBase64(bytes);
}

function generateAccessKey() {
  const bytes = new Uint8Array(16);
  requireRandomCrypto().getRandomValues(bytes);
  const hex = bytesToHex(bytes);
  return `bb-${hex.match(/.{1,4}/g).join('-')}`;
}

function normalizeAccessKey(accessKey) {
  return String(accessKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function sha256Hex(value) {
  const { subtle } = requireVaultCrypto();
  const digest = await subtle.digest('SHA-256', enc.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function familyIdFor(accessKey) {
  return sha256Hex(`bblog-family-v1:${normalizeAccessKey(accessKey)}`);
}

async function deriveCryptoKey(accessKey, salt) {
  const normalized = normalizeAccessKey(accessKey);
  if (keyCache?.normalized === normalized && keyCache?.salt === salt) {
    return keyCache.key;
  }
  const { subtle } = requireVaultCrypto();
  const material = await subtle.importKey(
    'raw',
    enc.encode(normalized),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(salt),
      iterations: KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache = { normalized, salt, key };
  return key;
}

async function encryptVault(plainData) {
  const salt = session.salt || randomBase64(16);
  session.salt = salt;
  const key = await deriveCryptoKey(session.accessKey, salt);
  const iv = new Uint8Array(12);
  requireRandomCrypto().getRandomValues(iv);
  const plaintext = enc.encode(JSON.stringify(normalizeData(plainData)));
  const { subtle } = requireVaultCrypto();
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    version: 1,
    familyId: session.familyId,
    encryptedAt: nowIso(),
    kdf: {
      name: 'PBKDF2-SHA256',
      iterations: KDF_ITERATIONS,
      salt,
    },
    cipher: {
      name: 'AES-GCM',
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
}

async function decryptVault(envelope) {
  if (!envelope?.kdf?.salt || !envelope?.cipher?.iv || !envelope?.cipher?.data) {
    throw new Error('Cloud vault is not a supported encrypted bblog vault.');
  }
  if (envelope.familyId && envelope.familyId !== session.familyId) {
    throw new Error('Cloud vault belongs to a different access key.');
  }
  session.salt = envelope.kdf.salt;
  const key = await deriveCryptoKey(session.accessKey, envelope.kdf.salt);
  const { subtle } = requireVaultCrypto();
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.cipher.iv) },
    key,
    base64ToBytes(envelope.cipher.data),
  );
  return normalizeData(JSON.parse(dec.decode(plaintext)));
}

function stamped(item, stamp) {
  return {
    ...item,
    createdAt: item.createdAt || stamp,
    updatedAt: item.updatedAt || stamp,
  };
}

function buildEmptyData() {
  const stamp = nowIso();
  return normalizeData({
    schemaVersion: 1,
    meta: { createdAt: stamp, updatedAt: stamp },
    users: [],
    babies: [],
    medications: [],
    entries: [],
  });
}

function normalizeRecordList(records, mapper) {
  return (Array.isArray(records) ? records : [])
    .filter((item) => item && item.id)
    .map((item) => {
      const stamp = item.updatedAt || item.createdAt || item.timestamp || nowIso();
      return mapper(stamped(item, stamp));
    });
}

function normalizeData(value) {
  const stamp = nowIso();
  const source = value && typeof value === 'object' ? value : {};
  const result = {
    schemaVersion: 1,
    meta: {
      createdAt: source.meta?.createdAt || stamp,
      updatedAt: source.meta?.updatedAt || stamp,
    },
    users: normalizeRecordList(source.users, (item) => ({
      id: item.id,
      name: String(item.name || item.label || '').trim() || 'Parent',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt || null,
    })),
    babies: normalizeRecordList(source.babies, (item) => ({
      id: item.id,
      name: String(item.name || item.label || '').trim() || 'Baby',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt || null,
    })),
    medications: normalizeRecordList(source.medications, (item) => ({
      id: item.id,
      label: String(item.label || item.name || '').trim() || 'Medication',
      unit: String(item.unit || 'ml').trim() || 'ml',
      ...(item.defaultAmount != null && item.defaultAmount !== ''
        ? { defaultAmount: Number(item.defaultAmount) }
        : {}),
      ...(item.intervalHours != null && item.intervalHours !== ''
        ? { intervalHours: Number(item.intervalHours) }
        : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt || null,
    })),
    entries: normalizeRecordList(source.entries, (item) => ({
      id: item.id,
      timestamp: item.timestamp || item.createdAt || stamp,
      user: item.user || null,
      baby: item.baby || null,
      type: item.type || 'milk',
      ...(item.amount != null && item.amount !== '' ? { amount: Number(item.amount) } : {}),
      ...(item.unit ? { unit: item.unit } : {}),
      medication: item.medication || null,
      createdAt: item.createdAt || item.timestamp || stamp,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt || null,
    })),
  };

  result.users.sort(sortByCreatedThenName);
  result.babies.sort(sortByCreatedThenName);
  result.medications.sort(sortByCreatedThenName);
  result.entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return result;
}

function cloneData(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function sortByCreatedThenName(a, b) {
  const created = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  if (created) return created;
  return String(a.name || a.label).localeCompare(String(b.name || b.label));
}

function active(list) {
  return list.filter((item) => !item.deletedAt);
}

function users() {
  return active(data?.users || []);
}

function babies() {
  return active(data?.babies || []).map((baby, index) => ({
    ...baby,
    colour: BABY_COLOURS[index % BABY_COLOURS.length],
  }));
}

function medications() {
  return active(data?.medications || []);
}

function entries({ includeDeleted = false } = {}) {
  const list = data?.entries || [];
  return includeDeleted ? list : active(list);
}

function findUser(id) {
  return users().find((u) => u.id === id);
}

function findBaby(id) {
  return babies().find((b) => b.id === id);
}

function findMed(id) {
  return medications().find((m) => m.id === id);
}

function currentUnit() {
  if (formState.type === 'medication' && formState.medication) {
    return findMed(formState.medication)?.unit || 'ml';
  }
  return MILK_UNIT;
}

function recordStamp(item) {
  return new Date(item.deletedAt || item.updatedAt || item.createdAt || item.timestamp || 0).getTime() || 0;
}

function mergeRecordList(left, right) {
  const map = new Map();
  for (const item of [...(left || []), ...(right || [])]) {
    const current = map.get(item.id);
    if (!current || recordStamp(item) > recordStamp(current)) {
      map.set(item.id, item);
    } else if (current && recordStamp(item) === recordStamp(current)) {
      map.set(item.id, JSON.stringify(item) > JSON.stringify(current) ? item : current);
    }
  }
  return [...map.values()];
}

function mergeVaults(localData, remoteData) {
  const updatedAt = [localData?.meta?.updatedAt, remoteData?.meta?.updatedAt]
    .filter(Boolean)
    .sort()
    .at(-1);
  const merged = normalizeData({
    schemaVersion: 1,
    meta: {
      createdAt: [localData?.meta?.createdAt, remoteData?.meta?.createdAt].filter(Boolean).sort()[0] || nowIso(),
      updatedAt: updatedAt || nowIso(),
    },
    users: mergeRecordList(localData?.users, remoteData?.users),
    babies: mergeRecordList(localData?.babies, remoteData?.babies),
    medications: mergeRecordList(localData?.medications, remoteData?.medications),
    entries: mergeRecordList(localData?.entries, remoteData?.entries),
  });
  return merged;
}

function comparable(value) {
  const normal = normalizeData(value);
  delete normal.meta;
  return JSON.stringify(normal);
}

async function loadSession() {
  session = (await kvGet(SESSION_KEY)) || {};
  return session;
}

async function persistSession() {
  const saved = { ...session };
  if (!saved.rememberKey) delete saved.accessKey;
  await kvSet(SESSION_KEY, saved);
}

async function loadData() {
  const stored = await kvGet(DATA_KEY);
  if (stored?.vault && stored.familyId === session?.familyId && session?.accessKey) {
    data = await decryptVault(stored.vault);
  } else if (stored?.vault) {
    data = buildEmptyData();
  } else {
    data = normalizeData(stored || buildEmptyData());
  }
  return data;
}

async function saveData(nextData = data) {
  data = normalizeData(nextData);
  if (session?.accessKey && session?.familyId) {
    const vault = await encryptVault(data);
    await kvSet(DATA_KEY, { familyId: session.familyId, vault });
    await persistSession();
  } else {
    await kvSet(DATA_KEY, data);
  }
}

async function mutateData(mutator) {
  const next = cloneData(data || buildEmptyData());
  await mutator(next);
  next.meta = { ...(next.meta || {}), updatedAt: nowIso() };
  await saveData(next);
  renderAll();
  scheduleSync();
}

function updateConnectionBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;

  banner.classList.toggle('offline-banner--sync-disabled', _cloudSyncDisabled);
  if (_cloudSyncDisabled) {
    banner.textContent = 'Cloud sync is not configured. Same-key users will not share data until Vercel Blob is connected.';
    banner.classList.remove('hidden');
    return;
  }

  banner.textContent = 'Saved here. Cloud sync will resume when this device is back online.';
  banner.classList.toggle('hidden', !_isOffline);
}

function setOffline(offline) {
  _isOffline = offline;
  updateConnectionBanner();
}

function setCloudSyncDisabled(disabled) {
  _cloudSyncDisabled = disabled;
  updateConnectionBanner();
}

function setSetupStatus(message, isError = false) {
  const el = document.getElementById('setup-status');
  el.textContent = message || '';
  el.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
}

function setSyncStatus(title, detail) {
  const titleEl = document.getElementById('sync-title');
  const detailEl = document.getElementById('sync-detail');
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
}

function syncDetailText() {
  if (!session?.familyId) return 'No access key on this device';
  if (_cloudSyncDisabled) return 'Local only - Vercel Blob not connected';
  if (_isOffline) return 'Waiting for connection';
  if (session.lastSyncedAt) return `Last synced ${formatElapsed(Date.now() - new Date(session.lastSyncedAt).getTime())}`;
  return 'Ready to sync';
}

function updateSyncUi() {
  setSyncStatus('Encrypted sync', syncDetailText());
}

async function fetchRemoteVault() {
  const res = await fetch(`/api/vault?familyId=${encodeURIComponent(session.familyId)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || 'Cloud sync failed.');
  return body;
}

async function putRemoteVault(vault, baseEtag) {
  const res = await fetch('/api/vault', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ familyId: session.familyId, baseEtag, vault }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { conflict: true };
  if (!res.ok) throw new Error(body.message || body.error || 'Cloud sync failed.');
  return body;
}

function scheduleSync() {
  if (!session?.accessKey || !session?.familyId) return;
  if (_cloudSyncDisabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({ quiet: true }).catch(() => {}), 500);
}

async function syncNow({ quiet = false, force = false } = {}) {
  if (!session?.accessKey || !session?.familyId) return;
  if (_cloudSyncDisabled && !force) {
    setOffline(false);
    updateSyncUi();
    return;
  }
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    if (!quiet) setSyncStatus('Encrypted sync', 'Syncing...');
    if (force) setCloudSyncDisabled(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      const localBefore = normalizeData(data || (await loadData()));
      const remote = await fetchRemoteVault();
      if (remote.syncDisabled) {
        setCloudSyncDisabled(true);
        setOffline(false);
        updateSyncUi();
        return;
      }
      let merged = localBefore;
      let remotePlain = null;
      let baseEtag = remote.etag || null;

      if (remote.exists) {
        remotePlain = await decryptVault(remote.vault);
        merged = mergeVaults(localBefore, remotePlain);
        if (comparable(merged) !== comparable(localBefore)) {
          await saveData(merged);
          renderAll();
        }
      } else if (!session.salt) {
        session.salt = randomBase64(16);
      }

      if (remotePlain && comparable(merged) === comparable(remotePlain)) {
        session.remoteEtag = baseEtag;
        session.lastSyncedAt = nowIso();
        await persistSession();
        setOffline(false);
        updateSyncUi();
        return;
      }

      const envelope = await encryptVault(merged);
      await persistSession();
      const put = await putRemoteVault(envelope, baseEtag);
      if (put.conflict) continue;
      if (put.syncDisabled) {
        setCloudSyncDisabled(true);
        setOffline(false);
        updateSyncUi();
        return;
      }

      setCloudSyncDisabled(false);
      session.remoteEtag = put.etag || null;
      session.lastSyncedAt = nowIso();
      await persistSession();
      setOffline(false);
      updateSyncUi();
      return;
    }

    throw new Error('Cloud vault changed during sync. Try again.');
  })()
    .catch((error) => {
      setOffline(true);
      setSyncStatus('Encrypted sync', error.message || 'Waiting for connection');
      throw error;
    })
    .finally(() => {
      syncInFlight = null;
    });

  return syncInFlight;
}

async function unlockWithAccessKey(rawKey) {
  const accessKey = rawKey.trim();
  if (normalizeAccessKey(accessKey).length < 18) {
    setSetupStatus('Enter a longer access key.', true);
    return;
  }

  setSetupStatus('Unlocking...');
  try {
    requireVaultCrypto();
  } catch (error) {
    setSetupStatus(error.message || 'This browser cannot unlock encrypted vaults.', true);
    return;
  }

  const familyId = await familyIdFor(accessKey);
  const rememberKey = document.getElementById('remember-key-input').checked;
  const stored = await kvGet(SESSION_KEY);
  const storedData = await kvGet(DATA_KEY);
  const hasLocalVault = storedData?.vault && storedData.familyId === familyId;
  session = {
    ...(stored?.familyId === familyId ? stored : {}),
    familyId,
    accessKey,
    rememberKey,
  };
  await persistSession();

  try {
    const remote = await fetchRemoteVault();
    if (remote.syncDisabled) {
      setCloudSyncDisabled(true);
      if (hasLocalVault) {
        await loadData();
      } else {
        await saveData(buildEmptyData());
      }
      showApp();
      setOffline(false);
      setSetupStatus('');
      return;
    }
    if (remote.exists && !hasLocalVault) {
      const remotePlain = await decryptVault(remote.vault);
      session.remoteEtag = remote.etag || null;
      session.lastSyncedAt = nowIso();
      await saveData(remotePlain);
      await persistSession();
      showApp();
      setOffline(false);
      setSetupStatus('');
      return;
    }

    if (hasLocalVault) {
      await loadData();
    } else {
      await saveData(buildEmptyData());
    }

    showApp();
    setOffline(false);
    setSetupStatus('');
    syncNow({ quiet: true }).catch(() => {});
  } catch (error) {
    if (hasLocalVault) {
      await loadData();
      showApp();
      setOffline(true);
      setSyncStatus('Encrypted sync', error.message || 'Waiting for connection');
      setSetupStatus('');
      return;
    }

    if (normalizeAccessKey(accessKey) === normalizeAccessKey(_lastGeneratedKey)) {
      await saveData(buildEmptyData());
      showApp();
      setOffline(true);
      setSetupStatus('');
      return;
    }

    throw error;
  }
}

function showSetup() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('tab-bar').classList.add('hidden');
}

function hasRequiredSetup() {
  return users().length > 0 && babies().length > 0;
}

function showApp() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('tab-bar').classList.remove('hidden');
  setOffline(!navigator.onLine);
  renderAll();
  if (!hasRequiredSetup()) setActiveTab('settings');
}

function formatTime(isoString) {
  const d = new Date(isoString);
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday - 86400000);
  const startOfEntry = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  let dateStr;
  if (startOfEntry.getTime() === startOfToday.getTime()) {
    dateStr = 'Today';
  } else if (startOfEntry.getTime() === startOfYesterday.getTime()) {
    dateStr = 'Yesterday';
  } else {
    dateStr = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  return `${dateStr} at ${timeStr}`;
}

function formatElapsed(ms) {
  const totalMins = Math.floor(ms / 60000);
  if (totalMins < 1) return 'just now';
  if (totalMins < 60) return `${totalMins}m ago`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSelButtons(containerId, items, stateKey, onChange, emptyText = '') {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!items.length && emptyText) {
    const empty = document.createElement('p');
    empty.className = 'inline-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = `sel-btn${formState[stateKey] === item.id ? ' selected' : ''}`;
    btn.dataset.id = item.id;
    btn.textContent = item.name || item.label;
    btn.addEventListener('click', () => {
      formState[stateKey] = item.id;
      renderSelButtons(containerId, items, stateKey, onChange);
      if (onChange) onChange(item.id);
    });
    container.appendChild(btn);
  });
}

function renderUserButtons() {
  renderSelButtons('user-buttons', users(), 'user', () => updateSaveBtn(), 'Add a parent in Settings.');
}

function renderBabyButtons() {
  renderSelButtons('baby-buttons', babies(), 'baby', (id) => {
    updateSaveBtn();
    if (formState.type === 'medication') renderMedIntervals(id);
  }, 'Add a baby in Settings.');
}

function renderTypeButtons() {
  const types = [
    { id: 'milk', name: '🍼 Milk' },
    { id: 'medication', name: '💊 Meds' },
    { id: 'poo', name: '💩' },
  ];

  renderSelButtons('type-buttons', types, 'type', (selectedId) => {
    formState.medication = null;
    const amountInput = document.getElementById('amount-input');
    amountInput.readOnly = false;
    amountInput.classList.remove('amount-input--locked');

    const medStep = document.getElementById('step-medication');
    const amountGroup = document.getElementById('amount-group');

    if (selectedId === 'medication') {
      medStep.classList.remove('hidden');
      amountGroup.classList.remove('hidden');
      renderMedButtons();
      renderMedIntervals(formState.baby);
    } else if (selectedId === 'poo') {
      medStep.classList.add('hidden');
      amountGroup.classList.add('hidden');
      document.getElementById('medication-intervals').innerHTML = '';
    } else {
      medStep.classList.add('hidden');
      amountGroup.classList.remove('hidden');
      document.getElementById('medication-intervals').innerHTML = '';
    }

    updateUnitLabel();
    updateSaveBtn();
  });

  if (!formState.type) document.getElementById('amount-group').classList.add('hidden');
  if (!medications().length) {
    const medBtn = document.querySelector('#type-buttons .sel-btn[data-id="medication"]');
    if (medBtn) medBtn.disabled = true;
  }
}

function renderMedButtons() {
  const select = document.getElementById('medication-select');
  select.innerHTML = '<option value="">Select medication</option>';
  medications().forEach((med) => {
    const opt = document.createElement('option');
    opt.value = med.id;
    opt.textContent = med.label;
    if (formState.medication === med.id) opt.selected = true;
    select.appendChild(opt);
  });

  const fresh = select.cloneNode(true);
  select.parentNode.replaceChild(fresh, select);
  fresh.addEventListener('change', () => {
    formState.medication = fresh.value || null;
    const med = findMed(formState.medication);
    const amountInput = document.getElementById('amount-input');
    const warning = document.getElementById('med-partial-warning');
    warning.classList.add('hidden');
    warning.textContent = '';

    if (med?.defaultAmount != null && med.defaultAmount !== '') {
      let prefillAmount = med.defaultAmount;
      if (formState.baby) {
        const intervalMs = med.intervalHours ? med.intervalHours * 3600 * 1000 : Infinity;
        const last = entries().find(
          (e) =>
            e.type === 'medication' &&
            e.baby === formState.baby &&
            e.medication === med.id &&
            e.amount != null &&
            Date.now() - new Date(e.timestamp).getTime() < intervalMs,
        );
        if (last && last.amount < med.defaultAmount) {
          prefillAmount = last.amount;
          const baby = findBaby(formState.baby);
          warning.textContent = `The last dose of ${med.label} for ${baby?.name || 'this baby'} was ${last.amount}${last.unit || med.unit || ''}.`;
          warning.classList.remove('hidden');
        }
      }
      amountInput.value = String(prefillAmount);
      formState.amount = String(prefillAmount);
    }

    amountInput.readOnly = false;
    amountInput.classList.remove('amount-input--locked');
    updateUnitLabel();
    updateSaveBtn();
  });
}

function renderMedIntervals(babyId) {
  const el = document.getElementById('medication-intervals');
  const intervalMeds = medications().filter((m) => m.intervalHours);
  if (!intervalMeds.length || !babyId) {
    el.innerHTML = '';
    return;
  }

  const lastTaken = {};
  for (const e of entries()) {
    if (e.type === 'medication' && e.baby === babyId && e.medication && !(e.medication in lastTaken)) {
      lastTaken[e.medication] = e;
    }
  }

  const now = Date.now();
  el.innerHTML = intervalMeds
    .map((med) => {
      const last = lastTaken[med.id];
      const intervalMs = med.intervalHours * 3600 * 1000;
      let timeStr;
      let status;
      let elapsedMs;
      if (!last) {
        timeStr = 'not yet given';
        status = 'overdue';
        elapsedMs = Infinity;
      } else {
        elapsedMs = now - new Date(last.timestamp).getTime();
        timeStr = formatElapsed(elapsedMs);
        status = elapsedMs >= intervalMs ? 'overdue' : 'ok';
      }
      let amountStr = '';
      let partial = false;
      if (last?.amount != null) {
        amountStr = ` · ${last.amount}${last.unit || med.unit || ''}`;
        if (med.defaultAmount != null && last.amount < med.defaultAmount && elapsedMs < intervalMs) {
          partial = true;
        }
      }
      const rowClass = partial ? 'med-interval-row--partial' : `med-interval-row--${status}`;
      return `<div class="med-interval-row ${rowClass}">
        <span class="med-interval-name">${escapeHtml(med.label)}</span>
        <span class="med-interval-time">${timeStr}${escapeHtml(amountStr)}</span>
        <span class="med-interval-badge">${status === 'ok' ? '✓' : '!'}</span>
      </div>`;
    })
    .join('');
}

function updateUnitLabel() {
  document.getElementById('unit-label').textContent = currentUnit();
}

function updateSaveBtn() {
  const medOk =
    formState.type === 'milk' ||
    formState.type === 'poo' ||
    (formState.type === 'medication' && formState.medication);
  const amountOk = formState.type === 'poo' || parseFloat(formState.amount) > 0;
  const ready = formState.user && formState.baby && formState.type && medOk && amountOk;
  document.getElementById('save-btn').disabled = !ready;
}

async function saveEntry() {
  const tsInput = document.getElementById('timestamp-input').value;
  const timestamp = tsInput ? new Date(tsInput).toISOString() : nowIso();
  const stamp = nowIso();
  const entry = {
    id: uid('entry_'),
    timestamp,
    user: formState.user,
    baby: formState.baby,
    type: formState.type,
    ...(formState.type !== 'poo' && {
      amount: parseFloat(formState.amount),
      unit: currentUnit(),
    }),
    medication: formState.medication,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
  };

  await mutateData((next) => {
    next.entries.unshift(entry);
  });

  const baby = findBaby(formState.baby);
  const detail =
    formState.type === 'poo'
      ? 'Poo'
      : formState.type === 'medication'
        ? findMed(formState.medication)?.label || formState.medication
        : 'Milk';
  const amountStr = formState.type !== 'poo' ? ` ${entry.amount} ${entry.unit}` : '';
  const conf = document.getElementById('confirmation');
  conf.textContent = `Saved - ${baby?.name || formState.baby}: ${detail}${amountStr}`;
  conf.classList.remove('hidden');
  setTimeout(() => conf.classList.add('hidden'), 3000);

  formState.type = null;
  formState.medication = null;
  formState.amount = '';
  renderTypeButtons();
  document.getElementById('step-medication').classList.add('hidden');
  document.getElementById('amount-group').classList.add('hidden');
  document.getElementById('amount-input').value = '';
  document.getElementById('timestamp-input').value = '';
  document.getElementById('timestamp-input').classList.add('hidden');
  document.getElementById('timestamp-toggle').classList.remove('active');
  updateUnitLabel();
  updateSaveBtn();
}

function clearForm() {
  formState.user = null;
  formState.baby = null;
  formState.type = null;
  formState.medication = null;
  formState.amount = '';

  renderUserButtons();
  renderBabyButtons();
  renderTypeButtons();
  document.getElementById('step-medication').classList.add('hidden');
  document.getElementById('amount-group').classList.add('hidden');
  const amountInput = document.getElementById('amount-input');
  amountInput.value = '';
  amountInput.readOnly = false;
  amountInput.classList.remove('amount-input--locked');
  document.getElementById('timestamp-input').value = '';
  document.getElementById('timestamp-input').classList.add('hidden');
  document.getElementById('timestamp-toggle').classList.remove('active');
  updateUnitLabel();
  updateSaveBtn();
  document.getElementById('confirmation').classList.add('hidden');
}

function renderLog() {
  const list = document.getElementById('log-list');
  const visibleEntries = entries().slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!visibleEntries.length) {
    list.innerHTML = '<p class="log-empty">No entries yet.</p>';
    return;
  }

  list.innerHTML = visibleEntries
    .map((e) => {
      const baby = findBaby(e.baby);
      const user = findUser(e.user);
      const med = e.medication ? findMed(e.medication) : null;
      const emoji = e.type === 'medication' ? '💊' : e.type === 'poo' ? '💩' : '🍼';
      const typeName = e.type === 'medication' ? escapeHtml(med ? med.label : e.medication) : e.type === 'poo' ? 'Poo' : 'Milk';
      const primary =
        e.type === 'poo'
          ? `<span class="log-val">${escapeHtml(baby ? baby.name : e.baby)}</span> had a moment`
          : `<span class="log-val">${escapeHtml(e.amount)}${escapeHtml(e.unit)}</span> of <span class="log-val">${typeName}</span> given to <span class="log-val">${escapeHtml(baby ? baby.name : e.baby)}</span>`;
      const medOptions = medications()
        .map((m) => `<option value="${m.id}" ${e.medication === m.id ? 'selected' : ''}>${escapeHtml(m.label)}</option>`)
        .join('');
      const tsLocal = new Date(new Date(e.timestamp).getTime() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      const babyColour = baby?.colour || 'var(--accent)';

      return `
      <div class="log-entry-wrap" data-id="${e.id}" style="--baby-colour:${babyColour}">
        <div class="log-entry">
          <div class="log-entry-main">
            <div class="log-entry-primary">${primary}</div>
            <div class="log-entry-detail">${emoji} by ${escapeHtml(user ? user.name : e.user)} · ${formatTime(e.timestamp)}</div>
          </div>
        </div>
        <div class="log-entry-actions hidden" data-actions-id="${e.id}">
          <button class="log-action-btn log-edit-btn" data-id="${e.id}">Edit</button>
          <button class="log-action-btn log-action-delete delete-btn" data-id="${e.id}">Delete</button>
        </div>
        <div class="log-edit-form hidden" data-edit-id="${e.id}">
          ${
            e.type !== 'poo'
              ? `<label class="log-edit-label">Amount
                  <input class="log-edit-input" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" data-field="amount" value="${escapeHtml(e.amount)}" autocomplete="off" autocorrect="off" spellcheck="false" />
                </label>`
              : ''
          }
          <label class="log-edit-label">Date &amp; time
            <input class="log-edit-input" type="datetime-local" data-field="timestamp" value="${tsLocal}" />
          </label>
          ${
            e.type === 'medication'
              ? `<label class="log-edit-label">Medication
                  <select class="log-edit-input log-edit-select" data-field="medication">${medOptions}</select>
                </label>`
              : ''
          }
          <div class="log-edit-actions">
            <button class="btn btn-secondary log-edit-cancel" data-id="${e.id}">Cancel</button>
            <button class="btn btn-primary log-edit-save" data-id="${e.id}">Save</button>
          </div>
        </div>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.log-entry').forEach((card) => {
    card.addEventListener('click', () => {
      const wrap = card.closest('.log-entry-wrap');
      const isOpen = wrap.classList.contains('open');
      list.querySelectorAll('.log-entry-wrap.open').forEach((w) => {
        w.classList.remove('open');
        w.querySelector('.log-entry-actions').classList.add('hidden');
        w.querySelector('.log-edit-form').classList.add('hidden');
      });
      if (!isOpen) {
        wrap.classList.add('open');
        wrap.querySelector('.log-entry-actions').classList.remove('hidden');
      }
    });
  });

  list.querySelectorAll('.log-edit-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const form = list.querySelector(`[data-edit-id="${btn.dataset.id}"]`);
      const isHidden = form.classList.toggle('hidden');
      btn.classList.toggle('active', !isHidden);
    });
  });

  list.querySelectorAll('.log-edit-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.log-entry-wrap');
      wrap.querySelector('.log-edit-form').classList.add('hidden');
      wrap.querySelector('.log-entry-actions').classList.add('hidden');
      wrap.classList.remove('open');
    });
  });

  list.querySelectorAll('.log-edit-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const form = list.querySelector(`[data-edit-id="${btn.dataset.id}"]`);
      const amtInput = form.querySelector('[data-field="amount"]');
      const tsInput = form.querySelector('[data-field="timestamp"]');
      const medInput = form.querySelector('[data-field="medication"]');
      await mutateData((next) => {
        const entry = next.entries.find((item) => item.id === btn.dataset.id);
        if (!entry) return;
        if (amtInput) entry.amount = parseFloat(amtInput.value);
        if (tsInput?.value) entry.timestamp = new Date(tsInput.value).toISOString();
        if (medInput) {
          entry.medication = medInput.value;
          entry.unit = next.medications.find((med) => med.id === medInput.value)?.unit || entry.unit;
        }
        entry.updatedAt = nowIso();
      });
    });
  });

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (btn.dataset.confirming) {
        await mutateData((next) => {
          const entry = next.entries.find((item) => item.id === btn.dataset.id);
          if (entry) {
            entry.deletedAt = nowIso();
            entry.updatedAt = entry.deletedAt;
          }
        });
      } else {
        btn.dataset.confirming = 'true';
        btn.textContent = 'Confirm?';
        setTimeout(() => {
          if (btn.dataset.confirming) {
            delete btn.dataset.confirming;
            btn.textContent = 'Delete';
          }
        }, 3000);
      }
    });
  });
}

function slugify(str, prefix) {
  const slug = String(str || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return slug || uid(prefix);
}

function renderPersonCards(kind) {
  const list = kind === 'users' ? users() : babies();
  const el = document.getElementById(kind === 'users' ? 'settings-users' : 'settings-babies');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<p class="log-empty" style="padding:20px 0">None yet.</p>';
    return;
  }
  list.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'med-card';
    card.innerHTML = `
      <div class="med-card-info">
        <div class="med-card-name">${escapeHtml(item.name)}</div>
      </div>
      <button class="med-card-edit-btn" data-kind="${kind}" data-id="${item.id}" title="Edit">✎</button>
      <button class="settings-delete-btn" data-kind="${kind}" data-id="${item.id}" title="Delete">×</button>
    `;
    el.appendChild(card);
  });

  el.querySelectorAll('.med-card-edit-btn').forEach((btn) =>
    btn.addEventListener('click', () => openPersonForm(btn.dataset.kind, btn.dataset.id)),
  );
  el.querySelectorAll('.settings-delete-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await mutateData((next) => {
        const item = next[btn.dataset.kind].find((record) => record.id === btn.dataset.id);
        if (item) {
          item.deletedAt = nowIso();
          item.updatedAt = item.deletedAt;
        }
      });
    }),
  );
}

function openPersonForm(kind, id = null) {
  _personEdit = { kind, id };
  const item = id ? data[kind].find((record) => record.id === id) : null;
  document.getElementById('person-form-title').textContent = id ? 'Edit' : kind === 'users' ? 'New parent' : 'New baby';
  document.getElementById('person-form-name').value = item?.name || '';
  document.getElementById('person-form').classList.remove('hidden');
  document.getElementById('person-form-name').focus();
}

function closePersonForm() {
  _personEdit = null;
  document.getElementById('person-form').classList.add('hidden');
}

async function savePersonForm() {
  const name = document.getElementById('person-form-name').value.trim();
  if (!name || !_personEdit) return;
  const stamp = nowIso();
  await mutateData((next) => {
    if (_personEdit.id) {
      const item = next[_personEdit.kind].find((record) => record.id === _personEdit.id);
      if (item) {
        item.name = name;
        item.updatedAt = stamp;
      }
    } else {
      next[_personEdit.kind].push({
        id: slugify(name, _personEdit.kind === 'users' ? 'user_' : 'baby_'),
        name,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      });
    }
  });
  closePersonForm();
  showSettingsConfirmation();
}

function renderMedCards() {
  const el = document.getElementById('settings-medications');
  el.innerHTML = '';
  const meds = medications();
  if (!meds.length) {
    el.innerHTML = '<p class="log-empty" style="padding:20px 0">No medications yet.</p>';
    return;
  }
  meds.forEach((med) => {
    const details = [
      med.unit,
      med.defaultAmount != null ? `${med.defaultAmount} fixed` : null,
      med.intervalHours != null ? `every ${med.intervalHours}h` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const card = document.createElement('div');
    card.className = 'med-card';
    card.innerHTML = `
      <div class="med-card-info">
        <div class="med-card-name">${escapeHtml(med.label)}</div>
        ${details ? `<div class="med-card-details">${escapeHtml(details)}</div>` : ''}
      </div>
      <button class="med-card-edit-btn" data-id="${med.id}" title="Edit">✎</button>
      <button class="settings-delete-btn" data-id="${med.id}" title="Delete">×</button>
    `;
    el.appendChild(card);
  });

  el.querySelectorAll('.med-card-edit-btn').forEach((btn) =>
    btn.addEventListener('click', () => openMedForm(btn.dataset.id)),
  );
  el.querySelectorAll('.settings-delete-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await mutateData((next) => {
        const med = next.medications.find((record) => record.id === btn.dataset.id);
        if (med) {
          med.deletedAt = nowIso();
          med.updatedAt = med.deletedAt;
        }
      });
    }),
  );
}

function renderSetupGuide() {
  const card = document.getElementById('settings-setup-card');
  const detail = document.getElementById('settings-setup-detail');
  if (!card || !detail) return;

  const missing = [];
  if (!users().length) missing.push('parent');
  if (!babies().length) missing.push('baby');

  card.classList.toggle('hidden', missing.length === 0);
  if (!missing.length) {
    detail.textContent = '';
  } else if (missing.length === 2) {
    detail.textContent = 'Add at least one parent and one baby before logging entries.';
  } else {
    detail.textContent = `Add at least one ${missing[0]} before logging entries.`;
  }
}

function openMedForm(id = null) {
  _medEditId = id;
  const med = id ? data.medications.find((record) => record.id === id) : null;
  document.getElementById('med-form-title').textContent = med ? 'Edit medication' : 'New medication';
  document.getElementById('med-form-label').value = med?.label || '';
  document.getElementById('med-form-unit').value = med?.unit || 'ml';
  document.getElementById('med-form-amount').value = med?.defaultAmount ?? '';
  document.getElementById('med-form-interval').value = med?.intervalHours ?? '';
  document.getElementById('med-form').classList.remove('hidden');
  document.getElementById('add-med-btn').classList.add('hidden');
  document.getElementById('med-form-label').focus();
}

function closeMedForm() {
  document.getElementById('med-form').classList.add('hidden');
  document.getElementById('add-med-btn').classList.remove('hidden');
  _medEditId = null;
}

async function saveMedForm() {
  const label = document.getElementById('med-form-label').value.trim();
  if (!label) {
    document.getElementById('med-form-label').focus();
    return;
  }
  const unit = document.getElementById('med-form-unit').value.trim() || 'ml';
  const amtRaw = document.getElementById('med-form-amount').value.trim();
  const intRaw = document.getElementById('med-form-interval').value.trim();
  const stamp = nowIso();

  await mutateData((next) => {
    const med = {
      id: _medEditId || slugify(label, 'med_'),
      label,
      unit,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
    };
    if (amtRaw !== '') med.defaultAmount = parseFloat(amtRaw);
    if (intRaw !== '') med.intervalHours = parseFloat(intRaw);

    if (_medEditId) {
      const idx = next.medications.findIndex((item) => item.id === _medEditId);
      if (idx >= 0) next.medications[idx] = { ...next.medications[idx], ...med, createdAt: next.medications[idx].createdAt };
    } else {
      next.medications.push(med);
    }
  });

  closeMedForm();
  showSettingsConfirmation();
}

function showSettingsConfirmation() {
  const conf = document.getElementById('settings-confirmation');
  conf.classList.remove('hidden');
  setTimeout(() => conf.classList.add('hidden'), 2000);
}

function renderSettings() {
  renderSetupGuide();
  renderPersonCards('users');
  renderPersonCards('babies');
  renderMedCards();
  updateSyncUi();
}

function dashDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + _dashOffset);
  return d;
}

function dashDayLabel(d) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((d.getTime() - todayStart) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderDashboard() {
  const day = dashDay();
  document.getElementById('dash-date-label').textContent = dashDayLabel(day);
  document.getElementById('dash-next').disabled = _dashOffset >= 0;

  const start = day.getTime();
  const end = start + 86400000;
  const totals = {};
  for (const e of entries()) {
    if (e.type !== 'milk') continue;
    const t = new Date(e.timestamp).getTime();
    if (t < start || t >= end) continue;
    totals[e.baby] = (totals[e.baby] || 0) + (parseFloat(e.amount) || 0);
  }

  const chart = document.getElementById('dash-milk-chart');
  const activeBabies = babies();
  if (!activeBabies.length) {
    chart.innerHTML = '<p class="log-empty" style="padding:40px 0">No babies configured.</p>';
    return;
  }

  chart.innerHTML = activeBabies
    .map((baby) => {
      const total = Math.round(totals[baby.id] || 0);
      return `
      <div class="dash-metric">
        <div class="dash-metric-name" style="color:${baby.colour}">${escapeHtml(baby.name)}</div>
        <div class="dash-metric-value">${total > 0 ? total : '—'}</div>
        <div class="dash-metric-unit">${total > 0 ? 'ml' : ''}</div>
      </div>`;
    })
    .join('');
}

function renderAll() {
  if (!data) return;
  renderUserButtons();
  renderBabyButtons();
  renderTypeButtons();
  renderMedButtons();
  renderLog();
  renderDashboard();
  renderSettings();
  updateUnitLabel();
  updateSaveBtn();
}

function setActiveTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  if (tabName === 'log') renderLog();
  if (tabName === 'settings') renderSettings();
  if (tabName === 'dashboard') renderDashboard();
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* fall through to the selection fallback */
    }
  }

  const activeEl = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand?.('copy') === true;
  } catch {
    copied = false;
  }

  textarea.remove();
  if (activeEl?.focus) activeEl.focus();
  return copied;
}

function wireSetup() {
  document.getElementById('generate-key-btn').addEventListener('click', async () => {
    _lastGeneratedKey = generateAccessKey();
    document.getElementById('access-key-input').value = _lastGeneratedKey;
    document.getElementById('copy-generated-key-btn').classList.remove('hidden');
    setSetupStatus('Key created. Copy it before adding another parent.');
  });

  document.getElementById('copy-generated-key-btn').addEventListener('click', async () => {
    const copied = await copyText(_lastGeneratedKey || document.getElementById('access-key-input').value);
    setSetupStatus(copied ? 'Copied.' : 'Select the key and copy it.');
  });

  document.getElementById('unlock-key-btn').addEventListener('click', () => {
    unlockWithAccessKey(document.getElementById('access-key-input').value).catch((error) => {
      setSetupStatus(error.message || 'Could not unlock.', true);
    });
  });
}

function wireApp() {
  document.getElementById('amount-input').addEventListener('input', (e) => {
    let val = e.target.value.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
    e.target.value = val;
    formState.amount = val;
    updateSaveBtn();
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    if (!document.getElementById('save-btn').disabled) saveEntry();
  });
  document.getElementById('clear-btn').addEventListener('click', clearForm);

  document.getElementById('timestamp-toggle').addEventListener('click', () => {
    const input = document.getElementById('timestamp-input');
    const toggle = document.getElementById('timestamp-toggle');
    const isHidden = input.classList.toggle('hidden');
    toggle.classList.toggle('active', !isHidden);
    if (!isHidden && !input.value) {
      const now = new Date();
      now.setSeconds(0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      input.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
  });

  document.getElementById('add-med-btn').addEventListener('click', () => openMedForm(null));
  document.getElementById('med-form-cancel').addEventListener('click', closeMedForm);
  document.getElementById('med-form-save').addEventListener('click', saveMedForm);
  document.getElementById('person-form-cancel').addEventListener('click', closePersonForm);
  document.getElementById('person-form-save').addEventListener('click', savePersonForm);
  document.querySelectorAll('[data-add-list]').forEach((btn) =>
    btn.addEventListener('click', () => openPersonForm(btn.dataset.addList)),
  );

  document.getElementById('dash-prev').addEventListener('click', () => {
    _dashOffset--;
    renderDashboard();
  });
  document.getElementById('dash-next').addEventListener('click', () => {
    if (_dashOffset < 0) {
      _dashOffset++;
      renderDashboard();
    }
  });

  document.getElementById('sync-now-btn').addEventListener('click', () => {
    syncNow({ quiet: false, force: true }).catch(() => {});
  });

  document.getElementById('copy-access-key-btn').addEventListener('click', async () => {
    const copied = await copyText(session?.accessKey || '');
    setSyncStatus('Encrypted sync', copied ? 'Access key copied' : 'Access key is not stored on this device');
    setTimeout(updateSyncUi, 1800);
  });

  const forgetBtn = document.getElementById('forget-key-btn');
  forgetBtn.addEventListener('click', async () => {
    if (forgetBtn.dataset.confirming) {
      delete forgetBtn.dataset.confirming;
      forgetBtn.textContent = 'Forget';
      session = {};
      await kvDelete(SESSION_KEY);
      showSetup();
    } else {
      forgetBtn.dataset.confirming = 'true';
      forgetBtn.textContent = 'Confirm?';
      setTimeout(() => {
        if (forgetBtn.dataset.confirming) {
          delete forgetBtn.dataset.confirming;
          forgetBtn.textContent = 'Forget';
        }
      }, 3000);
    }
  });

  window.addEventListener('online', () => {
    setOffline(false);
    syncNow({ quiet: true }).catch(() => {});
  });
  window.addEventListener('offline', () => setOffline(true));

  setInterval(() => {
    updateSyncUi();
    if (navigator.onLine) syncNow({ quiet: true }).catch(() => {});
  }, 15000);
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch {
      /* ignore */
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await registerServiceWorker();
  wireSetup();
  wireApp();
  await loadSession();

  if (session?.familyId && session?.accessKey) {
    await loadData();
    document.getElementById('remember-key-input').checked = session.rememberKey !== false;
    showApp();
    syncNow({ quiet: true }).catch(() => {});
  } else {
    showSetup();
    if (session?.familyId) setSetupStatus('Enter the family access key.');
  }
});
