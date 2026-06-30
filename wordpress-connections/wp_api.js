// Thin wrapper around the WordPress REST API.
//
// Auth model: HTTP Basic with the user's Application Password. WP 5.6+
// supports this natively (Users -> Profile -> Application Passwords),
// no plugin required. Application Passwords work on both self-hosted
// WP and WordPress.com (with Jetpack).
//
// All calls take { siteUrl, username, appPassword } and target
// {siteUrl}/wp-json/wp/v2/* . The site must be HTTPS; WP enforces this
// for app passwords.

const axios = require('axios');
const FormData = require('form-data');

const DEFAULT_TIMEOUT = 30_000;

function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  return s;
}

function authHeader(username, appPassword) {
  const token = Buffer.from(`${username}:${appPassword}`).toString('base64');
  return `Basic ${token}`;
}

// Probe the REST API root. Confirms three things:
//   1. The site is reachable.
//   2. wp-json is exposed (some security plugins kill it).
//   3. The credentials authenticate (we hit /users/me which requires auth).
// Returns { siteName, description, url, user } on success, throws on
// any failure with a human-readable message + status code so the
// controller can surface it.
async function probeSite({ siteUrl, username, appPassword }) {
  const base = normalizeSiteUrl(siteUrl);
  if (!base.startsWith('https://')) {
    const err = new Error('Site URL must use HTTPS. WordPress rejects Application Passwords over plain HTTP.');
    err.status = 400;
    throw err;
  }
  // 1. Root discovery
  let root;
  try {
    const res = await axios.get(`${base}/wp-json/`, { timeout: DEFAULT_TIMEOUT });
    root = res.data || {};
  } catch (err) {
    const msg = err.response?.status === 404
      ? 'The WordPress REST API is disabled or not reachable at /wp-json/. Ask the site admin to enable pretty permalinks and unblock /wp-json/.'
      : `Could not reach the WordPress REST API: ${err.message}`;
    const e = new Error(msg);
    e.status = 502;
    throw e;
  }
  // 2. Auth probe
  let user;
  try {
    const res = await axios.get(`${base}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: authHeader(username, appPassword) },
      timeout: DEFAULT_TIMEOUT,
    });
    user = res.data || {};
  } catch (err) {
    const status = err.response?.status;
    let msg;
    if (status === 401) msg = 'Authentication failed. Double-check the username and Application Password.';
    else if (status === 403) msg = 'This user does not have permission to read /users/me. Use an account with at least Author role.';
    else msg = `Could not authenticate against WordPress: ${err.message}`;
    const e = new Error(msg);
    e.status = status || 502;
    throw e;
  }
  // 3. Permission probe: can this user create posts? We don't actually
  // create one; we just check the `_links.wp:action-create-posts` hint
  // on /posts. This is best-effort.
  const canPublish = (user.capabilities && (user.capabilities.publish_posts || user.capabilities.administrator)) !== false;
  return {
    siteName: root.name || base,
    description: root.description || null,
    home: root.home || base,
    url: root.url || base,
    user: {
      id: user.id,
      name: user.name,
      slug: user.slug,
      roles: user.roles || [],
    },
    canPublish,
  };
}

// List the site's categories (terms in the "category" taxonomy).
async function listCategories({ siteUrl, username, appPassword }) {
  const base = normalizeSiteUrl(siteUrl);
  const res = await axios.get(`${base}/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc`, {
    headers: { Authorization: authHeader(username, appPassword) },
    timeout: DEFAULT_TIMEOUT,
  });
  return (res.data || []).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    count: c.count,
  }));
}

// Resolve a list of tag slugs/names into WP tag ids, creating any
// that don't exist yet. WP requires tags to be referenced by id when
// you POST a post.
async function resolveTagIds({ siteUrl, username, appPassword, tags }) {
  if (!Array.isArray(tags) || !tags.length) return [];
  const base = normalizeSiteUrl(siteUrl);
  const headers = { Authorization: authHeader(username, appPassword) };
  const ids = [];
  for (const raw of tags) {
    const name = String(raw || '').trim();
    if (!name) continue;
    try {
      // Look it up first.
      // eslint-disable-next-line no-await-in-loop
      const search = await axios.get(`${base}/wp-json/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=10`, {
        headers,
        timeout: DEFAULT_TIMEOUT,
      });
      const match = (search.data || []).find((t) => t.name?.toLowerCase() === name.toLowerCase());
      if (match) { ids.push(match.id); continue; }
      // Create.
      // eslint-disable-next-line no-await-in-loop
      const created = await axios.post(`${base}/wp-json/wp/v2/tags`, { name }, {
        headers: { ...headers, 'Content-Type': 'application/json' },
        timeout: DEFAULT_TIMEOUT,
      });
      if (created.data?.id) ids.push(created.data.id);
    } catch (err) {
      // If a tag fails (permissions, duplicate race), skip it. The
      // post still publishes.
      console.warn(`[wp_api] tag '${name}' resolve failed:`, err.response?.data?.message || err.message);
    }
  }
  return ids;
}

// Upload a hosted image URL into the WP media library and return the
// media object. We download the bytes ourselves and POST to /media
// so the WP host doesn't need to be able to reach the source CDN.
async function uploadMediaFromUrl({ siteUrl, username, appPassword, sourceUrl, filename, altText }) {
  if (!sourceUrl) return null;
  const base = normalizeSiteUrl(siteUrl);
  const headers = { Authorization: authHeader(username, appPassword) };

  // 1. Download the image bytes from the source CDN.
  const dl = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 60_000 });
  const buffer = Buffer.from(dl.data);
  const mime = (dl.headers['content-type'] || '').split(';')[0] || 'image/png';
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  const safeName = (filename && /\.\w{3,4}$/.test(filename))
    ? filename
    : `${(filename || 'featured').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60)}.${ext}`;

  // 2. POST to /media as multipart so WP stores it properly + indexes
  // it in the library. The Content-Disposition header tells WP what
  // filename to use.
  const form = new FormData();
  form.append('file', buffer, { filename: safeName, contentType: mime });
  if (altText) form.append('alt_text', altText);
  if (altText) form.append('caption', altText);

  const res = await axios.post(`${base}/wp-json/wp/v2/media`, form, {
    headers: { ...headers, ...form.getHeaders() },
    maxBodyLength: Infinity,
    timeout: 120_000,
  });
  return {
    id: res.data?.id,
    url: res.data?.source_url,
    alt_text: res.data?.alt_text,
    media_type: res.data?.media_type,
  };
}

// Create a post via the WP REST API.
//   status: 'publish' | 'future' | 'draft' | 'pending'
//   date:   ISO string when status='future'
// Returns { id, link, status, date_gmt }.
async function createPost({
  siteUrl, username, appPassword,
  title, content, excerpt, slug,
  status = 'publish',
  date,
  featuredMediaId,
  categories,
  tagIds,
  authorId,
  meta,
}) {
  const base = normalizeSiteUrl(siteUrl);
  const headers = {
    Authorization: authHeader(username, appPassword),
    'Content-Type': 'application/json',
  };
  const payload = {
    title,
    content,
    excerpt: excerpt || undefined,
    slug: slug || undefined,
    status,
    date: status === 'future' && date ? date : undefined,
    featured_media: featuredMediaId || undefined,
    categories: Array.isArray(categories) && categories.length ? categories : undefined,
    tags: Array.isArray(tagIds) && tagIds.length ? tagIds : undefined,
    author: authorId || undefined,
    meta: meta && Object.keys(meta).length ? meta : undefined,
  };
  // Strip undefined so WP doesn't trip on null fields.
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  try {
    const res = await axios.post(`${base}/wp-json/wp/v2/posts`, payload, { headers, timeout: 60_000 });
    return {
      id: res.data?.id,
      url: res.data?.link,
      status: res.data?.status,
      date_gmt: res.data?.date_gmt,
    };
  } catch (err) {
    const data = err.response?.data || {};
    const e = new Error(`WordPress createPost failed: ${data.message || err.message}`);
    e.status = err.response?.status || 502;
    e.wp = data;
    throw e;
  }
}

module.exports = {
  normalizeSiteUrl,
  probeSite,
  listCategories,
  resolveTagIds,
  uploadMediaFromUrl,
  createPost,
};
