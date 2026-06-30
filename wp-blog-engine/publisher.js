// Publishes a single tbl_wp_articles row to a WordPress site via the
// REST API. Called by the scheduler (auto) and by the manual "Publish
// now" endpoint.
//
// The article spec + composed body HTML come from blog-engine/service
// (the same generator that powers the Shopify side). Only the destination
// API differs.

const { poll } = require('../config/dbconfig');
const wpConnService = require('../wordpress-connections/service');
const wpApi = require('../wordpress-connections/wp_api');
const blogService = require('../blog-engine/service');

async function loadArticle(id) {
  const rows = await poll.query(
    `SELECT id, user_email, wp_connection_id, autopilot_id, mode, keyword,
            brief_json, spec_json, assets_json, title, handle, meta_title,
            meta_description, tags, status, scheduled_for
       FROM tbl_wp_articles WHERE id = $1 LIMIT 1`,
    [id]
  );
  return (rows || [])[0] || null;
}

async function markStatus(id, status, extra = {}) {
  const fields = ['status = $2::varchar', 'updated_at = NOW()'];
  const params = [id, status];
  if (status === 'published') {
    fields.push('published_at = NOW()');
  }
  if (extra.wp_post_id !== undefined)   { params.push(extra.wp_post_id);   fields.push(`wp_post_id   = $${params.length}`); }
  if (extra.wp_post_url !== undefined)  { params.push(extra.wp_post_url);  fields.push(`wp_post_url  = $${params.length}`); }
  if (extra.error_code !== undefined)   { params.push(extra.error_code);   fields.push(`error_code   = $${params.length}`); }
  if (extra.error_message !== undefined){ params.push(extra.error_message);fields.push(`error_message= $${params.length}`); }
  await poll.query(`UPDATE tbl_wp_articles SET ${fields.join(', ')} WHERE id = $1`, params);
}

// Decide which category to file the post under:
//   1. spec.target_category_id (per-article override the user picked)
//   2. autopilot.category_id   (when this article came from an autopilot)
//   3. connection.default_category_id
//   4. none (WP defaults to Uncategorized)
async function resolveCategoryId(article, conn) {
  if (article.spec_json?.target_category_id) return Number(article.spec_json.target_category_id);
  if (article.autopilot_id) {
    const rows = await poll.query(
      `SELECT category_id FROM tbl_wp_autopilots WHERE id = $1 LIMIT 1`,
      [article.autopilot_id]
    );
    const r = (rows || [])[0];
    if (r?.category_id) return Number(r.category_id);
  }
  if (conn?.default_category_id) return Number(conn.default_category_id);
  return null;
}

async function publishArticle({ articleId, publishImmediately = true }) {
  const article = await loadArticle(articleId);
  if (!article) throw Object.assign(new Error(`WP article ${articleId} not found`), { status: 404 });

  const conn = await wpConnService.getConnectionWithToken({
    userEmail: article.user_email,
    connectionId: article.wp_connection_id,
  });
  if (!conn) {
    await markStatus(articleId, 'failed', { error_code: 'no_connection', error_message: 'No active WordPress connection' });
    throw new Error('No active WordPress connection');
  }

  const spec = article.spec_json || {};
  const featured = article.assets_json?.featured || null;

  // 1. Upload featured image to WP media library if we have one.
  let featuredMediaId = null;
  let featuredUrl = null;
  if (featured?.url) {
    try {
      const media = await wpApi.uploadMediaFromUrl({
        siteUrl: conn.site_url,
        username: conn.username,
        appPassword: conn.app_password,
        sourceUrl: featured.url,
        filename: `${(article.handle || spec.handle || 'featured').slice(0, 60)}.png`,
        altText: spec.hero_alt || spec.title || article.title || '',
      });
      featuredMediaId = media?.id || null;
      featuredUrl = media?.url || null;
    } catch (err) {
      console.warn('[wp-blog-engine] featured media upload failed, publishing without:', err.message || err);
    }
  }

  // 2. Resolve category + tags.
  const categoryId = await resolveCategoryId(article, conn);
  const tagsArr = typeof article.tags === 'string' && article.tags
    ? article.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : (Array.isArray(spec.tags) ? spec.tags : []);
  let tagIds = [];
  if (tagsArr.length) {
    try {
      tagIds = await wpApi.resolveTagIds({
        siteUrl: conn.site_url,
        username: conn.username,
        appPassword: conn.app_password,
        tags: tagsArr,
      });
    } catch (err) {
      console.warn('[wp-blog-engine] tag resolve failed, publishing without tags:', err.message || err);
    }
  }

  // 3. Recompose body with shop-equivalent context so BlogPosting +
  // Breadcrumb + Organization schema have the right WP URLs baked in.
  const publishedIso = publishImmediately
    ? new Date().toISOString()
    : (article.scheduled_for?.toISOString?.() || new Date().toISOString());
  const siteHost = (() => { try { return new URL(conn.site_url).host; } catch { return conn.site_url; } })();
  const shopContext = {
    shopDomain: siteHost,
    primaryDomain: siteHost,
    shopName: conn.site_name || siteHost,
    blogHandle: 'blog',
    blogTitle: 'Blog',
    articleUrl: `${conn.site_url}/${article.handle || spec.handle || ''}`,
    logoUrl: conn.site_info?.logo_url || null,
  };
  const bodyHtml = blogService.composeBodyHtml({
    spec,
    customImageUrl: article.brief_json?.inline_image_url || null,
    shopContext,
    featuredUrl: featuredUrl || featured?.url || null,
    publishedIso,
  });

  // 4. Build SEO plugin meta. We set both Yoast and RankMath keys;
  // whichever plugin is installed picks them up, the other ignores.
  const seoMeta = {
    _yoast_wpseo_title:    article.meta_title    || spec.meta_title    || article.title,
    _yoast_wpseo_metadesc: article.meta_description || spec.meta_description || '',
    rank_math_title:       article.meta_title    || spec.meta_title    || article.title,
    rank_math_description: article.meta_description || spec.meta_description || '',
  };

  // 5. Decide status. publishImmediately => 'publish'. With a future
  // scheduled_for => 'future' and pass the date so WP's own cron picks
  // it up too (belt + suspenders alongside our cron).
  let wpStatus = 'publish';
  let wpDate;
  if (!publishImmediately && article.scheduled_for) {
    wpStatus = 'future';
    wpDate = article.scheduled_for.toISOString();
  }

  console.log('[wp-blog-engine] publish ready', {
    articleId,
    site: conn.site_url,
    title: article.title,
    featuredMediaId: featuredMediaId || '(none)',
    categoryId,
    tagCount: tagIds.length,
    wpStatus,
  });

  try {
    const result = await wpApi.createPost({
      siteUrl: conn.site_url,
      username: conn.username,
      appPassword: conn.app_password,
      title: article.title || spec.title,
      content: bodyHtml,
      excerpt: article.meta_description || spec.meta_description || '',
      slug: article.handle || spec.handle,
      status: wpStatus,
      date: wpDate,
      featuredMediaId: featuredMediaId || undefined,
      categories: categoryId ? [categoryId] : undefined,
      tagIds,
      meta: seoMeta,
    });

    await markStatus(articleId, publishImmediately ? 'published' : 'draft', {
      wp_post_id: String(result.id || ''),
      wp_post_url: result.url || null,
      error_code: null,
      error_message: null,
    });

    return { ok: true, wp_post_id: result.id, url: result.url };
  } catch (err) {
    const code = err.wp ? 'wp_error' : 'publish_failed';
    const message = err.message || 'publish failed';
    console.error('[wp-blog-engine] publish error:', err.wp || message);
    await markStatus(articleId, 'failed', { error_code: code, error_message: message.slice(0, 1000) });
    throw err;
  }
}

module.exports = { publishArticle };
