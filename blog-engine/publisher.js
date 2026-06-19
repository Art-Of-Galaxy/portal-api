// Publishes a single tbl_blog_articles row to Shopify via the Admin
// GraphQL API. Called by the scheduler (auto) and by the "Publish now"
// endpoint (manual).

const { poll } = require('../config/dbconfig');
const shopifyService = require('../shopify-connections/service');
const adminApi = require('../shopify-connections/admin_api');

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
// pointing at the Shopify-hosted URL. We could let Shopify fetch the
// fal.ai/S3 URL directly via Article.image.url, but mirroring to
// Shopify Files makes the URL permanent and avoids upstream CDN flakes.
async function uploadFeaturedToShopify({ conn, featured, title }) {
  if (!featured?.url) return null;
  try {
    const result = await adminApi.uploadImageToShopifyFiles({
      shop: conn.shop_domain,
      accessToken: conn.access_token,
      sourceUrl: featured.url,
      filename: `featured-${Date.now()}.png`,
    });
    return result?.url || featured.url;
  } catch (err) {
    console.warn('[blog-engine] uploadImageToShopifyFiles failed, falling back to source URL:', err.message || err);
    return featured.url;
  }
}

// Decide which blog to publish into:
//   1. spec_json.target_blog_id (per-article override the user picked)
//   2. autopilot.blog_id (when this article came from an autopilot)
//   3. connection.default_blog_id (chosen at connect time)
async function resolveBlogId(article, conn) {
  if (article.spec_json?.target_blog_id) return { id: article.spec_json.target_blog_id, title: article.spec_json.target_blog_title || null };
  if (article.autopilot_id) {
    const rows = await poll.query(
      `SELECT blog_id, blog_title FROM tbl_blog_autopilots WHERE id = $1 LIMIT 1`,
      [article.autopilot_id]
    );
    const r = (rows || [])[0];
    if (r?.blog_id) return { id: r.blog_id, title: r.blog_title || null };
  }
  if (conn?.default_blog_id) return { id: conn.default_blog_id, title: conn.default_blog_title || null };
  // Last resort: pick the first blog on the shop.
  try {
    const blogs = await adminApi.listBlogs({ shop: conn.shop_domain, accessToken: conn.access_token });
    return blogs[0] ? { id: blogs[0].id, title: blogs[0].title } : null;
  } catch {
    return null;
  }
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
  const bodyHtml = article.assets_json?.body_html || '';

  let featuredUrl = null;
  if (featured?.url) {
    featuredUrl = await uploadFeaturedToShopify({ conn, featured, title: article.title });
  }

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
      authorName: 'Editorial',
      publishedAt: publishImmediately ? new Date().toISOString() : null,
      imageUrl: featuredUrl,
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
