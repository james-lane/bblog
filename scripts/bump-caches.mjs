import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SW_PATH = path.join(ROOT, 'public', 'sw.js');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const APP_PATH = path.join(ROOT, 'public', 'app.js');
const DRY_RUN = process.argv.includes('--dry-run');

const CACHE_NAME_REGEX = /const CACHE_NAME = 'bblog-v(\d+)';/;
const APP_VERSION_REGEX = /const APP_VERSION = 'bblog-v(\d+)';/;
const VERSIONED_ASSETS = [
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon.svg',
];

function versionTokenFromDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function bumpCacheName(source) {
  const match = source.match(CACHE_NAME_REGEX);
  if (!match) {
    throw new Error('Could not find CACHE_NAME in public/sw.js');
  }

  const current = Number.parseInt(match[1], 10);
  if (!Number.isFinite(current)) {
    throw new Error(`Invalid cache version in public/sw.js: ${match[1]}`);
  }

  const next = current + 1;
  return {
    source: source.replace(
      CACHE_NAME_REGEX,
      `const CACHE_NAME = 'bblog-v${next}';`,
    ),
    previous: current,
    next,
  };
}

function bumpAssetTokens(source, token) {
  let nextSource = source;

  VERSIONED_ASSETS.forEach((assetPath) => {
    const escaped = assetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(${escaped}\\?v=)[^'\"\\s)]+`, 'g');
    nextSource = nextSource.replace(pattern, `$1${token}`);
  });

  return nextSource;
}

function updateAppVersion(source, version) {
  if (!APP_VERSION_REGEX.test(source)) {
    throw new Error('Could not find APP_VERSION in public/app.js');
  }
  return source.replace(
    APP_VERSION_REGEX,
    `const APP_VERSION = 'bblog-v${version}';`,
  );
}

function assertChanged(before, after, filePath) {
  if (before === after) {
    throw new Error(`No cache token changes applied in ${filePath}`);
  }
}

async function run() {
  const token = versionTokenFromDate();

  const swInitial = await readFile(SW_PATH, 'utf8');
  const indexInitial = await readFile(INDEX_PATH, 'utf8');
  const appInitial = await readFile(APP_PATH, 'utf8');

  const bumped = bumpCacheName(swInitial);
  const swUpdated = bumpAssetTokens(bumped.source, token);
  const indexUpdated = bumpAssetTokens(indexInitial, token);
  const appUpdated = updateAppVersion(appInitial, bumped.next);

  assertChanged(swInitial, swUpdated, SW_PATH);
  assertChanged(indexInitial, indexUpdated, INDEX_PATH);
  assertChanged(appInitial, appUpdated, APP_PATH);

  if (!DRY_RUN) {
    await writeFile(SW_PATH, swUpdated, 'utf8');
    await writeFile(INDEX_PATH, indexUpdated, 'utf8');
    await writeFile(APP_PATH, appUpdated, 'utf8');
  }

  const mode = DRY_RUN ? 'Dry run only' : 'Updated';
  console.log(`${mode} cache values.`);
  console.log(`CACHE_NAME: bblog-v${bumped.previous} -> bblog-v${bumped.next}`);
  console.log(`Asset cache-bust token: ${token}`);
  console.log(`Files: public/sw.js, public/index.html, public/app.js`);
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
