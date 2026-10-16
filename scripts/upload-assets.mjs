// Uploads packages/editor/public/ (all maps + prop libraries + the
// editor-*.json registries, ~220 MB) into the R2 bucket the worker serves at
// /assets/*. Same flat-lowercase layout and keys as the game's tree (uploaded
// by packages/server/scripts/upload-assets.mjs), so overlapping objects are
// byte-identical and skipped by the md5 check — each object lives once. Idempotent BY CONSTRUCTION, which is the
// "resumable upload" PLAN §2.5 asks for: every run lists the bucket first and
// skips objects whose size+md5 already match, so a crashed run just continues.
//
// Content-Type is set per extension AT UPLOAD TIME and matters twice:
//  - the worker serves it back verbatim;
//  - Cloudflare's edge compresses ONLY compressible types, which is exactly
//    the "compress text, never binaries" rule the loading bar depends on.
//
// Credentials (R2's S3 API):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  [, R2_BUCKET]
//
// Local workerd testing needs no credentials: pass --local and the script
// shells out to `wrangler r2 object put --local` instead.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(here, '..', 'public');
const BUCKET = process.env.R2_BUCKET ?? 'skilltanki-assets';
const LOCAL = process.argv.includes('--local');
/** --local only: limit to the first N files (smoke-testing the pipeline). */
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg != null ? Number(limitArg.split('=')[1]) : Infinity;

const TYPES = {
  json: 'application/json',
  xml: 'application/xml',
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  '3ds': 'application/octet-stream',
};
const typeOf = (key) => TYPES[key.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

const files = [];
for (const full of walk(publicRoot)) {
  files.push({ full, key: relative(publicRoot, full).split(/[\\/]/).join('/') });
  if (files.length >= LIMIT) {
    break;
  }
}
console.log(`${files.length} files under ${publicRoot}`);

if (LOCAL) {
  // workerd's local R2 state lives with the SERVER package (its wrangler
  // config owns the binding) — run wrangler THERE, or the objects land in a
  // .wrangler dir nobody reads.
  const serverDir = join(here, '..', '..', 'server');
  for (const { full, key } of files) {
    execFileSync(
      'npx',
      ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', full,
       '--content-type', typeOf(key), '--local'],
      { cwd: serverDir, stdio: 'ignore' },
    );
    console.log('local put', key);
  }
  console.log('done (local)');
  process.exit(0);
}

const { S3Client, ListObjectsV2Command, PutObjectCommand } = await import('@aws-sdk/client-s3');
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (or use --local).');
  process.exit(1);
}
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

// Existing objects: a single-part upload's ETag is the body's md5, so
// size+md5 equality is an honest "already uploaded" check.
const existing = new Map();
let token;
do {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
  for (const obj of page.Contents ?? []) {
    existing.set(obj.Key, { size: obj.Size, etag: (obj.ETag ?? '').replaceAll('"', '') });
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);
console.log(`${existing.size} objects already in ${BUCKET}`);

let uploaded = 0;
let skipped = 0;
const queue = [...files];
const worker = async () => {
  for (;;) {
    const item = queue.shift();
    if (item == null) {
      return;
    }
    const body = readFileSync(item.full);
    const md5 = createHash('md5').update(body).digest('hex');
    const have = existing.get(item.key);
    if (have != null && have.size === body.length && have.etag === md5) {
      skipped += 1;
      continue;
    }
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: item.key,
      Body: body,
      ContentType: typeOf(item.key),
    }));
    uploaded += 1;
    if (uploaded % 50 === 0) {
      console.log(`uploaded ${uploaded}…`);
    }
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`done: ${uploaded} uploaded, ${skipped} already current`);
