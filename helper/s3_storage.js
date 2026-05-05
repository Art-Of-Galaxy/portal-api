// AWS S3 storage helper. The whole portal funnels file persistence through
// these functions so the storage backend can be swapped (or disabled for
// local dev) in one place.
//
// Required env vars:
//   AWS_REGION              e.g. us-east-1
//   AWS_S3_BUCKET           or legacy AWS_BUCKETNAME
//   AWS_ACCESS_KEY_ID
//   AWS_SECRET_ACCESS_KEY
//
// The bucket must be configured for public read access on the keys this
// helper writes (we store public URLs in tbl_files.url so the frontend can
// render them with a plain <img src>). The simplest setup is a bucket policy:
//
// {
//   "Version": "2012-10-17",
//   "Statement": [{
//     "Sid": "PublicReadAOG",
//     "Effect": "Allow",
//     "Principal": "*",
//     "Action": "s3:GetObject",
//     "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
//   }]
// }
//
// Plus a CORS configuration so the frontend's blob-download flow works:
//
// [{
//   "AllowedHeaders": ["*"],
//   "AllowedMethods": ["GET", "HEAD"],
//   "AllowedOrigins": ["*"],
//   "MaxAgeSeconds": 3000
// }]

const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');

let cachedClient = null;
let cachedConfig = null;

function readConfig() {
  if (cachedConfig !== null) return cachedConfig;
  const bucket = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKETNAME || '';
  const region = process.env.AWS_REGION || '';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    cachedConfig = { configured: false };
    return cachedConfig;
  }

  cachedConfig = {
    configured: true,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
  };
  return cachedConfig;
}

function isConfigured() {
  return readConfig().configured;
}

function getClient() {
  if (cachedClient) return cachedClient;
  const cfg = readConfig();
  if (!cfg.configured) return null;
  cachedClient = new S3Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  return cachedClient;
}

function getBucket() {
  return readConfig().bucket || null;
}

function publicUrl(key) {
  const cfg = readConfig();
  if (!cfg.configured) return null;
  // Path-style URL works for any bucket name; virtual-hosted style is also
  // valid but breaks for buckets with dots in the name.
  const safeKey = String(key).split('/').map(encodeURIComponent).join('/');
  return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${safeKey}`;
}

function safeExt(value) {
  const ext = path.extname(String(value || '')).toLowerCase();
  if (!ext || ext.length > 8) return '';
  return ext;
}

function extFromContentType(contentType) {
  if (!contentType) return '';
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
  };
  const m = contentType.split(';')[0].trim().toLowerCase();
  if (map[m]) return map[m];
  // Fallback: take whatever's after the slash, strip "+xml" / "+json" etc.
  if (m.includes('/')) {
    const tail = m.split('/')[1].split('+')[0].replace(/[^a-z0-9]/g, '');
    if (tail && tail.length <= 6) return `.${tail === 'jpeg' ? 'jpg' : tail}`;
  }
  return '';
}

// Map an extension (with or without leading dot) to a content type.
// Used as the authoritative source so we never store octet-stream when we
// know the file is, e.g., an SVG.
const CONTENT_TYPE_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
};

function contentTypeFromExt(ext) {
  if (!ext) return '';
  const clean = String(ext).toLowerCase().replace(/^\./, '');
  return CONTENT_TYPE_BY_EXT[clean] || '';
}

function contentTypeFromKey(key) {
  return contentTypeFromExt(safeExt(key));
}

function contentTypeFromUrl(url) {
  if (!url) return '';
  try {
    const path = new URL(url).pathname;
    return contentTypeFromExt(safeExt(path));
  } catch {
    return '';
  }
}

// Treat these as "unknown" and prefer extension-based inference instead.
function isGenericContentType(contentType) {
  if (!contentType) return true;
  const m = contentType.split(';')[0].trim().toLowerCase();
  return m === 'application/octet-stream' || m === 'binary/octet-stream' || m === '';
}

/**
 * Build a unique S3 key with a sensible prefix and extension.
 *   prefix: 'uploads' | 'generated/logo' | etc.
 *   originalName: e.g. 'product-shot.png' (used only for the extension)
 *   contentType: fallback for the extension if originalName has none
 */
function keyForUpload({ prefix = 'uploads', originalName = '', contentType = '' } = {}) {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const ext = safeExt(originalName) || extFromContentType(contentType) || '';
  const cleanPrefix = String(prefix).replace(/^\/+|\/+$/g, '');
  return `${cleanPrefix}/${stamp}-${rand}${ext}`;
}

async function uploadBuffer({
  key,
  body,
  contentType,
  cacheControl = 'public, max-age=31536000, immutable',
  contentDisposition = 'inline',
}) {
  const client = getClient();
  const bucket = getBucket();
  if (!client || !bucket) throw new Error('S3 is not configured');

  // Pick the most reliable Content-Type:
  //   1. Whatever the key's extension says (authoritative — we control the key)
  //   2. The provided contentType (if it isn't generic)
  //   3. Fall back to octet-stream
  // This avoids storing octet-stream for SVGs / PNGs / etc. when the upstream
  // forgot to send a Content-Type, which causes browsers to download files
  // instead of rendering them.
  const fromKey = contentTypeFromKey(key);
  let finalContentType = fromKey || (isGenericContentType(contentType) ? '' : contentType);
  if (!finalContentType) finalContentType = 'application/octet-stream';

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: finalContentType,
      ContentDisposition: contentDisposition,
      CacheControl: cacheControl,
    })
  );

  return publicUrl(key);
}

/**
 * Stream-download an external URL (e.g. fal.ai's temp CDN URL) and re-upload
 * it to S3. Used to make AI-generated assets persistent.
 *
 * Resolves the Content-Type in this priority:
 *   1. The originalName extension (passed by caller)
 *   2. The source URL path extension
 *   3. The Content-Type the upstream actually returned
 *   4. octet-stream (worst case — browsers will download instead of render)
 *
 * fal.ai's CDN occasionally serves SVG without a Content-Type header, so we
 * can't trust the response header on its own.
 */
async function uploadFromUrl(sourceUrl, { prefix = 'generated', originalName = '' } = {}) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${sourceUrl} (HTTP ${response.status})`);
  }
  const upstreamContentType = response.headers.get('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const inferredContentType =
    contentTypeFromExt(safeExt(originalName)) ||
    contentTypeFromUrl(sourceUrl) ||
    (isGenericContentType(upstreamContentType) ? '' : upstreamContentType);

  const key = keyForUpload({
    prefix,
    originalName,
    contentType: inferredContentType,
  });

  const url = await uploadBuffer({
    key,
    body: buffer,
    contentType: inferredContentType,
  });

  return {
    key,
    url,
    contentType: inferredContentType || 'application/octet-stream',
    sizeBytes: buffer.length,
  };
}

/**
 * Re-set Content-Type and Content-Disposition on every object under a prefix
 * (or the whole bucket if prefix is empty). Used as a one-shot migration to
 * fix files that were uploaded before the Content-Type detection was correct.
 *
 * Returns { scanned, updated, skipped, errors }.
 */
async function repairContentTypes({ prefix = '', dryRun = false, limit = 5000 } = {}) {
  const client = getClient();
  const bucket = getBucket();
  if (!client || !bucket) throw new Error('S3 is not configured');

  let continuationToken = undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      })
    );

    const objects = list.Contents || [];
    for (const obj of objects) {
      if (scanned >= limit) break;
      scanned += 1;
      const key = obj.Key;
      const desired = contentTypeFromKey(key);
      if (!desired) {
        skipped += 1;
        continue;
      }
      try {
        if (!dryRun) {
          // Copy in place to overwrite metadata. Note: we always set
          // ContentDisposition: inline so previously-attachment uploads
          // also start rendering correctly.
          await client.send(
            new CopyObjectCommand({
              Bucket: bucket,
              Key: key,
              CopySource: `/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
              ContentType: desired,
              ContentDisposition: 'inline',
              CacheControl: 'public, max-age=31536000, immutable',
              MetadataDirective: 'REPLACE',
            })
          );
        }
        updated += 1;
      } catch (err) {
        errors.push({ key, message: err.message || String(err) });
      }
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken && scanned < limit);

  return { scanned, updated, skipped, errors };
}

module.exports = {
  isConfigured,
  getClient,
  getBucket,
  publicUrl,
  keyForUpload,
  uploadBuffer,
  uploadFromUrl,
  repairContentTypes,
  extFromContentType,
  contentTypeFromExt,
  contentTypeFromKey,
};
