# bblog

bblog is a private baby log for families. Parents and carers can record feeds, nappies, medication, weights, and notes from their phones, then view the shared history and simple trends in one place. Each family deploys its own bblog instance and controls one encrypted family vault with a shared access key.

[![Deploy with Vercel](https://vercel.com/button)][deploy-vercel]
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)][deploy-cloudflare]

## What is encrypted

Entries, parents, babies, and medications are encrypted in the browser with AES-GCM before they are uploaded. The browser sends only a key-derived vault id, an encrypted payload, and normal storage metadata. The deployment also uses `BBLOG_FAMILY_ACCESS_KEY` server-side to make sure this instance accepts only one family vault, so deploy it to a Vercel account you control.

The access key is the family credential. Every parent who enters the same access key opens the same encrypted vault. A deployed instance accepts only the family key configured in its environment, so people who want their own family vault should deploy their own instance.

## First use

The app ships without any parents, babies, medications, or example entries. On a new deployed instance, set `BBLOG_FAMILY_ACCESS_KEY` during deployment, then join with that same key in the app and add your own parents and babies in Settings before logging entries. Medications are optional and can be added only when needed.

## Run locally

```bash
npm run dev
```

Open `http://localhost:4173`. Local development stores encrypted cloud vault files in `.local/vaults`, so you can test sync without a Vercel account.

When shipping UI or service worker updates, bump PWA caches:

```bash
npm run bump:caches
```

This increments `CACHE_NAME` in `public/sw.js` and refreshes cache-bust query tokens in `public/sw.js` and `public/index.html`.

To create Web Push keys for closed-PWA medication reminders:

```bash
npm run notifications:keys
```

Add the generated `BBLOG_VAPID_PUBLIC_KEY`, `BBLOG_VAPID_PRIVATE_KEY`, and `BBLOG_VAPID_SUBJECT` values to the deployed environment.

## Deploy on Vercel

Use the deploy button above, or set it up manually:

1. Choose a long family access key. Use at least 18 letters or numbers after spaces and punctuation are removed.
2. Push this folder to GitHub, either as the repo root or as a subdirectory project.
3. Import the project in Vercel.
4. Add `BBLOG_FAMILY_ACCESS_KEY` as a Vercel environment variable.
5. For medication reminders while an installed PWA is closed, add the generated `BBLOG_VAPID_PUBLIC_KEY`, `BBLOG_VAPID_PRIVATE_KEY`, and `BBLOG_VAPID_SUBJECT` environment variables and connect Vercel Blob storage.
6. Deploy.

The app targets Node.js 24 or newer through `package.json`. A fresh Vercel import will not accept joins until `BBLOG_FAMILY_ACCESS_KEY` is set.

Vercel Blob storage is optional for a single-device vault and required for family sharing across devices. Vercel provides `BLOB_READ_WRITE_TOKEN` to the `/api/vault` function after the store is connected. Without it, the deployment accepts only the configured family key but stores the encrypted vault in that browser profile.

The sync API uses Vercel Blob private storage through `@vercel/blob`. The API is intentionally small, so another host can replace `api/vault.js` with S3, R2, Supabase Storage, or another object store as long as it preserves the same `GET` and `PUT` JSON contract.

To check whether a deployed instance can share data between devices, open `/api/vault?status=1` on that deployment. It should return `"instanceKeyConfigured":true` and `"syncConfigured":true`. If it returns `"mode":"setup-required"`, set `BBLOG_FAMILY_ACCESS_KEY`. If it returns `"mode":"local-only"`, the app can be used on one device, and Vercel Blob should be connected before inviting family members.

## Deploy on Cloudflare

Use the Cloudflare deploy button above, or deploy manually with Wrangler:

```bash
npx wrangler r2 bucket create bblog
npx wrangler deploy
```

After the Worker is created, add `BBLOG_FAMILY_ACCESS_KEY` as a Worker secret or environment variable in Cloudflare, then redeploy. If you want to use a different R2 bucket name, update `bucket_name` in `wrangler.jsonc`; keep the binding name as `BBLOG_BUCKET`.

Cloudflare deployments serve the static app from `public/` and use the Worker in `worker/index.js` for `/api/vault`. The Cloudflare deployment stores encrypted vault snapshots in R2 under the same `bblog/v1/vaults/...` object keys as the Vercel Blob deployment, so the same encrypted vault export can be migrated between providers.

To check whether a Cloudflare deployment can share data between devices, open `/api/vault?status=1` on that deployment. It should return `"storage":"cloudflare-r2"` and `"syncConfigured":true`.

Closed-app Web Push medication reminders are currently Vercel-only. Cloudflare deployments still show in-app medication reminders while bblog is open.

To migrate an existing Vercel vault export into Cloudflare R2, prepare the object files locally:

```bash
node scripts/prepare-r2-import.mjs bblog-vault-export.json
```

The script writes files under `.local/r2-import/` and prints the `npx wrangler r2 object put ...` commands to upload them.

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

## Medication reminders

Assign medications to babies in Settings and set a repeat interval to show due-soon and overdue alerts on the dashboard. Medications become due soon when 3 hours remain before they are overdue. With notifications enabled, bblog sends one due-soon notification at that time, combining medications that become due together.

While bblog is open, reminders run locally. When deployed with Vercel Blob, VAPID keys, and the included `/api/notifications` cron, installed PWAs can also receive a generic Web Push notification while closed, including on iOS. The server stores push subscriptions, wake-up times, and hashed reminder ids only; baby names, medication names, doses, and due times remain in the encrypted device vault.

[deploy-vercel]: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjames-lane%2Fbblog&project-name=bblog&repository-name=bblog&env=BBLOG_FAMILY_ACCESS_KEY&envDescription=Required%3A+choose+a+long+family+access+key+for+this+one-vault+bblog+instance.+Add+Vercel+Blob+after+deploy+only+if+you+want+family+sharing+across+devices.&envLink=https%3A%2F%2Fgithub.com%2Fjames-lane%2Fbblog%23deploy-on-vercel
[deploy-cloudflare]: https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fjames-lane%2Fbblog
