# bblog

An offline-first mobile web version of bblog. It keeps the original tabbed iOS-style UI, stores the working copy in IndexedDB, caches the app shell with a service worker, and syncs one encrypted family vault through a tiny serverless API.

## What is encrypted

Entries, parents, babies, and medications are encrypted in the browser with AES-GCM before they are uploaded. The shared family access key never leaves the browser. The cloud API only sees a key-derived vault id, an encrypted payload, and normal storage metadata.

The access key is the family credential. Every parent who enters the same access key opens the same encrypted vault.

## First use

The app ships without any parents, babies, medications, or example entries. On a new instance, create a family access key, then add your own parents and babies in Settings before logging entries. Medications are optional and can be added only when needed.

## Run locally

```bash
npm run dev
```

Open `http://localhost:4173`. Local development stores encrypted cloud vault files in `.local/vaults`, so you can test sync without a Vercel account.

## Deploy on Vercel

1. Push this folder to GitHub, either as the repo root or as a subdirectory project.
2. Import the project in Vercel.
3. Deploy.

The app targets Node.js 24 or newer through `package.json`. A fresh Vercel import serves the app immediately; if no Vercel Blob store is connected, bblog runs in local-only mode using the browser's encrypted IndexedDB storage.

For encrypted multi-device sync, add Vercel Blob storage to the project. Vercel provides `BLOB_READ_WRITE_TOKEN` to the `/api/vault` function after the store is connected.

The sync API uses Vercel Blob private storage through `@vercel/blob`. The API is intentionally small, so another host can replace `api/vault.js` with S3, R2, Supabase Storage, or another object store as long as it preserves the same `GET` and `PUT` JSON contract.

To check whether a deployed instance can share data between devices, open `/api/vault?status=1` on that deployment. It should return `"syncConfigured":true`. If it returns `"mode":"local-only"`, the app will run on each device but same-key users will not share data until Vercel Blob is connected.

## API contract

`GET /api/vault?familyId=<hex>` returns:

```json
{ "exists": true, "etag": "\"...\"", "vault": { "version": 1 } }
```

or:

```json
{ "exists": false }
```

`PUT /api/vault` accepts:

```json
{
  "familyId": "<hex>",
  "baseEtag": "\"...\"",
  "vault": { "version": 1 }
}
```

It returns `409` when another device has written a newer vault. The client handles that by downloading, decrypting, merging records, and retrying.

## Offline behavior

The UI writes to an encrypted IndexedDB vault immediately. When the network is unavailable, the user can keep adding and editing entries. On reconnect, the client downloads the encrypted cloud vault, decrypts it locally, merges record-level changes, re-encrypts the merged vault, and uploads it.

If "Remember on this device" is enabled, the access key is stored in the browser profile so the app can reopen offline. Use the device passcode and browser profile protections for local device security.
