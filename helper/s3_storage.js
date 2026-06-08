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
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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

// Returns a snapshot of the current storage setup so callers / health
// endpoints can show the operator whether uploads are going to S3 or
// falling back to local disk, and exactly which env vars are missing.
function describeStorage() {
  const bucket = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKETNAME || '';
  const region = process.env.AWS_REGION || '';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  const missing = [];
  if (!bucket) missing.push('AWS_S3_BUCKET (or AWS_BUCKETNAME)');
  if (!region) missing.push('AWS_REGION');
  if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
  return {
    storage: missing.length ? 'disk' : 's3',
    bucket: bucket || null,
    region: region || null,
    missing_env: missing,
  };
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
//
// Adding a format here makes it round-trip correctly through upload (multer-s3
// reads this map to set the S3 Content-Type) and through display (the browser
// renders inline because the type is correct).
const CONTENT_TYPE_BY_EXT = {
  // Images
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  jpe:  'image/jpeg',
  webp: 'image/webp',
  gif:  'image/gif',
  svg:  'image/svg+xml',
  bmp:  'image/bmp',
  tif:  'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  ico:  'image/x-icon',
  // Design source files (stored as binary; browser will offer download)
  psd:  'image/vnd.adobe.photoshop',
  ai:   'application/postscript',
  eps:  'application/postscript',
  // Documents
  pdf:  'application/pdf',
  // Video (a few common ones — handy for AI-video service later)
  mp4:  'video/mp4',
  mov:  'video/quicktime',
  webm: 'video/webm',
  // Audio
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  // Misc
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  json: 'application/json',
  txt:  'text/plain; charset=utf-8',
  csv:  'text/csv',
  zip:  'application/zip',
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
 * Generate a short-lived presigned URL the browser can PUT a file to
 * directly. Used to bypass the serverless function body size limit on
 * Vercel (~4.5 MB) — large files like PSDs, hi-res photos and PDFs
 * would otherwise fail with "Failed to fetch" before they ever reach
 * the API.
 *
 * Resolves to:
 *   { upload_url, key, public_url, content_type, expires_in }
 *
 * The frontend PUTs the file with the SAME Content-Type header we
 * pre-baked into the signed request. After a successful PUT it should
 * call /api/files/confirm-upload to record metadata in tbl_files.
 */
async function createPresignedUploadUrl({
  prefix = 'uploads',
  originalName = '',
  contentType = '',
  expiresIn = 600, // 10 minutes
} = {}) {
  const client = getClient();
  const bucket = getBucket();
  if (!client || !bucket) throw new Error('S3 is not configured');

  const inferredContentType =
    contentTypeFromExt(safeExt(originalName)) ||
    (isGenericContentType(contentType) ? '' : contentType) ||
    'application/octet-stream';

  const key = keyForUpload({
    prefix,
    originalName,
    contentType: inferredContentType,
  });

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: inferredContentType,
    ContentDisposition: 'inline',
    CacheControl: 'public, max-age=31536000, immutable',
  });

  const upload_url = await getSignedUrl(client, command, { expiresIn });

  return {
    upload_url,
    key,
    public_url: publicUrl(key),
    content_type: inferredContentType,
    expires_in: expiresIn,
  };
}

// Reverse of publicUrl(): given a public S3 URL we generated, extract the
// object key. Returns null for any other URL (so callers can fall back to
// the original URL untouched, e.g. for legacy /uploads/ paths).
function keyFromPublicUrl(url) {
  const cfg = readConfig();
  if (!cfg.configured || !url) return null;
  const prefix = `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/`;
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const remainder = url.slice(prefix.length).split('?')[0].split('#')[0];
  // The key was URL-encoded segment-by-segment in publicUrl(); reverse it.
  return remainder.split('/').map(decodeURIComponent).join('/');
}

/**
 * Build a short-lived presigned GET URL that forces a download with a
 * proper filename. The browser can navigate to this URL directly — no
 * fetch / blob / CORS dance required.
 *
 * If the URL isn't an S3 URL we generated (e.g. fal.ai's CDN, or a legacy
 * /uploads/ path), we return null so the caller can fall back to the
 * original URL.
 */
async function createPresignedDownloadUrl({ url, filename, expiresIn = 600 } = {}) {
  const client = getClient();
  const bucket = getBucket();
  if (!client || !bucket) return null;

  const key = keyFromPublicUrl(url);
  if (!key) return null;

  const safeFilename = String(filename || key.split('/').pop() || 'download')
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 200);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
  });
  return getSignedUrl(client, command, { expiresIn });
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
  describeStorage,
  getClient,
  getBucket,
  publicUrl,
  keyForUpload,
  uploadBuffer,
  uploadFromUrl,
  createPresignedUploadUrl,
  createPresignedDownloadUrl,
  keyFromPublicUrl,
  repairContentTypes,
  extFromContentType,
  contentTypeFromExt,
  contentTypeFromKey,
  SUPPORTED_EXTENSIONS: Object.keys(CONTENT_TYPE_BY_EXT),
};
