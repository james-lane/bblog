import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_OUTPUT_DIR = '.local/r2-import';
const DEFAULT_BUCKET_NAME = 'bblog-vault';
const VAULT_PATH_RE = /^bblog\/v1\/vaults\/[a-f0-9]{32,64}(?:\/devices\/[a-z0-9_-]{8,96})?\.json$/;

function usage() {
  console.error(
    'Usage: node scripts/prepare-r2-import.mjs <bblog-vault-export.json> [output-dir] [bucket-name]',
  );
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeExport(value) {
  if (Array.isArray(value?.vaults) && value.vaults.length) {
    return value.vaults
      .map((item) => ({
        pathname: item?.pathname,
        vault: item?.vault,
      }))
      .filter((item) => item.pathname && item.vault);
  }

  if (value?.vault?.familyId) {
    return [
      {
        pathname: `bblog/v1/vaults/${value.vault.familyId}.json`,
        vault: value.vault,
      },
    ];
  }

  return [];
}

const inputPath = process.argv[2];
const outputDir = resolve(process.argv[3] || DEFAULT_OUTPUT_DIR);
const bucketName = process.argv[4] || DEFAULT_BUCKET_NAME;

if (!inputPath) {
  usage();
  process.exit(1);
}

const input = JSON.parse(await readFile(inputPath, 'utf8'));
const objects = normalizeExport(input);

if (!objects.length) {
  console.error('No vault objects found in export.');
  process.exit(1);
}

for (const object of objects) {
  if (!VAULT_PATH_RE.test(object.pathname)) {
    console.error(`Refusing unexpected object path: ${object.pathname}`);
    process.exit(1);
  }
}

const seen = new Set();
const written = [];
for (const object of objects) {
  if (seen.has(object.pathname)) continue;
  seen.add(object.pathname);

  const filePath = join(outputDir, object.pathname);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(object.vault), 'utf8');
  written.push({ pathname: object.pathname, filePath });
}

console.log(`Prepared ${written.length} R2 object file(s) in ${outputDir}`);
console.log('');
console.log('Upload with:');
for (const item of written) {
  console.log(
    `npx wrangler r2 object put ${shellQuote(`${bucketName}/${item.pathname}`)} --file ${shellQuote(item.filePath)}`,
  );
}
