// Publishes a single tbl_blog_articles row to Shopify via the Admin
// GraphQL API. Called by the scheduler (auto) and by the "Publish now"
// endpoint (manual).

const { poll } = require('../config/dbconfig');
const shopifyService = require('../shopify-connections/service');
const adminApi = require('../shopify-connections/admin_api');
const blogService = require('./service');

async function loadArticle(id) {
  const rows = await poll.query(
    `SELECT id, user_email, shop_connection_id, autopilot_id, mode, keyword,
            brief_json, spec_json, assets_json, title, handle, meta_title,
            meta_description, tags, status, scheduled_for
       FROM tbl_blog_articles WHERE id = $1 LIMIT 1`,
    [id]
  );
  return (rows || [])[0] || null;
}

async function markStatus(id, status, extra = {}) {
  const fields = ['status = $2', 'updated_at = NOW()'];
  const params = [id, status];
  if (status === 'published') {
    fields.push('published_at = NOW()');
  }
  if (extra.shopify_article_id !== undefined) {
    params.push(extra.shopify_article_id);
    fields.push(`shopify_article_id = $${params.length}`);
  }
  if (extra.shopify_blog_id !== undefined) {
    params.push(extra.shopify_blog_id);
    fields.push(`shopify_blog_id = $${params.length}`);
  }
  if (extra.shopify_url !== undefined) {
    params.push(extra.shopify_url);
    fields.push(`shopify_url = $${params.length}`);
  }
  if (extra.error_code !== undefined) {
    params.push(extra.error_code);
    fields.push(`error_code = $${params.length}`);
  }
  if (extra.error_message !== undefined) {
    params.push(extra.error_message);
    fields.push(`error_message = $${params.length}`);
  }
  await poll.query(`UPDATE tbl_blog_articles SET ${fields.join(', ')} WHERE id = $1`, params);
}

// Push featured image to Shopify Files first, then create the article
// pointing at the Shopify-hosted URL. We do NOT fall back to the raw
// fal.ai URL: those are signed/expiring, and Shopify's articleCreate
// rejects unreachable URLs with "Image upload failed. Invalid URL".
// Better to publish image-less than to fail the whole publish.
async function uploadFeaturedToShopify({ conn, featured }) {
  if (!featured?.url) return null;
  try {
    const result = await adminApi.uploadImageToShopifyFiles({
      shop: conn.shop_domain,
      accessToken: conn.access_token,
      sourceUrl: featured.url,
      filename: `featured-${Date.now()}.png`,
    });
    if (result?.url) return result.url;
    console.warn('[blog-engine] Shopify Files upload returned no URL; publishing without featured image. source:', featured.url);
    return null;
  } catch (err) {
    console.warn('[blog-engine] uploadImageToShopifyFiles failed; publishing without featured image. source:', featured.url, 'reason:', err.message || err);
    return null;
  }
}

// Decide which blog to publish into:
//   1. spec_json.target_blog_id (per-article override the user picked)
//   2. autopilot.blog_id (when this article came from an autopilot)
//   3. connection.default_blog_id (chosen at connect time)
//
// We need the handle (for the article's public URL inside schema), but
// the user-saved/autopilot rows only store id + title. Look up handle
// via listBlogs when we don't already have it. Cheap GraphQL.
async function resolveBlogId(article, conn) {
  let target = null;
  if (article.spec_json?.target_blog_id) target = { id: article.spec_json.target_blog_id, title: article.spec_json.target_blog_title || null, handle: null };
  if (!target && article.autopilot_id) {
    const rows = await poll.query(
      `SELECT blog_id, blog_title FROM tbl_blog_autopilots WHERE id = $1 LIMIT 1`,
      [article.autopilot_id]
    );
    const r = (rows || [])[0];
    if (r?.blog_id) target = { id: r.blog_id, title: r.blog_title || null, handle: null };
  }
  if (!target && conn?.default_blog_id) {
    target = { id: conn.default_blog_id, title: conn.default_blog_title || null, handle: null };
  }
  // Look up the handle from Shopify if missing.
  try {
    const blogs = await adminApi.listBlogs({ shop: conn.shop_domain, accessToken: conn.access_token });
    if (!target) return blogs[0] ? { id: blogs[0].id, title: blogs[0].title, handle: blogs[0].handle } : null;
    const match = blogs.find((b) => String(b.id) === String(target.id));
    if (match) target.handle = match.handle;
  } catch {
    // Non-fatal: schema URLs will fall back to "news" as the blog handle.
  }
  return target;
}

async function publishArticle({ articleId, publishImmediately = true }) {
  const article = await loadArticle(articleId);
  if (!article) throw Object.assign(new Error(`Article ${articleId} not found`), { status: 404 });

  const conn = await shopifyService.getConnectionWithToken({
    userEmail: article.user_email,
    connectionId: article.shop_connection_id,
  });
  if (!conn) {
    await markStatus(articleId, 'failed', { error_code: 'no_connection', error_message: 'No active Shopify connection' });
    throw new Error('No active Shopify connection');
  }

  const blog = await resolveBlogId(article, conn);
  if (!blog?.id) {
    await markStatus(articleId, 'failed', { error_code: 'no_blog', error_message: 'No target blog found' });
    throw new Error('No target blog found on the connected store');
  }

  const spec = article.spec_json || {};
  const featured = article.assets_json?.featured || null;
  // We always recompose at publish so JSON-LD has the real shop URLs +
  // article handle baked in. Generation-time body_html had FAQ schema
  // only; this pass adds BlogPosting + Breadcrumb + Organization.
  const customInlineImageUrl = article.brief_json?.inline_image_url || null;

  let featuredUrl = null;
  if (featured?.url) {
    featuredUrl = await uploadFeaturedToShopify({ conn, featured });
  }
  const publishedIso = publishImmediately ? new Date().toISOString() : (article.scheduled_for?.toISOString?.() || new Date().toISOString());
  const handleForUrl = article.handle || spec.handle || '';
  const blogHandleForUrl = blog.handle || (blog.title || 'news').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const shopContext = {
    shopDomain: conn.shop_domain,
    primaryDomain: conn.meta?.primary_domain || conn.shop_domain,
    shopName: conn.shop_name || conn.shop_domain,
    blogHandle: blogHandleForUrl,
    blogTitle: blog.title || null,
    articleUrl: `https://${conn.meta?.primary_domain || conn.shop_domain}/blogs/${blogHandleForUrl}/${handleForUrl}`,
    logoUrl: conn.meta?.logo_url || null,
  };
  const bodyHtml = blogService.composeBodyHtml({
    spec,
    customImageUrl: customInlineImageUrl,
    shopContext,
    featuredUrl,
    publishedIso,
  });

  console.log('[blog-engine] publish ready', {
    articleId,
    shop: conn.shop_domain,
    blogId: blog.id,
    title: article.title,
    featuredUrl: featuredUrl || '(none)',
  });

  try {
    const result = await adminApi.createArticle({
      shop: conn.shop_domain,
      accessToken: conn.access_token,
      blogId: blog.id,
      title: article.title || spec.title,
      bodyHtml,
      handle: article.handle || spec.handle,
      summary: article.meta_description || spec.meta_description,
      tags: typeof article.tags === 'string' && article.tags
        ? article.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : (Array.isArray(spec.tags) ? spec.tags : []),
      authorName: spec.author_name || 'Editorial',
      publishedAt: publishImmediately ? new Date().toISOString() : null,
      imageUrl: featuredUrl,
      imageAlt: spec.hero_alt || spec.title || article.title || '',
      metaTitle: article.meta_title || spec.meta_title,
      metaDescription: article.meta_description || spec.meta_description,
    });

    await markStatus(articleId, publishImmediately ? 'published' : 'draft', {
      shopify_article_id: String(result.id || ''),
      shopify_blog_id: String(blog.id),
      shopify_url: result.url || null,
      error_code: null,
      error_message: null,
    });

    return { ok: true, shopify_article_id: result.id, url: result.url };
  } catch (err) {
    const code = err.shopify ? 'shopify_error' : 'publish_failed';
    const message = err.message || 'publish failed';
    console.error('[blog-engine] publish error:', err.shopify || message);
    await markStatus(articleId, 'failed', { error_code: code, error_message: message.slice(0, 1000) });
    throw err;
  }
}

module.exports = { publishArticle };
